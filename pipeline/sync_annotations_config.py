"""Crée ou complète web/public/annotations.config.json avec les annotations publiées.

Usage (depuis la racine du projet) :
    python pipeline/sync_annotations_config.py

Chaque annotation publiée (web/public/sessions/<id>/annotations.json) y reçoit une entrée
reprenant ses valeurs actuelles : titre, couleur, description, médias. Le fichier devient
l'inventaire complet des annotations, à modifier à la main.

Les entrées déjà présentes ne sont jamais touchées : relancer le script après un
nouveau build n'ajoute que les annotations nouvelles.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SESSIONS = ROOT / "web" / "public" / "sessions"
CONFIG = ROOT / "web" / "public" / "annotations.config.json"

# Couleurs par défaut du viewer (web/src/ui/annotations/AnnotationOverlay.ts), dans l'ordre des numéros
DEFAULT_PALETTE = ["#4f9066", "#d99a35", "#3f74b5", "#7b5bb5", "#c25a87", "#3e8f93", "#b8613a"]

HELP = {
    "principe": "Lu par le site au chargement : modifier, enregistrer, recharger la page. Tout est facultatif, ce qui n'est pas indiqué garde sa valeur d'origine.",
    "cle": "Chaque annotation est repérée par son titre d'origine (celui de dür.air) ou par les 8 premiers caractères de son identifiant.",
    "title": "Titre affiché.",
    "color": "Couleur CSS (\"#d99a35\", \"rgb(217,154,53)\", \"orange\") ou numéro de la palette ci-dessous.",
    "text": "Description : un texte, ou une liste de paragraphes.",
    "media": "Remplace tous les médias, dans cet ordre ([] pour n'en afficher aucun). Image, vidéo (lue en boucle, sans le son) ou PDF. Un nom de fichier seul vient de web/public/media/ ; sinon, chemin depuis web/public/. Vidéo : { \"file\": \"a.mp4\", \"poster\": \"a.jpg\" } ajoute une image d'attente. PDF : { \"file\": \"a.pdf\", \"thumbnail\": \"a.jpg\", \"pages\": 5 } ajoute une vignette.",
    "hidden": "true : masque l'annotation.",
    "offset": "[x, y, z] : décale l'épingle (mètres, repère de la session, y vers le haut).",
}


def scalar(value) -> bool:
    return not isinstance(value, (dict, list))


def dump(value, level: int = 0, in_list: bool = False) -> str:
    """JSON lisible à la main : un média par ligne, petites listes de nombres en ligne."""
    pad = "  " * level
    if isinstance(value, dict):
        if not value:
            return "{}"
        if in_list and all(scalar(v) for v in value.values()):
            return "{ " + ", ".join(f"{json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in value.items()) + " }"
        body = ",\n".join(
            f"{pad}  {json.dumps(k, ensure_ascii=False)}: "
            + (json.dumps(v, ensure_ascii=False) if k == "palette" else dump(v, level + 1))
            for k, v in value.items()
        )
        return "{\n" + body + "\n" + pad + "}"
    if isinstance(value, list):
        if not value:
            return "[]"
        if all(isinstance(v, (int, float)) for v in value):
            return json.dumps(value)
        body = ",\n".join(f"{pad}  {dump(v, level + 1, True)}" for v in value)
        return "[\n" + body + "\n" + pad + "]"
    return json.dumps(value, ensure_ascii=False)


def media_entries(session_id: str, annotation: dict) -> list:
    """Médias publiés d'une annotation, comme les lit le site (images, vidéos, PDF)."""
    path = lambda url: f"sessions/{session_id}/{url}"
    media: list = [path(i["url"]) for i in annotation.get("images", [])]
    for video in annotation.get("videos", []):
        entry = {"file": path(video["url"])}
        if video.get("poster"):
            entry["poster"] = path(video["poster"]["url"])
        media.append(entry)
    for document in annotation.get("documents", []):
        entry = {"file": path(document["url"])}
        if document.get("thumbnail"):
            entry["thumbnail"] = path(document["thumbnail"]["url"])
        if document.get("pages"):
            entry["pages"] = document["pages"]
        media.append(entry)
    return media


def main() -> int:
    config = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
    palette = config.get("palette") or DEFAULT_PALETTE
    sessions = config.setdefault("sessions", {})

    index = json.loads((SESSIONS / "index.json").read_text(encoding="utf-8"))["sessions"]
    added = 0
    for summary in index:
        session_id = summary["id"]
        path = SESSIONS / session_id / "annotations.json"
        if not path.exists():
            continue
        entries = sessions.setdefault(session_id, {})
        for annotation in json.loads(path.read_text(encoding="utf-8"))["annotations"]:
            title, short_id = annotation["title"], annotation["id"][:8]
            if title in entries or any(k.lower() == short_id.lower() for k in entries):
                continue
            color_index = annotation.get("colorIndex")
            entry = {"title": title}
            if color_index is not None:
                entry["color"] = palette[color_index % len(palette)]
            paragraphs = [p for p in annotation.get("text", "").split("\n\n") if p.strip()]
            # Un seul paragraphe : un simple texte ; plusieurs : une liste ; aucun : un texte vide à remplir
            entry["text"] = paragraphs[0] if len(paragraphs) == 1 else paragraphs or ""
            entry["media"] = media_entries(session_id, annotation)
            entries[title or short_id] = entry
            added += 1
            print(f"  + {session_id} › {title or short_id}")

    ordered = {"$aide": HELP, "palette": palette, "sessions": sessions}
    ordered.update({k: v for k, v in config.items() if k not in ordered and k != "$aide"})
    CONFIG.write_text(dump(ordered) + "\n", encoding="utf-8")
    print(f"✓ {CONFIG.relative_to(ROOT)} : {added} annotation(s) ajoutée(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
