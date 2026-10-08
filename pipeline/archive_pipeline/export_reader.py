"""Lecture de la structure d'un export dür.air.

Arborescence attendue :

    <export_dir>/<Project ... _export_...>/
        project_metadata.json
        sessions/<SESSION_UUID>/
            session_metadata.json
            gaussian/<MODEL_UUID>.ply + .json
            videos/video_<ID>.mp4 + _metadata.json + _trajectory.json
            ...
"""

from __future__ import annotations

import json
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ExportError(RuntimeError):
    """Export incomplet ou structure inattendue."""


def resolve_dir(parent: Path, name: str) -> Path:
    """Trouve un sous-dossier quelle que soit sa normalisation Unicode.

    Les exports venant d'iOS/macOS ont des noms en NFD ("Journée"),
    alors que les chemins saisis sont généralement en NFC ("Journée").
    """
    target = unicodedata.normalize("NFC", name)
    for child in parent.iterdir():
        if child.is_dir() and unicodedata.normalize("NFC", child.name) == target:
            return child
    raise ExportError(f"{parent / name} introuvable")


def resolve_path(root: Path, relative: str) -> Path:
    """Résout un chemin relatif segment par segment, tolérant à la normalisation Unicode."""
    path = root
    for part in Path(relative).parts:
        if part in (".", ""):
            continue
        candidate = path / part
        if candidate.exists():
            path = candidate
            continue
        target = unicodedata.normalize("NFC", part)
        match = next((c for c in path.iterdir() if unicodedata.normalize("NFC", c.name) == target), None)
        if match is None:
            raise ExportError(f"{path / part} introuvable")
        path = match
    return path


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


@dataclass(frozen=True)
class VideoAsset:
    id: str
    mp4: Path
    metadata: dict[str, Any]
    trajectory: dict[str, Any]


@dataclass(frozen=True)
class GaussianAsset:
    ply: Path
    metadata: dict[str, Any]


@dataclass(frozen=True)
class PhotogrammetryAsset:
    obj: Path
    mtl: Path
    metadata: dict[str, Any]

    @property
    def alignment_matrix(self) -> list[float]:
        """Matrice 4x4 column-major : repère du modèle -> repère monde (splat)."""
        return self.metadata["alignmentInfo"]["transformMatrix"]

    def camera_poses(self) -> dict[str, list[float]]:
        """Poses raffinées (repère du modèle) : frame_id -> matrice column-major."""
        return {p["frameID"]: p["transform"]["values"] for p in self.metadata.get("sourceCameraPoses", [])}


@dataclass(frozen=True)
class SessionExport:
    root: Path
    project: dict[str, Any]
    session: dict[str, Any]

    @classmethod
    def open(cls, export_dir: Path, session: str | None = None) -> "SessionExport":
        """`session` : préfixe de l'identifiant ARKit, requis si l'export en contient plusieurs."""
        projects = sorted(p for p in export_dir.glob("*_export_*") if p.is_dir())
        if len(projects) != 1:
            raise ExportError(f"{export_dir}: attendu 1 dossier d'export, trouvé {len(projects)}")
        project_dir = projects[0]

        sessions = sorted(p for p in (project_dir / "sessions").iterdir() if p.is_dir())
        if session:
            sessions = [p for p in sessions if p.name.upper().startswith(session.upper())]
        if len(sessions) != 1:
            hint = "" if session else " (préciser la session ARKit)"
            raise ExportError(f"{project_dir}: attendu 1 session{hint}, trouvé {len(sessions)}")
        root = sessions[0]

        return cls(
            root=root,
            project=read_json(project_dir / "project_metadata.json"),
            session=read_json(root / "session_metadata.json"),
        )

    @property
    def session_id(self) -> str:
        return self.session["sessionID"]

    def gaussian(self) -> GaussianAsset:
        plys = sorted((self.root / "gaussian").glob("*.ply"))
        if not plys:
            raise ExportError(f"{self.root}: aucun splat dans gaussian/")
        ply = plys[0]
        return GaussianAsset(ply=ply, metadata=read_json(ply.with_suffix(".json")))

    def photogrammetry(self) -> PhotogrammetryAsset:
        objs = sorted((self.root / "photogrammetry").glob("*.obj"))
        if not objs:
            raise ExportError(f"{self.root}: aucun modèle dans photogrammetry/")
        obj = objs[0]
        return PhotogrammetryAsset(
            obj=obj,
            mtl=obj.with_suffix(".mtl"),
            metadata=read_json(obj.parent / f"{obj.stem}_metadata.json"),
        )

    def point_cloud(self) -> Path:
        clouds = sorted((self.root / "scene").glob("sparse_cloud_*.ply"))
        if not clouds:
            raise ExportError(f"{self.root}: aucun nuage dans scene/")
        return clouds[0]

    def capture_poses(self) -> dict[str, list[float]]:
        """Poses ARKit des photos de capture : frame_id -> matrice 4x4 column-major."""
        poses = {}
        for f in sorted((self.root / "captures" / "poses").glob("*.json")):
            d = read_json(f)
            poses[d["frame_id"]] = [x for column in d["transform"] for x in column]
        return poses

    def video(self, video_id: str) -> VideoAsset:
        base = self.root / "videos" / f"video_{video_id}"
        mp4 = base.with_suffix(".mp4")
        if not mp4.exists():
            raise ExportError(f"{mp4} introuvable")
        return VideoAsset(
            id=video_id,
            mp4=mp4,
            metadata=read_json(base.parent / f"{base.name}_metadata.json"),
            trajectory=read_json(base.parent / f"{base.name}_trajectory.json"),
        )
