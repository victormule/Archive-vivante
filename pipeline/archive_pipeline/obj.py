"""Lecture de fichiers Wavefront OBJ."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class ObjMesh:
    positions: np.ndarray  # (N, 3) float64
    uvs: np.ndarray | None  # (N, 2) float64, convention OBJ (origine en bas)
    normals: np.ndarray | None  # (N, 3) float64
    faces: np.ndarray  # (M, 3) int64, indices dans les tableaux ci-dessus
    material_lib: str | None


def read_obj(path: Path) -> ObjMesh:
    """Lit un OBJ et le ré-indexe : un sommet par triplet unique v/vt/vn.

    Les polygones sont triangulés en éventail.
    """
    v: list[list[float]] = []
    vt: list[list[float]] = []
    vn: list[list[float]] = []
    corners: dict[tuple[int, int, int], int] = {}
    faces: list[list[int]] = []
    mtllib = None

    def resolve(i: str, n: int) -> int:
        k = int(i)
        return k - 1 if k > 0 else n + k

    with path.open(encoding="utf-8") as f:
        for line in f:
            tag, _, rest = line.partition(" ")
            if tag == "v":
                v.append([float(x) for x in rest.split()[:3]])
            elif tag == "vt":
                vt.append([float(x) for x in rest.split()[:2]])
            elif tag == "vn":
                vn.append([float(x) for x in rest.split()[:3]])
            elif tag == "mtllib":
                mtllib = rest.strip()
            elif tag == "f":
                ids = []
                for tok in rest.split():
                    parts = (tok.split("/") + ["", ""])[:3]
                    key = (
                        resolve(parts[0], len(v)),
                        resolve(parts[1], len(vt)) if parts[1] else -1,
                        resolve(parts[2], len(vn)) if parts[2] else -1,
                    )
                    ids.append(corners.setdefault(key, len(corners)))
                faces.extend([ids[0], ids[k], ids[k + 1]] for k in range(1, len(ids) - 1))

    keys = np.array(list(corners.keys()), dtype=np.int64)
    positions = np.asarray(v, np.float64)[keys[:, 0]]
    uvs = np.asarray(vt, np.float64)[keys[:, 1]] if vt and (keys[:, 1] >= 0).all() else None
    normals = np.asarray(vn, np.float64)[keys[:, 2]] if vn and (keys[:, 2] >= 0).all() else None
    return ObjMesh(positions, uvs, normals, np.asarray(faces, np.int64), mtllib)


def read_mtl_diffuse_map(path: Path) -> Path | None:
    """Chemin de la texture diffuse (map_Kd) du premier matériau."""
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("map_Kd"):
            return path.parent / line.split(maxsplit=1)[1].strip()
    return None
