"""Lecture des annotations spatialisées dür.air.

Source : un export d'annotations (dossier ou .zip) contenant
`sessions/<SESSION_UUID>/annotations/annotation_<ID>.json`.

Les points 3D (`C_trace_2d_et_3d.contour_3d`) sont déjà exprimés dans le
repère du splat : ils sont posés sur le modèle aligné (vérifié : < 1,5 cm de
la surface photogrammétrique).

Médias : les images d'une annotation sont associées par son titre, dans
`media_dir` : `<titre>.<ext>` ou `<titre>-<n>.<ext>` (jpg, jpeg, png, webp).
Quand les noms de fichiers ne suivent pas les titres, `media` les associe
explicitement : {titre: [fichiers…]}. Chaque fichier est rangé selon son
extension : image, vidéo (mp4, mov, m4v, webm) ou document PDF.

Une même annotation peut être reposée dans plusieurs sessions (même titre,
autre emplacement). Le contenu (texte) peut alors être repris d'un export de
référence via `content_source` : seul l'emplacement vient de la session.

Sans image associée par titre, l'image de référence de l'export (la vue de
la caméra au moment de l'annotation) peut servir d'illustration.
"""

from __future__ import annotations

import json
import re
import unicodedata
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm"}
DOCUMENT_EXTENSIONS = {".pdf"}


@dataclass(frozen=True)
class Annotation:
    id: str
    title: str
    text: str
    points: list[list[float]]
    closed: bool
    tool: str
    created_at: str | None
    images: list[Path] = field(default_factory=list)
    videos: list[Path] = field(default_factory=list)
    documents: list[Path] = field(default_factory=list)
    # Vue caméra au moment de l'annotation (exports en dossier uniquement)
    reference_image: Path | None = None


def _iter_annotation_json(source: Path, session_id: str | None = None) -> Iterator[tuple[dict[str, Any], Path | None]]:
    """(annotation, dossier des annotations) d'une session (ou de toutes si `session_id` est None).
    Le dossier n'est connu que pour une source en dossier (None pour un .zip)."""
    session = re.escape(session_id) if session_id else "[^/]+"
    pattern = re.compile(rf"sessions/{session}[^/]*/annotations/annotation_[^/]+\.json$", re.IGNORECASE)
    if source.suffix.lower() == ".zip":
        with zipfile.ZipFile(source) as z:
            for name in sorted(z.namelist()):
                if pattern.search(name):
                    yield json.loads(z.read(name)), None
    else:
        for path in sorted(source.rglob("annotation_*.json")):
            if pattern.search(path.as_posix()):
                yield json.loads(path.read_text(encoding="utf-8")), path.parent


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def _text(user: dict[str, Any]) -> str:
    """Description + valeurs des champs personnalisés, dans l'ordre de saisie."""
    parts = [user.get("description", "")]
    parts += [f.get("valeur", "") for f in user.get("champs_personnalises", [])]
    return "\n\n".join(_nfc(p).strip() for p in parts if p and p.strip())


def find_images(media_dir: Path, title: str) -> list[Path]:
    """`Doc4` -> [Doc4.jpg] ou [Doc4-1.jpeg, Doc4-2.jpeg, …] (tri numérique)."""
    if not title or not media_dir.is_dir():
        return []
    pattern = re.compile(rf"^{re.escape(_nfc(title).casefold())}(?:-(\d+))?$")
    found: list[tuple[int, Path]] = []
    for path in media_dir.iterdir():
        if path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        match = pattern.match(_nfc(path.stem).casefold())
        if match:
            found.append((int(match.group(1) or 0), path))
    return [p for _, p in sorted(found)]


def split_media(files: list[Path]) -> tuple[list[Path], list[Path], list[Path]]:
    """Fichiers -> (images, vidéos, documents), dans l'ordre donné."""
    by_kind = lambda extensions: [f for f in files if f.suffix.lower() in extensions]
    return by_kind(IMAGE_EXTENSIONS), by_kind(VIDEO_EXTENSIONS), by_kind(DOCUMENT_EXTENSIONS)


def read_titles(source: Path, session_id: str | None = None) -> set[str]:
    """Titres des annotations d'un export (d'une session, ou de toutes)."""
    return {
        _nfc(d.get("B_description_utilisateur", {}).get("titre", "")).strip()
        for d, _ in _iter_annotation_json(source, session_id)
    }


def read_annotations(
    source: Path,
    session_id: str,
    media_dir: Path | None = None,
    content_source: Path | None = None,
    media: dict[str, list[str]] | None = None,
) -> list[Annotation]:
    """`media` : fichiers (relatifs à `media_dir`) associés explicitement à un titre."""
    explicit = {_nfc(title).casefold(): names for title, names in (media or {}).items()}
    reference: dict[str, str] = {}
    if content_source:
        for data, _ in _iter_annotation_json(content_source):
            user = data.get("B_description_utilisateur", {})
            reference[_nfc(user.get("titre", "")).strip()] = _text(user)

    result = []
    for data, folder in _iter_annotation_json(source, session_id):
        info = data["A_info_generales"]
        user = data.get("B_description_utilisateur", {})
        contour = data["C_trace_2d_et_3d"]["contour_3d"]
        title = _nfc(user.get("titre", "")).strip()
        if media_dir and title.casefold() in explicit:
            images, videos, documents = split_media([_media_file(media_dir, n) for n in explicit[title.casefold()]])
        else:
            images, videos, documents = (find_images(media_dir, title) if media_dir else []), [], []
        result.append(Annotation(
            id=info["id"],
            title=title,
            text=reference.get(title) or _text(user),
            points=[[p["x"], p["y"], p["z"]] for p in contour["points"]],
            closed=bool(contour.get("forme_fermee", False)),
            tool=info.get("outil_utilise", "point"),
            created_at=user.get("date_mise_a_jour") or info.get("timestamp_creation"),
            images=images,
            videos=videos,
            documents=documents,
            reference_image=_reference_image(folder, info),
        ))
    return sorted(result, key=lambda a: (a.title.casefold(), a.id))


def _media_file(media_dir: Path, name: str) -> Path:
    """Fichier d'un dossier, quelle que soit la normalisation Unicode de son nom."""
    path = media_dir / name
    if path.exists():
        return path
    target = _nfc(name)
    for child in media_dir.iterdir():
        if _nfc(child.name) == target:
            return child
    raise FileNotFoundError(f"média d'annotation introuvable : {path}")


def _reference_image(folder: Path | None, info: dict[str, Any]) -> Path | None:
    relative = info.get("image_reference")
    if folder is None or not relative:
        return None
    path = folder / relative
    return path if path.exists() else None
