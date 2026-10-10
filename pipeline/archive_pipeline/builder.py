"""Construction des assets web d'une session.

Toutes les couches d'une session sont exprimées dans un repère unique : celui
du Gaussian splat (voir alignment.py). La `worldTransform` du manifest place
ensuite la session dans le repère commun du projet (calage sur la table).

Une vidéo (ou des annotations) peut venir d'une autre session ARKit que le
splat : son repère est alors recalé sur celui du splat par ICP des nuages
LiDAR des deux sessions (`arkit_session` dans sessions.json).
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from . import alignment
from .camera_path import build_camera_path
from .annotations import read_annotations
from .export_reader import PhotogrammetryAsset, SessionExport, resolve_dir, resolve_path
from .gltf import write_glb
from .media import encode_jpeg, encode_web_image, encode_web_video, extract_audio, extract_poster, render_pdf_thumbnail, transcode_spz
from .obj import read_mtl_diffuse_map, read_obj
from .ply import read_ply_vertices, xyz
from .point_cloud import PointCloud, read_points_bin, read_points_bin_colors, voxel_downsample, write_points_bin

# Étapes de construction, dans l'ordre d'exécution, avec leurs dépendances
STEPS = ("splat", "mesh", "pointCloud", "playback", "annotations", "registration")
STEP_DEPENDENCIES = {"pointCloud": {"mesh"}, "playback": {"mesh"}}

# Médias d'annotation produits par le build : <id>-<n>.jpg, <id>-v<n>.mp4/.jpg, <id>-d<n>.pdf/.jpg
GENERATED_MEDIA = re.compile(r"^[0-9a-f]{8}-[vd]?\d+\.(?:jpg|mp4|pdf)$")

IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]

ICP_SOURCE_POINTS = 150_000
ICP_TARGET_POINTS = 600_000
# Recalage entre deux sessions ARKit : sous-échantillonnage des nuages LiDAR
LINK_SAMPLE_POINTS = 3_000_000
LINK_VOXEL = 0.03


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _media_urls(media: dict[str, Any]) -> list[str]:
    """URLs d'un média publié : le fichier, et sa vignette ou son image d'attente."""
    return [media["url"], *(media[k]["url"] for k in ("poster", "thumbnail") if media.get(k))]


def read_manifest(session_out: Path) -> dict[str, Any]:
    return json.loads((session_out / "manifest.json").read_text(encoding="utf-8"))


def copy_if_changed(src: Path, dst: Path) -> None:
    if dst.exists() and dst.stat().st_size == src.stat().st_size and dst.stat().st_mtime >= src.stat().st_mtime:
        return
    shutil.copy2(src, dst)


@dataclass
class SessionBuilder:
    entry: dict[str, Any]
    export: SessionExport
    out: Path
    project_root: Path
    log: Any = print
    # Indice de couleur commun à tout le projet, par titre d'annotation
    color_index: dict[str, int] = field(default_factory=dict)
    # Dossier de sortie de la session de référence (recalage inter-sessions)
    reference_out: Path | None = None
    manifest: dict[str, Any] = field(default_factory=dict)

    # Repère ARKit -> repère du splat, pour les trajectoires caméra (voir alignment.py)
    camera_to_world: np.ndarray | None = None
    camera_alignment_report: dict[str, Any] | None = None
    _mesh_world: tuple[np.ndarray, np.ndarray] | None = None
    # Autre session ARKit -> session ARKit du splat (cache, voir arkit_link)
    _links: dict[str, tuple[np.ndarray, dict[str, Any]]] = field(default_factory=dict)

    def build(self, only: set[str] | None = None) -> dict[str, Any]:
        """Construit toutes les étapes, ou seulement `only` (et leurs dépendances)
        en conservant le reste du manifest existant."""
        self.out.mkdir(parents=True, exist_ok=True)
        e, s = self.entry, self.export
        previous_path = self.out / "manifest.json"
        previous = json.loads(previous_path.read_text(encoding="utf-8")) if only and previous_path.exists() else {}
        self.manifest = {
            "id": e["id"],
            "title": e["title"],
            "day": e["day"],
            "index": e["index"],
            "sessionId": s.session_id,
            "startDate": s.session["startDate"],
            "endDate": s.session["endDate"],
            "author": s.project.get("author"),
            "layers": {"splat": None, "mesh": None, "pointCloud": None},
            "annotations": None,
            "alignment": {"reference": "splat"},
            # Repère de la session -> repère commun du projet (column-major)
            "worldTransform": IDENTITY,
            "playback": None,
        }
        for key in ("layers", "annotations", "alignment", "playback", "bounds", "worldTransform"):
            if key in previous:
                self.manifest[key] = previous[key]

        steps = set(STEPS) if not only else only | set().union(*(STEP_DEPENDENCIES.get(x, set()) for x in only))
        # Des annotations en repère ARKit ont besoin du recalage caméra (étape mesh)
        if "annotations" in steps and (self.entry.get("annotations") or {}).get("frame") == "arkit":
            steps.add("mesh")
        actions = {
            "splat": self.build_splat,
            "mesh": self.build_mesh,
            "pointCloud": self.build_point_cloud,
            "playback": self.build_playback,
            "annotations": self.build_annotations,
            "registration": self.build_registration,
        }
        for step in STEPS:
            if step in steps:
                actions[step]()
        write_json(self.out / "manifest.json", self.manifest)
        return self.manifest

    # --- Couches -----------------------------------------------------------

    def build_splat(self) -> None:
        """Splat compressé en SPZ (×15 plus léger que le PLY, lu nativement par Spark)."""
        gaussian = self.export.gaussian()
        spz = self.out / "splat.spz"
        if not spz.exists() or spz.stat().st_mtime < gaussian.ply.stat().st_mtime:
            size_in, size_out = transcode_spz(gaussian.ply, spz)
            self.log(f"  splat       SPZ {size_in / 1e6:.1f} -> {size_out / 1e6:.1f} Mo")
        (self.out / "splat.ply").unlink(missing_ok=True)  # ancien format
        meta = gaussian.metadata
        self.manifest["layers"]["splat"] = {
            "url": spz.name,
            "bytes": spz.stat().st_size,
            "count": meta.get("splatCount"),
            "shDegree": meta.get("shDegree"),
        }
        self.manifest["bounds"] = {"min": meta.get("meshBoundsMin"), "max": meta.get("meshBoundsMax")}
        self.log(f"  splat       {meta.get('splatCount')} splats")

    def build_mesh(self) -> None:
        photo = self.export.photogrammetry()
        mesh = read_obj(photo.obj)
        to_world = np.asarray(photo.alignment_matrix, np.float64).reshape(4, 4).T
        positions = alignment.apply(to_world, mesh.positions)
        normals = None
        if mesh.normals is not None:
            normals = mesh.normals @ np.linalg.inv(to_world[:3, :3])
            normals /= np.linalg.norm(normals, axis=1, keepdims=True)
        uvs = None if mesh.uvs is None else np.c_[mesh.uvs[:, 0], 1.0 - mesh.uvs[:, 1]]

        texture = read_mtl_diffuse_map(photo.mtl) if photo.mtl.exists() else None
        write_glb(
            self.out / "mesh.glb",
            positions, mesh.faces, uvs, normals,
            texture_jpeg=encode_jpeg(texture) if texture else None,
            name="photogrammetry",
        )
        self._mesh_world = (positions, mesh.faces)
        self.manifest["layers"]["mesh"] = {
            "url": "mesh.glb",
            "bytes": (self.out / "mesh.glb").stat().st_size,
            "triangles": int(len(mesh.faces)),
        }
        self.manifest["alignment"]["mesh"] = self._photo_alignment_report(photo)
        self.log(f"  mesh        {len(mesh.faces)} triangles")
        self.fit_camera_alignment(photo, to_world)

    def fit_camera_alignment(self, photo: PhotogrammetryAsset, to_world: np.ndarray) -> None:
        """ARKit -> splat à partir des poses de capture et des poses photogrammétriques."""
        arkit = self.export.capture_poses()
        refined = photo.camera_poses()
        common = [k for k in arkit if k in refined]
        if len(common) < 10:
            return
        as_matrix = lambda m: np.asarray(m, np.float64).reshape(4, 4).T  # noqa: E731
        result = alignment.fit_pose_pairs(
            [as_matrix(arkit[k]) for k in common],
            [to_world @ as_matrix(refined[k]) for k in common],
        )
        self.camera_to_world = result.transform
        self.camera_alignment_report = {
            "method": "robust-pose-pairs",
            "pairs": result.total,
            "inliers": result.inliers,
            "medianResidual": round(result.median_residual, 4),
            "transform": [round(v, 6) for v in result.transform.T.reshape(-1)],
        }
        self.log(f"  camera fit  {result.inliers}/{result.total} poses, résidu médian {result.median_residual:.3f} m")

    def build_point_cloud(self) -> None:
        cfg = self.entry.get("point_cloud", {})
        vertices = read_ply_vertices(self.export.point_cloud())
        cloud = PointCloud(
            positions=alignment.apply(alignment.CLOUD_TO_ARKIT, xyz(vertices)),
            colors=np.stack([vertices["red"], vertices["green"], vertices["blue"]], axis=1),
        )

        report: dict[str, Any] = {"method": "none"}
        if self._mesh_world is not None:
            rng = np.random.default_rng(0)
            source = cloud.positions[rng.choice(len(cloud.positions), min(ICP_SOURCE_POINTS, len(cloud.positions)), replace=False)]
            target, normals = alignment.sample_surface(*self._mesh_world, ICP_TARGET_POINTS)
            # Deux départs (aucune correction, recalage caméra) : on garde le meilleur ajustement
            starts = [None] + ([self.camera_to_world] if self.camera_to_world is not None else [])
            tree = cKDTree(target)
            result = max(
                (alignment.icp(source, target, normals, with_scale=cfg.get("icp_scale", False), initial=s) for s in starts),
                key=lambda r: alignment.fit_score(r.transform, source, tree),
            )
            cloud = PointCloud(alignment.apply(result.transform, cloud.positions), cloud.colors)
            report = {
                "method": "icp-point-to-plane",
                "target": "mesh",
                "medianResidualBefore": round(result.median_before, 4),
                "medianResidualAfter": round(result.median_after, 4),
                "inlierRatio": round(result.inlier_ratio, 3),
                "transform": [round(v, 6) for v in result.transform.T.reshape(-1)],
            }

        voxel = cfg.get("voxel_size", 0.01)
        cloud = voxel_downsample(cloud, voxel)
        lo, hi = write_points_bin(self.out / "points.bin", cloud)
        self.manifest["layers"]["pointCloud"] = {
            "url": "points.bin",
            "bytes": (self.out / "points.bin").stat().st_size,
            "count": int(len(cloud.positions)),
            "voxelSize": voxel,
            "boundsMin": lo,
            "boundsMax": hi,
        }
        self.manifest["alignment"]["pointCloud"] = report
        self.log(f"  pointCloud  {len(cloud.positions)} points (ICP {report.get('medianResidualBefore')} -> {report.get('medianResidualAfter')} m)")

    def build_playback(self) -> None:
        playback = self.entry.get("playback")
        if not playback:
            return
        # La vidéo peut venir d'un export à part (vidéo exportée séparément)
        source = self.export
        if playback.get("export_dir"):
            source = SessionExport.open(resolve_dir(self.project_root, playback["export_dir"]), playback.get("arkit_session"))
        video = source.video(playback["video_id"])
        extract_audio(video.mp4, self.out / "audio.m4a")

        # La trajectoire vidéo est en repère ARKit (celui de sa session) -> repère du splat
        transform = self.camera_to_world if playback.get("align_to_world", True) else None
        report = self.camera_alignment_report if transform is not None else {"method": "none"}
        if transform is not None and playback.get("arkit_session"):
            link, link_report = self.arkit_link(playback["arkit_session"])
            transform = transform @ link
            report = {**(report or {}), "arkitLink": link_report}
        path = build_camera_path(video, playback.get("time_offset", 0.0), transform)
        write_json(self.out / "camera_path.json", path)
        self.manifest["alignment"]["camera"] = report
        self.manifest["playback"] = {
            "audioUrl": "audio.m4a",
            "cameraPathUrl": "camera_path.json",
            "duration": video.metadata["duration"],
            "recordedAt": video.metadata["startTime"],
        }
        self.log(f"  playback    {len(path['keyframes'])} keyframes, {path['duration']:.1f} s")

    def build_annotations(self) -> None:
        cfg = self.entry.get("annotations")
        if not cfg:
            return
        source = resolve_path(self.project_root, cfg["source"])
        media_dir = resolve_path(self.project_root, cfg.get("media_dir", "."))
        content = resolve_path(self.project_root, cfg["content_source"]) if cfg.get("content_source") else None
        annotations = read_annotations(source, cfg.get("arkit_session") or self.export.session_id, media_dir, content, cfg.get("media"))

        # Points en repère ARKit (session sans splat) : même recalage que la vidéo
        to_splat = None
        if cfg.get("frame") == "arkit":
            if self.camera_to_world is None:
                raise RuntimeError("annotations en repère ARKit : recalage caméra indisponible")
            to_splat = self.camera_to_world
            if cfg.get("arkit_session"):
                to_splat = to_splat @ self.arkit_link(cfg["arkit_session"])[0]

        # Les médias déjà publiés servent de repli quand leurs fichiers sources ont été retirés du disque
        previous_file = self.out / "annotations.json"
        previous = {
            a["id"]: a for a in json.loads(previous_file.read_text(encoding="utf-8"))["annotations"]
        } if previous_file.exists() else {}
        media_out = self.out / "annotations"
        media_out.mkdir(exist_ok=True)

        items = []
        for a in annotations:
            published = previous.get(a.id)
            has_media = bool(a.images or a.videos or a.documents or (cfg.get("reference_images") and a.reference_image))
            kept = published and (a.missing_media or not has_media) and any(
                published.get(k) for k in ("images", "videos", "documents")
            )
            if a.missing_media and not kept:
                self.log(f"  ! {a.title} : médias absents du disque ({', '.join(a.missing_media)})")
            if kept:
                self.log(f"  = {a.title} : sources absentes, médias déjà publiés conservés")
            images = list(published.get("images", [])) if kept else []
            sources = [] if kept else a.images or ([a.reference_image] if cfg.get("reference_images") and a.reference_image else [])
            for n, image in enumerate(sources, start=1):
                name = f"{a.id[:8].lower()}-{n}.jpg"
                width, height = encode_web_image(image, media_out / name)
                images.append({"url": f"annotations/{name}", "width": width, "height": height, "source": image.name})
            videos = list(published.get("videos", [])) if kept else []
            for n, video in enumerate([] if kept else a.videos, start=1):
                stem = f"{a.id[:8].lower()}-v{n}"
                width, height, duration = encode_web_video(video, media_out / f"{stem}.mp4")
                pw, ph = extract_poster(media_out / f"{stem}.mp4", media_out / f"{stem}.jpg")
                videos.append({
                    "url": f"annotations/{stem}.mp4", "width": width, "height": height, "duration": round(duration, 2),
                    "poster": {"url": f"annotations/{stem}.jpg", "width": pw, "height": ph, "source": video.name},
                    "source": video.name,
                })
            documents = list(published.get("documents", [])) if kept else []
            for n, document in enumerate([] if kept else a.documents, start=1):
                stem = f"{a.id[:8].lower()}-d{n}"
                shutil.copy2(document, media_out / f"{stem}.pdf")
                width, height, pages = render_pdf_thumbnail(document, media_out / f"{stem}.jpg")
                documents.append({
                    "url": f"annotations/{stem}.pdf", "pages": pages,
                    "thumbnail": {"url": f"annotations/{stem}.jpg", "width": width, "height": height, "source": document.name},
                    "source": document.name,
                })
            items.append({
                "id": a.id,
                "title": a.title,
                "colorIndex": self.color_index.get(a.title),
                "text": a.text,
                "kind": a.tool,
                "points": [[round(float(v), 5) for v in p] for p in (
                    alignment.apply(to_splat, np.asarray(a.points, float)) if to_splat is not None and a.points else a.points
                )],
                "closed": a.closed,
                "updatedAt": a.created_at,
                "images": images,
                "videos": videos,
                "documents": documents,
            })
        # Ne retire que les fichiers qu'il a lui-même produits (et qui ne servent plus) : les médias
        # ajoutés à la main dans ce dossier (cités par annotations.config.json) restent en place.
        referenced = {Path(u).name for i in items for m in (*i["images"], *i["videos"], *i["documents"]) for u in _media_urls(m)}
        own_ids = {a.id[:8].lower() for a in annotations}
        for file in media_out.iterdir():
            if GENERATED_MEDIA.match(file.name) and file.name[:8] in own_ids and file.name not in referenced:
                file.unlink()
        write_json(self.out / "annotations.json", {"annotations": items})
        self.manifest["annotations"] = {"url": "annotations.json", "count": len(items)}
        self.log(
            f"  annotations {len(items)} ({sum(len(i['images']) for i in items)} images, "
            f"{sum(len(i['videos']) for i in items)} vidéos, {sum(len(i['documents']) for i in items)} PDF)"
        )

    def arkit_link(self, session: str) -> tuple[np.ndarray, dict[str, Any]]:
        """Repère ARKit d'une autre session du même export -> repère ARKit du splat.

        Les deux sessions ont été capturées au même endroit mais leurs origines
        ARKit diffèrent : ICP point-à-plan entre leurs nuages LiDAR (le décor
        stable contraint le résultat, les zones modifiées sont rejetées).
        """
        if session not in self._links:
            other = SessionExport.open(self.export.root.parent.parent.parent, session)
            if other.session_id == self.export.session_id:
                self._links[session] = (np.eye(4), {"method": "same-session"})
            else:
                source = _lidar_sample(other.point_cloud())
                target = _lidar_sample(self.export.point_cloud())
                result = alignment.register_clouds(source, target)
                report = {
                    "method": "icp-lidar-to-lidar",
                    "session": other.session_id,
                    "medianResidualBefore": round(result.median_before, 4),
                    "medianResidualAfter": round(result.median_after, 4),
                    "inlierRatio": round(result.inlier_ratio, 3),
                    "transform": [round(float(v), 6) for v in result.transform.T.reshape(-1)],
                }
                self._links[session] = (result.transform, report)
                self.log(f"  arkit link  {other.session_id[:8]} -> {self.export.session_id[:8]} : "
                         f"{result.median_before:.3f} -> {result.median_after:.3f} m, {result.inlier_ratio:.0%} appariés")
        return self._links[session]

    def build_registration(self) -> None:
        """Recale la session sur la session de référence (nuages LiDAR, ICP).

        Le splat ne peut pas être ré-écrit sans faire tourner ses harmoniques
        sphériques : la transformation est appliquée à l'affichage, pour toute
        la session (couches et annotations).
        """
        ref_id = self.entry.get("register_to")
        calibrated = self.entry.get("world_transform")
        if calibrated:
            # Transformation calibrée (outil tools/session-registration) : prioritaire
            self.manifest["worldTransform"] = [float(v) for v in calibrated["matrix"]]
            self.manifest["alignment"]["world"] = {"reference": ref_id, "method": "calibrated", "note": calibrated.get("$comment")}
            self.log(f"  registration -> {ref_id} : transformation calibrée (sessions.json)")
            return
        if not ref_id or self.reference_out is None:
            self.manifest["worldTransform"] = IDENTITY
            self.manifest["alignment"].pop("world", None)
            return
        source = read_points_bin(self.out / "points.bin", self.manifest["layers"]["pointCloud"])
        reference = read_manifest(self.reference_out)
        target = read_points_bin(self.reference_out / "points.bin", reference["layers"]["pointCloud"])
        # La cible est exprimée dans le repère commun : on compose avec sa propre transformation
        ref_world = np.asarray(reference.get("worldTransform", IDENTITY), np.float64).reshape(4, 4).T
        target = alignment.apply(ref_world, target)
        # 1. Recalage grossier sur l'ensemble du décor
        coarse = alignment.register_clouds(source, target)
        transform = coarse.transform
        report: dict[str, Any] = {
            "reference": ref_id,
            "coarse": {
                "method": "icp-cloud-to-cloud",
                "medianResidualBefore": round(coarse.median_before, 4),
                "medianResidualAfter": round(coarse.median_after, 4),
                "inlierRatio": round(coarse.inlier_ratio, 3),
            },
        }
        self.log(f"  registration -> {ref_id} : décor {coarse.median_before:.3f} -> {coarse.median_after:.3f} m")

        # 2. Affinage sur un objet resté fixe entre les captures (la table)
        if self.entry.get("register_anchor") == "table":
            fine = self._refine_on_table(source, transform, reference, target, ref_world)
            if fine is not None:
                transform = fine.transform @ transform
                report["anchor"] = {
                    "method": "icp-table-top-luminance",
                    "medianResidualBefore": round(fine.median_before, 4),
                    "medianResidualAfter": round(fine.median_after, 4),
                    "inlierRatio": round(fine.inlier_ratio, 3),
                }
                self.log(f"                table {fine.median_before:.3f} -> {fine.median_after:.3f} m, {fine.inlier_ratio:.0%} appariés")

        self.manifest["worldTransform"] = [round(float(v), 7) for v in transform.T.reshape(-1)]
        self.manifest["alignment"]["world"] = report

    def _refine_on_table(
        self,
        source: np.ndarray,
        coarse: np.ndarray,
        reference: dict[str, Any],
        target: np.ndarray,
        ref_world: np.ndarray,
    ) -> "alignment.IcpResult | None":
        """Plateau de la table dans les deux sessions, puis ICP guidé par la luminosité."""
        ref_annotations = self.reference_out / "annotations.json"
        if not ref_annotations.exists():
            self.log("                (pas d'annotations de référence : hauteur de table inconnue, affinage ignoré)")
            return None
        points = [a["points"][0] for a in json.loads(ref_annotations.read_text(encoding="utf-8"))["annotations"] if a["points"]]
        hint = float(np.mean(alignment.apply(ref_world, np.asarray(points))[:, 1]))

        ref_layer = reference["layers"]["pointCloud"]
        target_colors = read_points_bin_colors(self.reference_out / "points.bin", ref_layer)
        source_colors = read_points_bin_colors(self.out / "points.bin", self.manifest["layers"]["pointCloud"])
        table_ref, lum_ref, h_ref = alignment.segment_table_top(target, target_colors, hint)
        table_src, lum_src, h_src = alignment.segment_table_top(alignment.apply(coarse, source), source_colors, hint)
        self.log(f"                plateau : {len(table_ref)} / {len(table_src)} points, hauteur {h_ref:.3f} / {h_src:.3f} m")
        return alignment.refine_on_anchor(table_src, lum_src, table_ref, lum_ref)

    @staticmethod
    def _photo_alignment_report(photo: PhotogrammetryAsset) -> dict[str, Any]:
        info = photo.metadata["alignmentInfo"]
        return {
            "method": "dür.air alignment matrix",
            "scale": info.get("scale"),
            "avgErrorToArkit": info.get("avgError"),
        }


def _lidar_sample(ply: Path, seed: int = 0) -> np.ndarray:
    """Nuage LiDAR en repère ARKit, sous-échantillonné (voxels de LINK_VOXEL)."""
    vertices = read_ply_vertices(ply)
    if len(vertices) > LINK_SAMPLE_POINTS:
        rng = np.random.default_rng(seed)
        vertices = vertices[np.sort(rng.choice(len(vertices), LINK_SAMPLE_POINTS, replace=False))]
    points = alignment.apply(alignment.CLOUD_TO_ARKIT, xyz(vertices))
    colors = np.zeros((len(points), 3), np.uint8)
    return voxel_downsample(PointCloud(points, colors), LINK_VOXEL).positions
