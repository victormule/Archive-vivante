"""Génère les assets web des sessions déclarées dans sessions.json.

Usage (depuis la racine du projet, avec l'environnement .venv) :
    python pipeline/build_sessions.py            # toutes les sessions
    python pipeline/build_sessions.py j1-s1      # une session
    python pipeline/build_sessions.py j1-s1 --only annotations   # une étape

Sortie : web/public/sessions/<id>/
           manifest.json, splat.spz, mesh.glb, points.bin, audio.m4a, camera_path.json,
           annotations.json + annotations/*.jpg
         web/public/sessions/index.json (sessions + réglages de scène communs)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from archive_pipeline.annotations import read_titles
from archive_pipeline.builder import STEPS, SessionBuilder, write_json
from archive_pipeline.export_reader import ExportError, SessionExport, resolve_dir, resolve_path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CATALOG = Path(__file__).resolve().parent / "sessions.json"
OUTPUT_ROOT = PROJECT_ROOT / "web" / "public" / "sessions"


def natural_key(text: str) -> list:
    return [int(c) if c.isdigit() else c.casefold() for c in re.split(r"(\d+)", text)]


def annotation_color_index(catalog: list[dict]) -> dict[str, int]:
    """Indice de couleur par titre, commun à toutes les sessions du catalogue.

    Les couleurs déjà publiées sont conservées ; les nouveaux titres prennent
    les indices suivants, dans l'ordre du catalogue (puis des titres). Une
    nouvelle session ne change donc jamais une couleur existante.
    """
    index: dict[str, int] = {}
    for path in OUTPUT_ROOT.glob("*/annotations.json"):
        for a in json.loads(path.read_text(encoding="utf-8"))["annotations"]:
            if a.get("title") and a.get("colorIndex") is not None:
                index.setdefault(a["title"], a["colorIndex"])
    for entry in catalog:
        cfg = entry.get("annotations")
        if not cfg:
            continue
        try:
            source = resolve_path(PROJECT_ROOT, cfg["source"])
        except ExportError:
            print(f"  ! {entry['id']} : source d'annotations absente ({cfg['source']}), couleurs publiées conservées")
            continue
        for title in sorted((t for t in read_titles(source, cfg.get("arkit_session")) if t), key=natural_key):
            if title not in index:
                index[title] = max(index.values(), default=-1) + 1
    return index


def scene_config(document: dict) -> dict:
    """Réglages de scène communs (vue d'arrivée, axe de rotation), sans les commentaires."""
    def clean(value):
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items() if not k.startswith("$")}
        return value
    scene = clean(document.get("scene", {}))
    return {
        "initialView": scene.get("initial_view"),
        "orbit": scene.get("orbit"),
    }


def open_export(entry: dict, only: set[str]) -> SessionExport:
    """Export brut de la session. Pour reconstruire seulement les annotations, l'export
    brut (volumineux, parfois supprimé) n'est pas nécessaire : l'export d'annotations
    contient les mêmes métadonnées de projet et de session."""
    try:
        return SessionExport.open(resolve_dir(PROJECT_ROOT, entry["export_dir"]), entry.get("arkit_session"))
    except ExportError:
        annotations = entry.get("annotations")
        if not (only and only <= {"annotations"} and annotations):
            raise
        source = resolve_path(PROJECT_ROOT, annotations["source"])
        if not source.is_dir():
            raise
        print(f"  ! export brut absent ({entry['export_dir']}) : métadonnées lues dans l'export d'annotations")
        return SessionExport.open(source, entry.get("arkit_session"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ids", nargs="*", help="Identifiants de sessions à construire (défaut : toutes)")
    parser.add_argument("--only", nargs="+", choices=STEPS, help="Étapes à reconstruire (le reste du manifest est conservé)")
    args = parser.parse_args()

    document = json.loads(CATALOG.read_text(encoding="utf-8"))
    catalog = document["sessions"]
    selected = [s for s in catalog if not args.ids or s["id"] in args.ids]
    if args.ids and len(selected) != len(args.ids):
        print(f"Sessions inconnues : {set(args.ids) - {s['id'] for s in selected}}", file=sys.stderr)
        return 1

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    color_index = annotation_color_index(catalog)
    # Les sessions de référence d'abord : les recalages en dépendent
    selected.sort(key=lambda s: "register_to" in s)
    for entry in selected:
        print(f"→ {entry['id']} ({entry['export_dir']})")
        export = open_export(entry, set(args.only or ()))
        reference = entry.get("register_to")
        SessionBuilder(
            entry, export, OUTPUT_ROOT / entry["id"], PROJECT_ROOT,
            color_index=color_index,
            reference_out=OUTPUT_ROOT / reference if reference else None,
        ).build(set(args.only) if args.only else None)

    # L'index liste toutes les sessions déjà construites
    index = [
        {k: m.get(k) for k in ("id", "title", "day", "index", "startDate")}
        for m in (json.loads(p.read_text(encoding="utf-8")) for p in sorted(OUTPUT_ROOT.glob("*/manifest.json")))
    ]
    write_json(OUTPUT_ROOT / "index.json", {
        "scene": scene_config(document),
        "sessions": sorted(index, key=lambda s: (s["day"], s["index"])),
    })
    print(f"✓ {len(selected)} session(s) → {OUTPUT_ROOT.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
