"""Préparation d'un nuage de points pour le web.

Format binaire `points.bin` (little-endian), N points :
    [N × 3 × uint16]  positions quantifiées dans la boîte [boundsMin, boundsMax]
    [N × 3 × uint8 ]  couleurs RGB
Décodage : p = boundsMin + (q / 65535) × (boundsMax − boundsMin).
Sur ~10 m d'emprise, la précision est de ~0,15 mm.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class PointCloud:
    positions: np.ndarray  # (N, 3) float64
    colors: np.ndarray  # (N, 3) uint8


def voxel_downsample(cloud: PointCloud, voxel: float) -> PointCloud:
    """Un point par voxel (le plus proche du centre du voxel)."""
    keys = np.floor(cloud.positions / voxel).astype(np.int64)
    offset = np.linalg.norm(cloud.positions / voxel - keys - 0.5, axis=1)
    order = np.argsort(offset, kind="stable")
    # Clé 1D (21 bits par axe) : bien plus rapide qu'un np.unique(axis=0)
    k = keys - keys.min(0)
    if k.max() >= 1 << 21:
        raise ValueError("nuage trop étendu pour la taille de voxel")
    packed = (k[:, 0] << 42) | (k[:, 1] << 21) | k[:, 2]
    _, first = np.unique(packed[order], return_index=True)
    keep = np.sort(order[first])
    return PointCloud(cloud.positions[keep], cloud.colors[keep])


def write_points_bin(path: Path, cloud: PointCloud) -> tuple[list[float], list[float]]:
    """Écrit le nuage quantifié ; retourne (boundsMin, boundsMax)."""
    lo = cloud.positions.min(0)
    hi = cloud.positions.max(0)
    span = np.where(hi > lo, hi - lo, 1.0)
    q = np.round((cloud.positions - lo) / span * 65535).astype("<u2")
    with path.open("wb") as f:
        f.write(q.tobytes())
        f.write(cloud.colors.astype(np.uint8).tobytes())
    return lo.tolist(), hi.tolist()


def read_points_bin(path: Path, layer: dict) -> np.ndarray:
    """Positions (N, 3) d'un points.bin, décrit par son entrée de manifest."""
    n = layer["count"]
    q = np.fromfile(path, dtype="<u2", count=n * 3).reshape(n, 3).astype(np.float64)
    lo = np.asarray(layer["boundsMin"])
    hi = np.asarray(layer["boundsMax"])
    return lo + q / 65535 * np.where(hi > lo, hi - lo, 1.0)


def read_points_bin_colors(path: Path, layer: dict) -> np.ndarray:
    """Couleurs RGB (N, 3) uint8 d'un points.bin."""
    n = layer["count"]
    return np.fromfile(path, dtype=np.uint8, count=n * 9)[n * 6:].reshape(n, 3)
