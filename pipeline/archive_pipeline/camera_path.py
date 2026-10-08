"""Conversion d'une trajectoire vidéo dür.air en chemin caméra pour le viewer web.

Les poses ARKit (caméra -> monde, matrice 4x4 column-major, Y-up, caméra
regardant vers -Z) correspondent directement à la convention three.js.

Les horodatages de l'export sont tronqués à la seconde. On reconstruit un temps
continu relatif au début de la vidéo :
  1. la fraction de seconde du début de vidéo est bornée par la contrainte
     floor(start) + a + duration = floor(end) + b, avec a, b dans [0, 1) ;
     on prend le milieu de l'intervalle admissible pour a ;
  2. les poses partageant une même seconde sont réparties uniformément dans
     cette seconde.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import datetime
from typing import Any

import numpy as np

from .export_reader import VideoAsset


def _parse_ts(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def estimate_start_fraction(start: float, end: float, duration: float) -> float:
    """Fraction de seconde la plus probable du début réel de la vidéo."""
    lo = max(0.0, end - start - duration)
    hi = min(1.0, lo + 1.0)
    return (lo + hi) / 2 if lo < 1.0 else 0.0


def rotation_to_quaternion(m: list[float]) -> list[float]:
    """Matrice 4x4 column-major -> quaternion [x, y, z, w] normalisé."""
    r = lambda row, col: m[col * 4 + row]  # noqa: E731
    m00, m11, m22 = r(0, 0), r(1, 1), r(2, 2)
    trace = m00 + m11 + m22
    if trace > 0:
        s = 0.5 / math.sqrt(trace + 1.0)
        q = [(r(2, 1) - r(1, 2)) * s, (r(0, 2) - r(2, 0)) * s, (r(1, 0) - r(0, 1)) * s, 0.25 / s]
    elif m00 > m11 and m00 > m22:
        s = 2.0 * math.sqrt(1.0 + m00 - m11 - m22)
        q = [0.25 * s, (r(0, 1) + r(1, 0)) / s, (r(0, 2) + r(2, 0)) / s, (r(2, 1) - r(1, 2)) / s]
    elif m11 > m22:
        s = 2.0 * math.sqrt(1.0 + m11 - m00 - m22)
        q = [(r(0, 1) + r(1, 0)) / s, 0.25 * s, (r(1, 2) + r(2, 1)) / s, (r(0, 2) - r(2, 0)) / s]
    else:
        s = 2.0 * math.sqrt(1.0 + m22 - m00 - m11)
        q = [(r(0, 2) + r(2, 0)) / s, (r(1, 2) + r(2, 1)) / s, 0.25 * s, (r(1, 0) - r(0, 1)) / s]
    n = math.sqrt(sum(c * c for c in q))
    return [c / n for c in q]


def _apply_world_transform(transform: np.ndarray, m: list[float]) -> list[float]:
    """Applique T (4x4) à une pose column-major ; l'éventuelle échelle de T
    est retirée de la rotation pour garder une caméra orthonormée."""
    pose = transform @ np.asarray(m, np.float64).reshape(4, 4).T
    pose[:3, :3] /= np.linalg.norm(pose[:3, :3], axis=0)
    return pose.T.reshape(-1).tolist()


def build_camera_path(
    video: VideoAsset,
    time_offset: float = 0.0,
    world_transform: np.ndarray | None = None,
) -> dict[str, Any]:
    """`world_transform` : recalage ARKit -> repère de référence (splat)."""
    meta = video.metadata
    duration = float(meta["duration"])
    start = _parse_ts(meta["startTime"])
    end = _parse_ts(meta["endTime"])
    t0 = start + estimate_start_fraction(start, end, duration)

    # Suppression des doublons consécutifs (même transform)
    points: list[dict[str, Any]] = []
    for p in video.trajectory["trajectoryPoints"]:
        if not points or points[-1]["transform"] != p["transform"]:
            points.append(p)

    by_second: dict[float, list[dict[str, Any]]] = defaultdict(list)
    for p in points:
        by_second[_parse_ts(p["timestamp"])].append(p)

    keyframes = []
    for second in sorted(by_second):
        group = by_second[second]
        for i, p in enumerate(group):
            t = second + (i + 0.5) / len(group) - t0 + time_offset
            m = p["transform"]
            if world_transform is not None:
                m = _apply_world_transform(world_transform, m)
            keyframes.append({
                "t": round(min(max(t, 0.0), duration), 4),
                "position": [round(v, 5) for v in m[12:15]],
                "quaternion": [round(v, 6) for v in rotation_to_quaternion(m)],
            })

    first = points[0]
    fy = first["intrinsics"][4]
    height = first["imageResolution"]["height"]
    width = first["imageResolution"]["width"]

    return {
        "coordinateSystem": "Y-up, right-handed, meters (repère du splat)",
        "videoId": meta["id"],
        "duration": duration,
        "fovY": round(math.degrees(2 * math.atan(height / (2 * fy))), 3),
        "aspect": round(width / height, 5),
        "keyframes": keyframes,
    }
