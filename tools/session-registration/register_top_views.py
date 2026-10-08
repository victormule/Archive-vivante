"""Calcule la correction d'une session par recalage de vues de dessus de la table.

Entrées : les deux rendus de render_top_views.mjs (même caméra), les assets
générés des deux sessions. Sortie : la nouvelle `world_transform` de la
session, à coller dans pipeline/sessions.json (ou --write pour l'y écrire).

    python register_top_views.py --reference j1-s1 --session j1-s2 \\
        --center=-0.62,-0.71,-4.2 --dir ./out [--write]

Méthode :
1. carte de « table » : luminosité des pixels neutres (gris → sombre,
   blanc → clair) — la ligne de séparation gris/blanc et les bords dominent ;
2. zone de comparaison : projection du plateau de la session de référence
   (nuage LiDAR, segmentation gris/blanc) ;
3. similitude 2D (rotation, échelle, translation) maximisant la corrélation ;
4. conversion en transformation 3D (rotation verticale, échelle uniforme
   autour du centre de la table), puis alignement des hauteurs de plateau
   mesurées sur les splats.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.optimize import minimize

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from archive_pipeline import alignment as al  # noqa: E402
from archive_pipeline.ply import read_ply_vertices  # noqa: E402
from archive_pipeline.point_cloud import read_points_bin, read_points_bin_colors  # noqa: E402

SESSIONS = ROOT / "web" / "public" / "sessions"
W, H = 1200, 900
SH_C0 = 0.28209479177387814


def load_png(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 3).astype(float) / 255


def tableness(img: np.ndarray) -> np.ndarray:
    mx, mn = img.max(2), img.min(2)
    sat = (mx - mn) / np.maximum(mx, 1e-6)
    return ndimage.gaussian_filter(np.where((sat < 0.22) & (mx > 0.45), mx, 0.0), 1.5)


def manifest(sid: str) -> dict:
    return json.loads((SESSIONS / sid / "manifest.json").read_text(encoding="utf-8"))


def world(sid: str) -> np.ndarray:
    return np.asarray(manifest(sid).get("worldTransform") or np.eye(4).T.reshape(-1), float).reshape(4, 4).T


def splat_table_height(sid: str, transform: np.ndarray, bounds: tuple[np.ndarray, np.ndarray], hint: float) -> float:
    v = read_ply_vertices(SESSIONS / sid / "splat.ply")
    keep = 1 / (1 + np.exp(-v["opacity"])) > 0.3
    p = al.apply(transform, np.stack([v["x"], v["y"], v["z"]], 1)[keep].astype(float))
    rgb = (np.clip(0.5 + SH_C0 * np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1)[keep], 0, 1) * 255).astype(np.uint8)
    lo, hi = bounds
    inside = (p[:, 0] > lo[0]) & (p[:, 0] < hi[0]) & (p[:, 2] > lo[2]) & (p[:, 2] < hi[2])
    return al.segment_table_top(p[inside], rgb[inside], hint, search=0.15, thickness=0.04)[2]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reference", required=True)
    ap.add_argument("--session", required=True)
    ap.add_argument("--center", required=True, help="x,y,z du centre de vue (y = hauteur approximative du plateau)")
    ap.add_argument("--height", type=float, default=11.0)
    ap.add_argument("--fov", type=float, default=30.0)
    ap.add_argument("--dir", type=Path, default=Path("out"))
    ap.add_argument("--write", action="store_true", help="écrire le résultat dans pipeline/sessions.json")
    args = ap.parse_args()

    cam = np.array([float(v) for v in args.center.split(",")])
    ppm = (H / 2) / (args.height * math.tan(math.radians(args.fov / 2)))  # pixels par mètre à hauteur de table

    # Plateau de référence (nuage LiDAR) -> zone de comparaison
    ref_layer = manifest(args.reference)["layers"]["pointCloud"]
    ref_pts = al.apply(world(args.reference), read_points_bin(SESSIONS / args.reference / "points.bin", ref_layer))
    ref_rgb = read_points_bin_colors(SESSIONS / args.reference / "points.bin", ref_layer)
    table, _, _ = al.segment_table_top(ref_pts, ref_rgb, cam[1])
    u = 600 + (table[:, 0] - cam[0]) * ppm
    v = 450 + (table[:, 2] - cam[2]) * ppm
    ok = (u >= 0) & (u < W) & (v >= 0) & (v < H)
    zone = np.zeros((H, W), bool)
    zone[v[ok].astype(int), u[ok].astype(int)] = True
    zone = ndimage.binary_closing(zone, iterations=4)
    mask = ndimage.binary_dilation(zone, iterations=20)
    ys, xs = np.nonzero(zone)
    center = np.array([xs.mean(), ys.mean()])

    t_ref = tableness(load_png(args.dir / "reference.png"))
    t_ses = tableness(load_png(args.dir / "session.png"))

    def warp(img, theta, scale, tx, ty):
        c, s = math.cos(theta), math.sin(theta)
        m = np.linalg.inv(scale * np.array([[c, -s], [s, c]]))[::-1, ::-1]
        cc = center[::-1]
        return ndimage.affine_transform(img, m, offset=cc - m @ (cc + np.array([ty, tx])), order=1)

    def score(p):
        a, b = t_ref[mask], warp(t_ses, *p)[mask]
        a, b = a - a.mean(), b - b.mean()
        return float((a * b).sum() / math.sqrt((a * a).sum() * (b * b).sum() + 1e-9))

    fref = np.fft.fft2(np.where(mask, t_ref - t_ref[mask].mean(), 0.0))
    best = (-1.0, (0.0, 1.0, 0.0, 0.0))
    for theta in np.radians(np.arange(-10, 10.01, 1.0)):
        for scale in np.arange(0.86, 1.141, 0.02):
            w = warp(t_ses, theta, scale, 0, 0)
            corr = np.fft.ifft2(fref * np.conj(np.fft.fft2(w - w.mean()))).real
            dy, dx = np.unravel_index(np.argmax(corr), corr.shape)
            dy, dx = (dy - H if dy > H // 2 else dy), (dx - W if dx > W // 2 else dx)
            for sx, sy in ((dx, dy), (-dx, -dy)):
                if max(abs(sx), abs(sy)) <= 250 and (sc := score((theta, scale, float(sx), float(sy)))) > best[0]:
                    best = (sc, (theta, scale, float(sx), float(sy)))
    x0, steps = np.array(best[1]), np.array([math.radians(0.5), 0.01, 3.0, 3.0])
    res = minimize(lambda p: -score(tuple(p)), x0, method="Nelder-Mead",
                   options={"initial_simplex": np.vstack([x0] + [x0 + np.eye(4)[i] * steps[i] for i in range(4)]),
                            "xatol": 1e-3, "fatol": 1e-6, "maxiter": 800})
    theta, scale, tx, ty = res.x
    print(f"corrélation table {score((0, 1, 0, 0)):.3f} -> {-res.fun:.3f} | rotation {math.degrees(theta):.2f}° | "
          f"échelle {scale:.4f} | translation ({tx / ppm:.3f}, {ty / ppm:.3f}) m")

    # Similitude 2D (u ~ x, v ~ z) -> 3D, échelle uniforme autour du centre de la table
    cw = np.array([cam[0] + (center[0] - 600) / ppm, cam[1], cam[2] + (center[1] - 450) / ppm])
    c, s = math.cos(theta), math.sin(theta)
    lin = scale * np.array([[c, 0, -s], [0, 1, 0], [s, 0, c]])
    corr = np.eye(4)
    corr[:3, :3] = lin
    corr[:3, 3] = cw + np.array([tx / ppm, 0, ty / ppm]) - lin @ cw
    new = corr @ world(args.session)

    # Hauteurs de plateau sur les splats (ce que l'on voit)
    bounds = (table.min(0), table.max(0))
    h_ref = splat_table_height(args.reference, world(args.reference), bounds, cam[1])
    h_ses = splat_table_height(args.session, new, bounds, cam[1])
    new[1, 3] -= h_ses - h_ref
    print(f"plateau (splats) : référence {h_ref:.3f} m, session {h_ses:.3f} m -> corrigé")

    matrix = [round(float(x), 7) for x in new.T.reshape(-1)]
    print(json.dumps({"matrix": matrix}))
    if args.write:
        catalog_path = ROOT / "pipeline" / "sessions.json"
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        entry = next(e for e in catalog["sessions"] if e["id"] == args.session)
        entry["world_transform"] = {"$comment": "Calibré sur la table (tools/session-registration).", "matrix": matrix}
        catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("sessions.json mis à jour ; relancer : build_sessions.py", args.session, "--only registration")
    return 0


if __name__ == "__main__":
    sys.exit(main())
