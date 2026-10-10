"""Construction d'un Event : plusieurs exports réunis en une seule scène.

Un Event conclut les sessions : plusieurs captures (splat, photogrammétrie,
LiDAR) couvrent chacune une zone d'un même lieu, et plusieurs vidéos tournées
à la suite forment une seule bande son et un seul trajet caméra.

Repère de l'Event : le repère ARKit commun à toutes ses sessions. dür.air les a
relocalisées sur une même carte (ARWorldMap) : leurs nuages LiDAR et leurs
trajectoires vidéo y sont déjà exprimés. Chaque splat (repère de sa
photogrammétrie, décalé de ~2° / 25 cm) y est replacé par ICP de son nuage
LiDAR sur sa propre photogrammétrie.

Sorties (web/public/sessions/<id>/) :
    splat-<n>.spz   un splat par capture, placé par la matrice `transform` du manifest
                    (le fichier n'est pas réécrit : ses harmoniques sphériques devraient tourner)
    mesh.glb        toutes les photogrammétries, déjà dans le repère de l'Event
    points.bin      tous les nuages LiDAR fusionnés, voxelisés
    audio.m4a       les bandes son des vidéos mises bout à bout (AAC mono)
    camera_path.json  un seul trajet, lissé

Les nuages LiDAR (ASCII, jusqu'à 1 Go) sont lus par blocs et voxelisés au fil
de l'eau ; le résultat est mis en cache (pipeline/.cache/).
"""

from __future__ import annotations

import hashlib
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

from . import alignment
from .builder import IDENTITY, read_manifest, write_json
from .camera_path import build_camera_path, rotation_to_quaternion
from .export_reader import SessionExport, resolve_path
from .gltf import MeshPart, write_glb_parts
from .media import encode_jpeg, require_ffmpeg, require_tool, transcode_spz
from .obj import read_mtl_diffuse_map, read_obj
from .ply import CACHE_DIR, iter_ply_vertices, xyz
from .point_cloud import PointCloud, voxel_downsample, write_points_bin

EVENT_STEPS = ("parts", "pointCloud", "playback")

# Voxelisation des nuages LiDAR à la lecture (m), avant fusion. Les sommets LiDAR sont environ deux fois
# plus denses que cette grille : un sur LIDAR_STRIDE suffit (la conversion du texte domine le temps de lecture)
BASE_VOXEL = 0.025
LIDAR_STRIDE = 2
# Le nuage fusionné est revoxelisé (pas croissants) jusqu'à tenir sous ce nombre de points
DEFAULT_MAX_POINTS = 2_000_000
VOXEL_STEPS = (0.025, 0.03, 0.035, 0.04, 0.05, 0.06, 0.08)
# Points accumulés avant une compaction (mémoire bornée)
COMPACT_ABOVE = 6_000_000

# Recalage rigide : quelques dizaines de milliers de points suffisent (machine modeste, nuages étendus)
ICP_SOURCE_POINTS = 30_000
ICP_TARGET_POINTS = 200_000
ICP_ITERATIONS = 30
# Marge (m) autour de la photogrammétrie pour retenir le LiDAR qui lui correspond
ICP_CROP_MARGIN = 1.0

# Trajet : ré-échantillonnage, lissage gaussien et fréquence des keyframes publiées
PATH_RATE = 10
DEFAULT_PATH_SMOOTHING = 2.0
PATH_OUTPUT_RATE = 4
# Lissage complémentaire appliqué par le viewer (s) : arrondit l'interpolation entre keyframes
VIEWER_SMOOTHING = 0.25
AUDIO_BITRATE = "64k"


def _parse_ts(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def _rounded(matrix: np.ndarray, digits: int = 7) -> list[float]:
    """Matrice 4x4 -> liste column-major arrondie (convention des manifests)."""
    return [round(float(v), digits) for v in matrix.T.reshape(-1)]


@dataclass
class EventBuilder:
    entry: dict[str, Any]
    out: Path
    project_root: Path
    log: Any = print
    manifest: dict[str, Any] = field(default_factory=dict)

    def build(self, only: set[str] | None = None) -> dict[str, Any]:
        self.out.mkdir(parents=True, exist_ok=True)
        e = self.entry
        previous = read_manifest(self.out) if only and (self.out / "manifest.json").exists() else {}
        exports = [self._open(p["export_dir"]) for p in e["parts"]]
        video_export = self._open(e["playback"]["export_dir"]) if e.get("playback") else None
        self.manifest = {
            "id": e["id"],
            "kind": "event",
            "title": e["title"],
            "day": e["day"],
            "index": e["index"],
            "sessionId": video_export.session_id if video_export else exports[0].session_id,
            "startDate": min(x.session["startDate"] for x in exports),
            "endDate": max(x.session["endDate"] for x in [*exports, *([video_export] if video_export else [])]),
            "author": exports[0].project.get("author"),
            "layers": {"splat": None, "mesh": None, "pointCloud": None},
            "annotations": None,
            "alignment": {"reference": "arkit-worldmap"},
            # L'Event a son propre lieu : il n'est pas calé sur la table des sessions
            "worldTransform": IDENTITY,
            "playback": None,
        }
        for key in ("layers", "alignment", "playback", "bounds", "startDate", "endDate"):
            if key in previous:
                self.manifest[key] = previous[key]

        steps = set(EVENT_STEPS) if not only else set(only)
        if "parts" in steps:
            self.build_parts(exports)
        if "pointCloud" in steps:
            self.build_point_cloud(exports)
        if "playback" in steps and video_export is not None:
            self.build_playback(video_export)
        self._apply_view()
        write_json(self.out / "manifest.json", self.manifest)
        return self.manifest

    def _open(self, export_dir: str) -> SessionExport:
        return SessionExport.open(resolve_path(self.project_root, export_dir))

    # --- Captures : splats et photogrammétries ------------------------------

    def build_parts(self, exports: list[SessionExport]) -> None:
        splats: list[dict[str, Any]] = []
        meshes: list[MeshPart] = []
        reports: list[dict[str, Any]] = []
        corners: list[np.ndarray] = []
        for n, export in enumerate(exports, start=1):
            tag = export.session_id[:8]
            photo = export.photogrammetry()
            mesh = read_obj(photo.obj)
            to_splat = np.asarray(photo.alignment_matrix, np.float64).reshape(4, 4).T
            positions = alignment.apply(to_splat, mesh.positions)

            # ARKit -> splat par ICP du LiDAR de la capture sur sa photogrammétrie ; l'inverse place le splat
            arkit_to_splat, report = self._fit_part(export, photo, to_splat, positions, mesh.faces)
            transform = np.linalg.inv(arkit_to_splat)
            reports.append({"session": export.session_id, **report})

            gaussian = export.gaussian()
            spz = self.out / f"splat-{n}.spz"
            if not spz.exists() or spz.stat().st_mtime < gaussian.ply.stat().st_mtime:
                size_in, size_out = transcode_spz(gaussian.ply, spz)
                self.log(f"  splat {n}     {tag} : SPZ {size_in / 1e6:.1f} -> {size_out / 1e6:.1f} Mo")
            meta = gaussian.metadata
            splats.append({
                "url": spz.name,
                "bytes": spz.stat().st_size,
                "count": meta.get("splatCount"),
                "shDegree": meta.get("shDegree"),
                "transform": _rounded(transform),
            })
            lo, hi = (np.asarray(meta.get(k), np.float64) for k in ("meshBoundsMin", "meshBoundsMax"))
            box = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
            corners.append(alignment.apply(transform, box))

            normals = None
            if mesh.normals is not None:
                normals = mesh.normals @ np.linalg.inv((transform @ to_splat)[:3, :3])
                normals /= np.linalg.norm(normals, axis=1, keepdims=True)
            texture = read_mtl_diffuse_map(photo.mtl) if photo.mtl.exists() else None
            meshes.append(MeshPart(
                positions=alignment.apply(transform, positions),
                faces=mesh.faces,
                uvs=None if mesh.uvs is None else np.c_[mesh.uvs[:, 0], 1.0 - mesh.uvs[:, 1]],
                normals=normals,
                texture_jpeg=encode_jpeg(texture) if texture else None,
                name=f"photogrammetry-{n}",
            ))
            self.log(f"  capture {n}   {tag} : {meta.get('splatCount')} splats, {len(mesh.faces)} triangles")

        write_glb_parts(self.out / "mesh.glb", meshes)
        everything = np.vstack(corners)
        self.manifest["layers"]["splat"] = {
            "url": splats[0]["url"],
            "bytes": sum(s["bytes"] for s in splats),
            "count": sum(s["count"] or 0 for s in splats),
            "shDegree": max(s["shDegree"] or 0 for s in splats),
            "parts": splats,
        }
        self.manifest["layers"]["mesh"] = {
            "url": "mesh.glb",
            "bytes": (self.out / "mesh.glb").stat().st_size,
            "triangles": int(sum(len(m.faces) for m in meshes)),
        }
        self.manifest["bounds"] = {"min": everything.min(0).round(4).tolist(), "max": everything.max(0).round(4).tolist()}
        self.manifest["alignment"]["parts"] = reports

    def _fit_part(self, export: SessionExport, photo, to_splat: np.ndarray, positions: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
        cloud = self.lidar(export.point_cloud())
        lo = positions.min(0) - ICP_CROP_MARGIN
        hi = positions.max(0) + ICP_CROP_MARGIN
        near = cloud.positions[np.all((cloud.positions >= lo) & (cloud.positions <= hi), axis=1)]
        rng = np.random.default_rng(0)
        source = near[rng.choice(len(near), min(ICP_SOURCE_POINTS, len(near)), replace=False)]
        target, normals = alignment.sample_surface(positions, faces, ICP_TARGET_POINTS)
        tree = cKDTree(target)

        # Départs : aucune correction, et recalage par les poses de capture quand l'export les contient
        starts: list[tuple[str, np.ndarray | None]] = [("identity", None)]
        arkit = export.capture_poses() if (export.root / "captures" / "poses").exists() else {}
        refined = photo.camera_poses()
        common = [k for k in arkit if k in refined]
        if len(common) >= 10:
            as_matrix = lambda m: np.asarray(m, np.float64).reshape(4, 4).T  # noqa: E731
            fit = alignment.fit_pose_pairs([as_matrix(arkit[k]) for k in common], [to_splat @ as_matrix(refined[k]) for k in common])
            starts.append(("pose-pairs", fit.transform))
        results = [(name, alignment.icp(source.astype(np.float64), target, normals, initial=start, iterations=ICP_ITERATIONS)) for name, start in starts]
        name, best = max(results, key=lambda r: alignment.fit_score(r[1].transform, source.astype(np.float64), tree))
        angle = np.degrees(np.arccos(np.clip((np.trace(best.transform[:3, :3]) - 1) / 2, -1, 1)))
        shift = float(np.linalg.norm(best.transform[:3, 3]))
        self.log(f"  icp         {export.session_id[:8]} : {best.median_before:.3f} -> {best.median_after:.3f} m, "
                 f"{best.inlier_ratio:.0%} appariés, correction {angle:.1f}° / {shift:.2f} m (départ {name})")
        return best.transform, {
            "method": "icp-lidar-to-photogrammetry",
            "start": name,
            "medianResidualBefore": round(best.median_before, 4),
            "medianResidualAfter": round(best.median_after, 4),
            "inlierRatio": round(best.inlier_ratio, 3),
            "correctionDegrees": round(float(angle), 2),
            "correctionMeters": round(shift, 3),
        }

    # --- Nuage de points --------------------------------------------------------

    def lidar(self, ply: Path) -> PointCloud:
        """Nuage LiDAR en repère ARKit, voxelisé à BASE_VOXEL à la lecture (mis en cache)."""
        stat = ply.stat()
        key = hashlib.sha1(f"{ply.resolve()}|{stat.st_size}|{stat.st_mtime_ns}|{BASE_VOXEL}|{LIDAR_STRIDE}".encode()).hexdigest()[:16]
        cached = CACHE_DIR / f"lidar-{ply.stem.removeprefix('sparse_cloud_')[:8]}-{key}.npz"
        if cached.exists():
            data = np.load(cached)
            return PointCloud(data["positions"], data["colors"])
        self.log(f"  lecture     {ply.name} ({stat.st_size / 1e6:.0f} Mo)…")
        kept: list[PointCloud] = []
        pending = 0
        for chunk in iter_ply_vertices(ply, stride=LIDAR_STRIDE):
            part = voxel_downsample(PointCloud(
                alignment.apply(alignment.CLOUD_TO_ARKIT, xyz(chunk)),
                np.stack([chunk["red"], chunk["green"], chunk["blue"]], axis=1).astype(np.uint8),
            ), BASE_VOXEL)
            kept.append(part)
            pending += len(part.positions)
            if pending > COMPACT_ABOVE:
                kept = [_merge(kept, BASE_VOXEL)]
                pending = len(kept[0].positions)
        cloud = _merge(kept, BASE_VOXEL)
        CACHE_DIR.mkdir(exist_ok=True)
        np.savez(cached, positions=cloud.positions.astype(np.float32), colors=cloud.colors)
        return PointCloud(cloud.positions.astype(np.float32), cloud.colors)

    def build_point_cloud(self, exports: list[SessionExport]) -> None:
        sources = [x.point_cloud() for x in exports]
        for extra in self.entry.get("lidar", []):
            sources.append(self._open(extra).point_cloud())
        clouds = [self.lidar(p) for p in sources]
        merged = _merge(clouds, BASE_VOXEL)
        limit = self.entry.get("point_cloud", {}).get("max_points", DEFAULT_MAX_POINTS)
        voxel = BASE_VOXEL
        for voxel in VOXEL_STEPS:
            cloud = merged if voxel == BASE_VOXEL else voxel_downsample(merged, voxel)
            if len(cloud.positions) <= limit:
                break
        cloud = PointCloud(cloud.positions.astype(np.float64), cloud.colors)
        lo, hi = write_points_bin(self.out / "points.bin", cloud)
        self.manifest["layers"]["pointCloud"] = {
            "url": "points.bin",
            "bytes": (self.out / "points.bin").stat().st_size,
            "count": int(len(cloud.positions)),
            "voxelSize": voxel,
            "boundsMin": lo,
            "boundsMax": hi,
        }
        self.manifest["alignment"]["pointCloud"] = {
            "method": "arkit-worldmap",
            "sources": [p.name for p in sources],
        }
        self.log(f"  pointCloud  {len(sources)} nuages, {sum(len(c.positions) for c in clouds)} points -> "
                 f"{len(cloud.positions)} (voxel {voxel * 100:.1f} cm)")

    # --- Bande son et trajet ----------------------------------------------------

    def build_playback(self, export: SessionExport) -> None:
        cfg = self.entry["playback"]
        skipped = {s.upper() for s in cfg.get("skip_videos", [])}
        ids = sorted(p.stem[6:] for p in (export.root / "videos").glob("video_*.mp4"))
        videos = [export.video(i) for i in ids if not any(i.upper().startswith(s) for s in skipped)]
        videos.sort(key=lambda v: v.metadata["startTime"])
        if not videos:
            raise RuntimeError("Event sans vidéo")

        # Les bandes son se suivent sans blanc : chaque trajet est décalé de la durée réelle des précédentes
        durations = [_audio_duration(v.mp4) for v in videos]
        concat_audio([v.mp4 for v in videos], self.out / "audio.m4a")
        times, positions, quaternions, clips = [], [], [], []
        offset = 0.0
        for video, duration in zip(videos, durations):
            path = build_camera_path(video)
            for k in path["keyframes"]:
                times.append(offset + min(k["t"], duration))
                positions.append(k["position"])
                quaternions.append(k["quaternion"])
            clips.append({"videoId": video.metadata["id"], "recordedAt": video.metadata["startTime"], "offset": round(offset, 3), "duration": round(duration, 3)})
            offset += duration
        total = offset

        smoothing = float(cfg.get("camera_smoothing", DEFAULT_PATH_SMOOTHING))
        t, p, q = smooth_path(np.asarray(times), np.asarray(positions), np.asarray(quaternions), total, smoothing)
        first = build_camera_path(videos[0])
        write_json(self.out / "camera_path.json", {
            "coordinateSystem": "Y-up, right-handed, meters (repère ARKit commun de l'Event)",
            "videoId": "+".join(v.id for v in videos),
            "duration": round(total, 4),
            "fovY": round(float(np.median([build_camera_path(v)["fovY"] for v in videos])), 3),
            "aspect": first["aspect"],
            "keyframes": [
                {"t": round(float(ti), 3), "position": [round(float(v), 4) for v in pi], "quaternion": [round(float(v), 5) for v in qi]}
                for ti, pi, qi in zip(t, p, q)
            ],
        })
        self.manifest["playback"] = {
            "audioUrl": "audio.m4a",
            "cameraPathUrl": "camera_path.json",
            "duration": round(total, 4),
            "recordedAt": videos[0].metadata["startTime"],
            "cameraSmoothing": VIEWER_SMOOTHING,
            "clips": clips,
        }
        # La date affichée est celle de la performance (début de la première vidéo retenue)
        self.manifest["startDate"] = videos[0].metadata["startTime"]
        self.manifest["endDate"] = videos[-1].metadata["endTime"]
        self.manifest["alignment"]["camera"] = {"method": "arkit-worldmap", "smoothingSeconds": smoothing}
        self.log(f"  playback    {len(videos)} vidéos ({', '.join(v.id for v in videos)}) -> {total / 60:.1f} min, "
                 f"{len(t)} keyframes (lissage {smoothing} s)")

    # --- Vue d'arrivée et rotation automatique ---------------------------------

    def _apply_view(self) -> None:
        """Vue d'arrivée et axe de rotation propres à l'Event (sessions.json, sinon déduits du trajet).

        Vue par défaut : en retrait et en surplomb du début du trajet, tournée vers
        ce que filme la caméra. Rotation : autour du centre de la zone parcourue.
        """
        cfg = self.entry
        clean = lambda d: {k: v for k, v in d.items() if not k.startswith("$")}  # noqa: E731
        if cfg.get("view"):
            self.manifest["view"] = clean(cfg["view"])
        if cfg.get("orbit"):
            self.manifest["orbit"] = clean(cfg["orbit"])
        path_file = self.out / "camera_path.json"
        if ("view" in self.manifest and "orbit" in self.manifest) or not path_file.exists():
            return
        import json
        keyframes = json.loads(path_file.read_text(encoding="utf-8"))["keyframes"]
        positions = np.array([k["position"] for k in keyframes])
        first = keyframes[0]
        look = np.array(_rotate([0.0, 0.0, -1.0], first["quaternion"]))
        look[1] = 0.0
        look /= np.linalg.norm(look)
        start = np.array(first["position"])
        target = start + 4.0 * look - np.array([0.0, 0.6, 0.0])
        position = start - 4.0 * look + np.array([0.0, 2.0, 0.0])
        self.manifest.setdefault("view", _look_at(position, target))
        center = np.median(positions, axis=0)
        center[1] -= 0.3
        self.manifest.setdefault("orbit", {
            "center": center.round(3).tolist(),
            "radius": {"min": 6.0, "max": 14.0},
            "height": {"min": 2.5, "max": 6.0},
        })


def _rotate(v: list[float], q: list[float]) -> list[float]:
    """Vecteur tourné par le quaternion [x, y, z, w]."""
    x, y, z, w = q
    u = np.array([x, y, z])
    v = np.asarray(v, float)
    return (v + 2 * np.cross(u, np.cross(u, v) + w * v)).tolist()


def _look_at(position: np.ndarray, target: np.ndarray) -> dict[str, Any]:
    forward = target - position
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    return {
        "position": position.round(4).tolist(),
        "quaternion": _matrix_quaternion(np.stack([right, up, -forward], axis=1)),
        "target": target.round(4).tolist(),
    }


def _merge(clouds: list[PointCloud], voxel: float) -> PointCloud:
    if len(clouds) == 1:
        return clouds[0]
    return voxel_downsample(PointCloud(
        np.vstack([c.positions for c in clouds]).astype(np.float64),
        np.vstack([c.colors for c in clouds]),
    ), voxel)


def _matrix_quaternion(r: np.ndarray) -> list[float]:
    m = np.eye(4)
    m[:3, :3] = r
    return [round(v, 6) for v in rotation_to_quaternion(m.T.reshape(-1).tolist())]


def smooth_path(times: np.ndarray, positions: np.ndarray, quaternions: np.ndarray, duration: float, sigma: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Trajet régulier : ré-échantillonnage à PATH_RATE, lissage gaussien (s), keyframes à PATH_OUTPUT_RATE.

    Les quaternions sont ramenés dans un même hémisphère avant d'être
    interpolés et moyennés, puis renormalisés.
    """
    order = np.argsort(times, kind="stable")
    times, positions, quaternions = times[order], positions[order], quaternions[order].copy()
    for i in range(1, len(quaternions)):
        if np.dot(quaternions[i], quaternions[i - 1]) < 0:
            quaternions[i] = -quaternions[i]
    grid = np.linspace(0.0, duration, int(round(duration * PATH_RATE)) + 1)
    p = np.stack([np.interp(grid, times, positions[:, c]) for c in range(3)], axis=1)
    q = np.stack([np.interp(grid, times, quaternions[:, c]) for c in range(4)], axis=1)
    if sigma > 0:
        p = ndimage.gaussian_filter1d(p, sigma * PATH_RATE, axis=0, mode="nearest")
        q = ndimage.gaussian_filter1d(q, sigma * PATH_RATE, axis=0, mode="nearest")
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    step = max(1, PATH_RATE // PATH_OUTPUT_RATE)
    keep = np.unique(np.r_[np.arange(0, len(grid), step), len(grid) - 1])
    return grid[keep], p[keep], q[keep]


def _audio_duration(video: Path) -> float:
    result = subprocess.run(
        [require_tool("ffprobe"), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "csv=p=0", str(video)],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def concat_audio(videos: list[Path], output: Path) -> None:
    """Bandes son mises bout à bout, en AAC mono (une seule piste web, sous la limite de 25 Mo par fichier)."""
    inputs = [arg for v in videos for arg in ("-i", str(v))]
    graph = "".join(f"[{i}:a:0]" for i in range(len(videos))) + f"concat=n={len(videos)}:v=0:a=1[a]"
    subprocess.run(
        [
            require_ffmpeg(), "-y", "-loglevel", "error", *inputs,
            "-filter_complex", graph, "-map", "[a]",
            "-ac", "1", "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-movflags", "+faststart",
            str(output),
        ],
        check=True,
    )
