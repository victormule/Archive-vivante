"""Construction d'un Event : plusieurs exports réunis en une seule scène.

Un Event conclut les sessions : plusieurs captures (splat, photogrammétrie,
LiDAR) couvrent chacune une zone d'un même lieu, et plusieurs vidéos tournées
à la suite forment une seule bande son et un seul trajet caméra.

Repère de l'Event : celui du LiDAR de référence (`reference_lidar`, la session
vidéo : il couvre tout le lieu et c'est le repère du trajet caméra). dür.air a
relocalisé les sessions sur une même carte, mais imparfaitement (la session
vidéo est 1,3 m plus haut, les autres flottent de ±10 cm) : rien n'est pris
tel quel.

1. LiDAR de chaque capture -> LiDAR de référence : sols mis à la même
   hauteur, puis ICP en lacet + translation (repères ARKit calés sur la gravité).
2. Photogrammétrie (et splat) -> LiDAR de sa capture : sol mis à plat puis
   ICP en lacet + translation (ou ICP libre si le sol mesuré n'est pas fiable).
3. Affinage direct de chaque photogrammétrie placée contre le LiDAR de référence.

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
from scipy.spatial.transform import Rotation

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
# Recalage d'une session sur les captures : voxel du nuage cible (m)
LINK_VOXEL = 0.05
LINK_ITERATIONS = 40
# Affinage local : référence pleine résolution (2,5 cm) autour de la session
DENSE_TARGET_POINTS = 250_000
DENSE_ITERATIONS = 20
# Sol : cellules (m) et percentile bas des hauteurs
FLOOR_CELL = 1.0
FLOOR_PERCENTILE = 5
# Recalage nivelé retenu si son score atteint cette part de celui de l'ICP libre
LEVELED_TOLERANCE = 0.95
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
    _links: dict[Path, tuple[np.ndarray, dict[str, Any]]] = field(default_factory=dict)
    _reference: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None

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
            "alignment": {"reference": "lidar:" + self.reference_ply.stem.removeprefix("sparse_cloud_")},
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

    @property
    def reference_ply(self) -> Path:
        """LiDAR de référence (repère de l'Event)."""
        return self._open(self.entry.get("reference_lidar") or self.entry["lidar"][0]).point_cloud()

    def reference_target(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Référence voxelisée (positions), et son échantillon cible d'ICP avec normales (mis en mémoire)."""
        if self._reference is None:
            full = self.lidar(self.reference_ply).positions.astype(np.float64)
            coarse = voxel_downsample(PointCloud(full, np.zeros((len(full), 3), np.uint8)), LINK_VOXEL).positions
            rng = np.random.default_rng(1)
            target = coarse[rng.choice(len(coarse), min(ICP_TARGET_POINTS, len(coarse)), replace=False)]
            self._reference = (full, target, alignment.estimate_normals(target))
        return self._reference

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
            link, link_report = self.session_link(export.point_cloud())
            transform = link @ np.linalg.inv(arkit_to_splat)
            transform, polish = self._polish(transform, positions, mesh.faces, tag)
            reports.append({"session": export.session_id, **report, "lidarLink": link_report, "polish": polish})

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
        """ARKit -> splat de la capture, sans inclinaison parasite.

        ARKit est calé sur la gravité : le sol du LiDAR fait foi. On aligne
        d'abord le sol de la photogrammétrie sur celui du LiDAR (inclinaison),
        puis l'ICP n'ajuste que la rotation autour de la verticale et la
        translation ; enfin les deux sols sont mis à la même hauteur.
        """
        cloud = self.lidar(export.point_cloud())
        lo = positions.min(0) - ICP_CROP_MARGIN
        hi = positions.max(0) + ICP_CROP_MARGIN
        near = cloud.positions[np.all((cloud.positions >= lo) & (cloud.positions <= hi), axis=1)].astype(np.float64)
        rng = np.random.default_rng(0)
        source = near[rng.choice(len(near), min(ICP_SOURCE_POINTS, len(near)), replace=False)]
        target, normals = alignment.sample_surface(positions, faces, ICP_TARGET_POINTS)

        floor_lidar = floor_normal(source, alignment.estimate_normals(source))
        floor_mesh = floor_normal(target, normals)
        start = _about(source.mean(0), _rotation_between(floor_lidar, floor_mesh))
        leveled = alignment.icp(source, target, normals, initial=start, iterations=ICP_ITERATIONS, yaw_only=True)
        free = alignment.icp(source, target, normals, iterations=ICP_ITERATIONS)
        # Le recalage nivelé est retenu s'il colle presque aussi bien que l'ICP libre (sinon le sol mesuré n'est pas fiable)
        tree = cKDTree(target)
        scores = {name: alignment.fit_score(r.transform, source, tree) for name, r in (("leveled", leveled), ("free", free))}
        method = "leveled" if scores["leveled"] >= LEVELED_TOLERANCE * scores["free"] else "free"
        best = leveled if method == "leveled" else free
        # Hauteur : sols à la même altitude (percentile bas, cellule par cellule)
        dy = floor_offset(alignment.apply(np.linalg.inv(best.transform), target), near)
        transform = best.transform
        if np.isfinite(dy):
            transform = transform @ _translation([0.0, -dy, 0.0])
        tilt = np.degrees(np.arccos(np.clip(np.dot(floor_lidar, floor_mesh), -1, 1))) if method == "leveled" else 0.0
        angle = np.degrees(np.arccos(np.clip((np.trace(transform[:3, :3]) - 1) / 2, -1, 1)))
        shift = float(np.linalg.norm(transform[:3, 3]))
        self.log(f"  icp         {export.session_id[:8]} : {best.median_before:.3f} -> {best.median_after:.3f} m, "
                 f"{best.inlier_ratio:.0%} appariés, {'nivelé' if method == 'leveled' else 'ICP libre'} "
                 f"(scores {scores['leveled']:.2f} / {scores['free']:.2f}), sol redressé de {tilt:.1f}°, décalé de {(dy if np.isfinite(dy) else 0) * 100:+.1f} cm "
                 f"(correction totale {angle:.1f}° / {shift:.2f} m)")
        return transform, {
            "method": "floor-level + icp-yaw-lidar-to-photogrammetry" if method == "leveled" else "icp-lidar-to-photogrammetry",
            "fitScores": {k: round(v, 3) for k, v in scores.items()},
            "floorTiltDegrees": round(float(tilt), 2),
            "floorOffsetMeters": round(float(dy), 3) if np.isfinite(dy) else None,
            "medianResidualBefore": round(best.median_before, 4),
            "medianResidualAfter": round(best.median_after, 4),
            "inlierRatio": round(best.inlier_ratio, 3),
            "correctionDegrees": round(float(angle), 2),
            "correctionMeters": round(shift, 3),
        }

    def session_link(self, ply: Path) -> tuple[np.ndarray, dict[str, Any]]:
        """LiDAR d'une session -> LiDAR de référence.

        Sols mis à la même hauteur d'abord (la relocalisation peut être fausse
        de plus d'un mètre), puis ICP en lacet + translation : les deux repères
        ARKit sont calés sur la gravité, seule une rotation autour de la
        verticale est admise. Les sols sont enfin recalés au centimètre.
        """
        if ply in self._links:
            return self._links[ply]
        if ply.resolve() == self.reference_ply.resolve():
            self._links[ply] = (np.eye(4), {"method": "reference"})
            return self._links[ply]
        full, target, normals = self.reference_target()
        source_cloud = self.lidar(ply).positions.astype(np.float64)
        dy = floor_offset(source_cloud, full)
        start = _translation([0.0, dy if np.isfinite(dy) else 0.0, 0.0])
        rng = np.random.default_rng(0)
        source = source_cloud[rng.choice(len(source_cloud), min(ICP_SOURCE_POINTS, len(source_cloud)), replace=False)]
        result = alignment.icp(source, target, normals, max_distance=0.8, final_distance=0.04,
                               iterations=LINK_ITERATIONS, initial=start, yaw_only=True)
        # Affinage local et dense : référence pleine résolution autour de la session, seuil final de 2 cm
        moved = alignment.apply(result.transform, source_cloud)
        lo, hi = moved.min(0) - 0.5, moved.max(0) + 0.5
        local = full[np.all((full >= lo) & (full <= hi), axis=1)]
        if len(local) > DENSE_TARGET_POINTS:
            local = local[rng.choice(len(local), DENSE_TARGET_POINTS, replace=False)]
        dense = alignment.icp(alignment.apply(result.transform, source), local, alignment.estimate_normals(local),
                              max_distance=0.15, final_distance=0.02, iterations=DENSE_ITERATIONS, yaw_only=True)
        transform = dense.transform @ result.transform
        fine = floor_offset(alignment.apply(transform, source_cloud), full)
        transform = _translation([0.0, fine if np.isfinite(fine) else 0.0, 0.0]) @ transform
        angle = np.degrees(np.arccos(np.clip((np.trace(transform[:3, :3]) - 1) / 2, -1, 1)))
        t = transform[:3, 3]
        self.log(f"  lidar       {ply.stem[13:21]} -> référence : sol {(dy if np.isfinite(dy) else 0):+.2f} m, ICP "
                 f"{result.median_before:.3f} -> {result.median_after:.3f} m, affinage dense {dense.median_before:.3f} -> {dense.median_after:.3f} m, "
                 f"sol {(fine if np.isfinite(fine) else 0) * 100:+.1f} cm (lacet {angle:.1f}°, {t[0]:+.2f} / {t[1]:+.2f} / {t[2]:+.2f} m)")
        report = {
            "method": "floor-height + icp-yaw-lidar-to-reference",
            "medianResidualBefore": round(result.median_before, 4),
            "medianResidualAfter": round(result.median_after, 4),
            "inlierRatio": round(result.inlier_ratio, 3),
            "dense": {"medianResidualBefore": round(dense.median_before, 4), "medianResidualAfter": round(dense.median_after, 4),
                      "inlierRatio": round(dense.inlier_ratio, 3)},
            "transform": _rounded(transform),
        }
        self._links[ply] = (transform, report)
        return self._links[ply]

    def _polish(self, transform: np.ndarray, positions: np.ndarray, faces: np.ndarray, tag: str) -> tuple[np.ndarray, dict[str, Any]]:
        """Affinage direct : photogrammétrie placée contre le LiDAR de référence (lacet + translation)."""
        full, _, _ = self.reference_target()
        placed = alignment.apply(transform, positions)
        lo, hi = placed.min(0) - 0.5, placed.max(0) + 0.5
        near = full[np.all((full >= lo) & (full <= hi), axis=1)]
        if len(near) < 1000:
            return transform, {"method": "none", "reason": "référence absente autour de la capture"}
        rng = np.random.default_rng(0)
        source = near[rng.choice(len(near), min(ICP_SOURCE_POINTS, len(near)), replace=False)]
        target, normals = alignment.sample_surface(placed, faces, ICP_TARGET_POINTS)
        tree = cKDTree(target)
        before = alignment.fit_score(np.eye(4), source, tree)
        result = alignment.icp(source, target, normals, max_distance=0.3, final_distance=0.03,
                               iterations=ICP_ITERATIONS, yaw_only=True)
        after = alignment.fit_score(result.transform, source, tree)
        # L'ICP déplace la référence vers le maillage : le maillage bouge à l'inverse
        accepted = after > before
        if accepted:
            transform = np.linalg.inv(result.transform) @ transform
        # Sol de la photogrammétrie au niveau du sol de référence
        surface, _ = alignment.sample_surface(alignment.apply(transform, positions), faces, ICP_TARGET_POINTS)
        dy = floor_offset(surface, near)
        if np.isfinite(dy):
            transform = _translation([0.0, dy, 0.0]) @ transform
        self.log(f"  affinage    {tag} : score {before:.2f} -> {after:.2f} ({'retenu' if accepted else 'ignoré'}), "
                 f"sol {(dy if np.isfinite(dy) else 0) * 100:+.1f} cm")
        return transform, {"method": "icp-yaw-reference-to-photogrammetry + floor", "scoreBefore": round(before, 3),
                           "scoreAfter": round(after, 3), "accepted": accepted,
                           "floorOffsetMeters": round(float(dy), 3) if np.isfinite(dy) else None}

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
        sources = [x.point_cloud() for x in exports] + [self._open(extra).point_cloud() for extra in self.entry.get("lidar", [])]
        clouds, links = [], {}
        for ply in sources:
            link, links[ply.name] = self.session_link(ply)
            cloud = self.lidar(ply)
            clouds.append(PointCloud(alignment.apply(link, cloud.positions.astype(np.float64)).astype(np.float32), cloud.colors))
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
            "method": "lidar-to-reference",
            "sources": [p.name for p in sources],
            "links": links,
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
        # La session vidéo n'est pas relocalisée comme les captures : son LiDAR donne le recalage
        link, link_report = np.eye(4), {"method": "none"}
        for extra in self.entry.get("lidar", []):
            other = self._open(extra)
            if other.session_id == export.session_id:
                link, link_report = self.session_link(other.point_cloud())
        link_rotation = Rotation.from_matrix(link[:3, :3])
        clock = SessionClock.read(export)
        times, positions, quaternions, clips = [], [], [], []
        offset = 0.0
        for video, duration in zip(videos, durations):
            path = clock.keyframes(video) if clock else build_camera_path(video)["keyframes"]
            for k in path:
                times.append(offset + min(max(k["t"], 0.0), duration))
                positions.append(alignment.apply(link, np.asarray([k["position"]], float))[0])
                quaternions.append((link_rotation * Rotation.from_quat(k["quaternion"])).as_quat())
            clips.append({"videoId": video.metadata["id"], "recordedAt": video.metadata["startTime"], "offset": round(offset, 3), "duration": round(duration, 3)})
            offset += duration
        total = offset

        times_arr, positions_arr = np.asarray(times), np.asarray(positions, float)
        # Dérive des poses temps réel d'ARKit par rapport à la carte finale : décalages mesurés
        # en comparant la vidéo à la photogrammétrie, interpolés entre leurs instants
        corrections = sorted(cfg.get("corrections", []), key=lambda c: c["t"])
        if corrections:
            ct = np.array([c["t"] for c in corrections], float)
            co = np.array([c["offset"] for c in corrections], float)
            positions_arr = positions_arr + np.stack([np.interp(times_arr, ct, co[:, k]) for k in range(3)], axis=1)
        smoothing = float(cfg.get("camera_smoothing", DEFAULT_PATH_SMOOTHING))
        t, p, q = smooth_path(times_arr, positions_arr, np.asarray(quaternions), total, smoothing)
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
        self.manifest["alignment"]["camera"] = {
            "method": "video-session-lidar", "sessionLink": link_report, "smoothingSeconds": smoothing,
            "clock": clock.report if clock else "secondes arrondies (estimation)",
            "corrections": [{"t": c["t"], "offset": c["offset"]} for c in corrections],
        }
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


@dataclass(frozen=True)
class SessionClock:
    """Horloge précise d'une session ARKit.

    Les trajectoires vidéo ne sont horodatées qu'à la seconde (arrondie), alors
    que la trajectoire de session donne, pour ~1000 points, le décalage exact
    depuis le début de session, et l'instant exact de chaque `video_start`.
    Les points de session fixent la fraction de seconde du début de session :
    horodatage = floor(origine + décalage). On en déduit l'instant exact de
    chaque seconde des trajectoires vidéo, donc leur temps dans la vidéo.
    """

    origin: float  # instant (s, convention des horodatages) du début de session
    video_starts: dict[str, float]  # identifiant vidéo -> décalage exact depuis le début de session
    report: dict[str, Any]

    @classmethod
    def read(cls, export: SessionExport) -> "SessionClock | None":
        path = export.root / "trajectory" / "trajectory.json"
        if not path.exists():
            return None
        import json
        data = json.loads(path.read_text(encoding="utf-8"))
        x = np.array([_parse_ts(w["timestamp"]) - w["timeOffset"] for w in data.get("waypoints", [])])
        if len(x) < 10:
            return None
        lo, hi = float(x.max()), float(x.min()) + 1.0
        origin = (lo + hi) / 2 if lo < hi else float(np.median(x))
        starts = {
            e["videoSequenceID"][:8].upper(): float(e["timeOffset"])
            for e in data.get("events", []) if e.get("type") == "video_start"
        }
        return cls(origin, starts, {"method": "session-waypoints", "waypoints": len(x), "originUncertainty": round(max(0.0, hi - lo), 3)})

    def keyframes(self, video) -> list[dict[str, Any]]:
        """Keyframes (t dans la vidéo, position, quaternion) au temps exact."""
        start = self.video_starts.get(video.id[:8].upper())
        if start is None:
            return build_camera_path(video)["keyframes"]
        points: list[dict[str, Any]] = []
        for pt in video.trajectory["trajectoryPoints"]:
            if not points or points[-1]["transform"] != pt["transform"]:
                points.append(pt)
        by_second: dict[float, list[dict[str, Any]]] = {}
        for pt in points:
            by_second.setdefault(_parse_ts(pt["timestamp"]), []).append(pt)
        out = []
        for second in sorted(by_second):
            group = by_second[second]
            for i, pt in enumerate(group):
                session_time = second - self.origin + (i + 0.5) / len(group)
                m = pt["transform"]
                out.append({
                    "t": session_time - start,
                    "position": m[12:15],
                    "quaternion": rotation_to_quaternion(m),
                })
        return out


def _floor_cells(points: np.ndarray) -> dict[tuple[int, int], float]:
    """Hauteur du sol par cellule horizontale (percentile bas), cellules assez peuplées."""
    keys = np.floor(points[:, [0, 2]] / FLOOR_CELL).astype(np.int64)
    order = np.lexsort((keys[:, 1], keys[:, 0]))
    k, y = keys[order], points[order, 1]
    split = np.flatnonzero(np.any(np.diff(k, axis=0) != 0, axis=1)) + 1
    return {
        (int(kk[0, 0]), int(kk[0, 1])): float(np.percentile(yy, FLOOR_PERCENTILE))
        for kk, yy in zip(np.split(k, split), np.split(y, split)) if len(yy) >= 30
    }


def floor_offset(points: np.ndarray, reference: np.ndarray) -> float:
    """Décalage vertical (m) à ajouter à `points` pour que son sol rejoigne celui de `reference`."""
    a, b = _floor_cells(points), _floor_cells(reference)
    common = [c for c in a if c in b]
    return float(np.median([b[c] - a[c] for c in common])) if len(common) >= 5 else float("nan")


def floor_normal(points: np.ndarray, normals: np.ndarray) -> np.ndarray:
    """Normale du sol : surfaces horizontales les plus basses, plan ajusté par ACP.

    Les surfaces horizontales (normale à moins de 25° de la verticale) du
    quart le plus bas forment le sol ; plateaux et assises, plus hauts, sont
    écartés.
    """
    flat = np.abs(normals[:, 1]) > np.cos(np.radians(25))
    candidates = points[flat]
    if len(candidates) < 200:
        return np.array([0.0, 1.0, 0.0])
    band = candidates[candidates[:, 1] < np.percentile(candidates[:, 1], 25) + 0.15]
    centered = band - band.mean(0)
    normal = np.linalg.eigh(centered.T @ centered)[1][:, 0]
    return normal if normal[1] > 0 else -normal


def _rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Plus petite rotation (3x3) qui amène le vecteur unitaire a sur b."""
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + k + k @ k / (1 + c)


def _about(center: np.ndarray, rotation: np.ndarray) -> np.ndarray:
    """Rotation 4x4 autour d'un point."""
    m = np.eye(4)
    m[:3, :3] = rotation
    m[:3, 3] = center - rotation @ center
    return m


def _translation(t: list[float]) -> np.ndarray:
    m = np.eye(4)
    m[:3, 3] = t
    return m


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
