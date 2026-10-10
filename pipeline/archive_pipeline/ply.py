"""Lecture minimale de fichiers PLY (élément `vertex` uniquement).

Supporte `binary_little_endian` et `ascii`. Les autres éléments (faces…)
sont ignorés : seuls les sommets nous intéressent pour les nuages de points
et les splats.

Les nuages LiDAR dür.air sont en ASCII (plusieurs millions de points,
centaines de Mo) : leur lecture est mise en cache au format numpy, à côté
du pipeline (`pipeline/.cache/`), clé = chemin + taille + date du fichier.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path
from typing import Iterator

import numpy as np

CACHE_DIR = Path(__file__).resolve().parents[1] / ".cache"

_PLY_TYPES = {
    "char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1",
    "short": "i2", "int16": "i2", "ushort": "u2", "uint16": "u2",
    "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4",
    "float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
    "ulong": "u8",
}


def read_ply_vertices(path: Path, cache: bool = True) -> np.ndarray:
    """Retourne les sommets sous forme de tableau structuré numpy."""
    if not cache:
        return _read(path)
    stat = path.stat()
    key = hashlib.sha1(f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode()).hexdigest()[:16]
    cached = CACHE_DIR / f"{path.stem[:40]}-{key}.npy"
    if cached.exists():
        return np.load(cached)
    vertices = _read(path)
    if vertices.nbytes > 50e6:  # seuls les gros fichiers valent la peine
        CACHE_DIR.mkdir(exist_ok=True)
        np.save(cached, vertices)
    return vertices


def _read_header(f, path: Path) -> tuple[str | None, int, list[tuple[str, str]]]:
    """Lit l'en-tête PLY ; retourne (format, nombre de sommets, champs des sommets)."""
    if f.readline().strip() != b"ply":
        raise ValueError(f"{path} n'est pas un fichier PLY")
    fmt = None
    count = 0
    fields: list[tuple[str, str]] = []
    current = None
    while True:
        line = f.readline().decode("ascii", "replace").strip()
        if line == "end_header":
            break
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[0] == "element":
            current = parts[1]
            if current == "vertex":
                count = int(parts[2])
        elif parts[0] == "property" and current == "vertex":
            if parts[1] == "list":
                raise ValueError(f"{path}: propriété liste sur vertex non supportée")
            fields.append((parts[2], _PLY_TYPES[parts[1]]))
    return fmt, count, fields


def iter_ply_vertices(path: Path, chunk_bytes: int = 16 << 20, stride: int = 1) -> Iterator[np.ndarray]:
    """Sommets par blocs (tableaux structurés), à mémoire bornée ; `stride` : un sommet sur n.

    Pour les très gros nuages (ASCII de près d'1 Go, plus que la RAM disponible
    une fois convertis d'un bloc) : chaque bloc de lignes est converti seul.
    """
    with path.open("rb") as f:
        fmt, count, fields = _read_header(f, path)
        if fmt == "binary_little_endian":
            dtype = np.dtype([(n, "<" + t) for n, t in fields])
            rows = max(1, chunk_bytes // dtype.itemsize)
            remaining = count
            while remaining > 0:
                n = min(rows, remaining)
                yield np.frombuffer(f.read(dtype.itemsize * n), dtype=dtype, count=n)[::stride]
                remaining -= n
            return
        if fmt != "ascii":
            raise ValueError(f"{path}: format PLY non supporté ({fmt})")
        dtype = np.dtype(fields)
        remaining = count
        while remaining > 0:
            lines = f.readlines(chunk_bytes)
            if not lines:
                raise ValueError(f"{path}: fichier tronqué ({remaining} sommets manquants)")
            lines = lines[:remaining]
            remaining -= len(lines)
            # Sous-échantillonnage avant conversion : la conversion du texte domine le temps de lecture
            lines = lines[::stride]
            table = np.loadtxt(io.BytesIO(b"".join(lines)), dtype=np.float64, ndmin=2)
            out = np.empty(len(lines), dtype=dtype)
            for i, (name, _) in enumerate(fields):
                out[name] = table[:, i]
            yield out


def _read(path: Path) -> np.ndarray:
    with path.open("rb") as f:
        fmt, count, fields = _read_header(f, path)

        if fmt == "binary_little_endian":
            dtype = np.dtype([(n, "<" + t) for n, t in fields])
            return np.frombuffer(f.read(dtype.itemsize * count), dtype=dtype, count=count)

        if fmt == "ascii":
            dtype = np.dtype(fields)
            # Analyseur C de numpy (rapide), limité aux lignes de sommets
            table = np.loadtxt(f, dtype=np.float64, max_rows=count, ndmin=2)
            out = np.empty(count, dtype=dtype)
            for i, (name, _) in enumerate(fields):
                out[name] = table[:, i]
            return out

        raise ValueError(f"{path}: format PLY non supporté ({fmt})")


def xyz(vertices: np.ndarray) -> np.ndarray:
    return np.stack([vertices["x"], vertices["y"], vertices["z"]], axis=1).astype(np.float64)
