"""Recalage géométrique entre les différentes représentations d'une session.

Repère de référence : celui du Gaussian splat, identique à celui de la
photogrammétrie alignée (le splat est construit à partir du maillage
photogrammétrique aligné). Les données ARKit brutes en diffèrent d'environ
2° / 25 cm (erreur de l'alignement photo ↔ AR) :

- nuage LiDAR : ICP point-à-plan sur la surface photogrammétrique
  (meilleure coïncidence géométrique visible) ;
- trajectoires caméra : ajustement robuste sur les paires de poses
  (ARKit des captures ↔ poses photogrammétriques raffinées).

Les deux estimations, indépendantes, concordent à quelques centimètres.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

# Le nuage dür.air est exporté en Z-up : (x, y, z)_arkit = (x, z, -y)_nuage
CLOUD_TO_ARKIT = np.array([
    [1, 0, 0, 0],
    [0, 0, 1, 0],
    [0, -1, 0, 0],
    [0, 0, 0, 1],
], dtype=np.float64)


def apply(m: np.ndarray, points: np.ndarray) -> np.ndarray:
    return points @ m[:3, :3].T + m[:3, 3]


def sample_surface(
    vertices: np.ndarray, faces: np.ndarray, count: int, seed: int = 0
) -> tuple[np.ndarray, np.ndarray]:
    """Échantillonnage uniforme (par aire) d'un maillage -> (points, normales)."""
    rng = np.random.default_rng(seed)
    a, b, c = (vertices[faces[:, i]] for i in range(3))
    cross = np.cross(b - a, c - a)
    areas = 0.5 * np.linalg.norm(cross, axis=1)
    valid = areas > 0
    a, b, c, cross, areas = a[valid], b[valid], c[valid], cross[valid], areas[valid]
    idx = rng.choice(len(areas), size=count, p=areas / areas.sum())
    u, v = rng.random((2, count))
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    points = a[idx] + u[:, None] * (b[idx] - a[idx]) + v[:, None] * (c[idx] - a[idx])
    normals = cross[idx] / (2 * areas[idx, None])
    return points, normals


def umeyama(src: np.ndarray, dst: np.ndarray, with_scale: bool) -> np.ndarray:
    """Transformation (similitude ou rigide) minimisant ||dst - T(src)||²."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    s, d = src - mu_s, dst - mu_d
    u, sig, vt = np.linalg.svd(d.T @ s / len(src))
    e = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        e[2, 2] = -1
    r = u @ e @ vt
    scale = (sig * np.diag(e)).sum() / s.var(0).sum() if with_scale else 1.0
    m = np.eye(4)
    m[:3, :3] = scale * r
    m[:3, 3] = mu_d - scale * r @ mu_s
    return m


def _point_to_plane_step(src: np.ndarray, dst: np.ndarray, normals: np.ndarray, with_scale: bool) -> np.ndarray:
    """Pas linéarisé (petits angles) minimisant sum(n·(T(p) - q))²."""
    center = src.mean(0)
    p = src - center
    cols = [np.cross(p, normals), normals]
    if with_scale:
        cols.append(np.einsum("ij,ij->i", p, normals)[:, None])
    a = np.hstack(cols)
    b = np.einsum("ij,ij->i", dst - src, normals)
    x = np.linalg.lstsq(a, b, rcond=None)[0]
    w, t = x[:3], x[3:6]
    ds = x[6] if with_scale else 0.0
    # Rotation exacte (Rodrigues) à partir du vecteur w
    theta = np.linalg.norm(w)
    k = np.array([[0, -w[2], w[1]], [w[2], 0, -w[0]], [-w[1], w[0], 0]]) / (theta or 1)
    r = np.eye(3) + np.sin(theta) * k + (1 - np.cos(theta)) * k @ k
    m = np.eye(4)
    m[:3, :3] = (1 + ds) * r
    m[:3, 3] = center + t - m[:3, :3] @ center
    return m


def fit_score(transform: np.ndarray, source: np.ndarray, tree: cKDTree, tolerance: float = 0.02) -> float:
    """Part des points source à moins de `tolerance` de la cible."""
    return float(np.mean(tree.query(apply(transform, source))[0] < tolerance))


@dataclass(frozen=True)
class IcpResult:
    transform: np.ndarray
    median_before: float
    median_after: float
    inlier_ratio: float


def icp(
    source: np.ndarray,
    target: np.ndarray,
    target_normals: np.ndarray | None = None,
    *,
    max_distance: float = 0.5,
    final_distance: float = 0.08,
    iterations: int = 60,
    with_scale: bool = False,
    initial: np.ndarray | None = None,
) -> IcpResult:
    """ICP (point-à-plan si `target_normals`, sinon point-à-point) avec rejet
    progressif des appariements lointains.

    Le seuil de rejet décroît de `max_distance` à `final_distance` : les
    zones présentes dans une seule des deux géométries ne biaisent pas le
    résultat.
    """
    tree = cKDTree(target)
    m = np.eye(4) if initial is None else initial.copy()
    median_before = float(np.median(tree.query(apply(m, source))[0]))
    thresholds = np.geomspace(max_distance, final_distance, iterations)
    inliers = np.zeros(len(source), bool)
    for thr in thresholds:
        moved = apply(m, source)
        dist, idx = tree.query(moved, distance_upper_bound=thr)
        inliers = np.isfinite(dist)
        if inliers.sum() < 100:
            break
        if target_normals is None:
            step = umeyama(moved[inliers], target[idx[inliers]], with_scale)
        else:
            step = _point_to_plane_step(moved[inliers], target[idx[inliers]], target_normals[idx[inliers]], with_scale)
        m = step @ m
    median_after = float(np.median(tree.query(apply(m, source))[0]))
    return IcpResult(m, median_before, median_after, float(inliers.mean()))


def _camera_points(pose: np.ndarray, arm: float = 0.5) -> np.ndarray:
    """Centre optique + points sur les axes -Z et +Y : contraint aussi l'orientation."""
    r = pose[:3, :3] / np.linalg.norm(pose[:3, :3], axis=0)
    c = pose[:3, 3]
    return np.stack([c, c - arm * r[:, 2], c + arm * r[:, 1]])


@dataclass(frozen=True)
class PoseFitResult:
    transform: np.ndarray
    median_residual: float
    inliers: int
    total: int


def fit_pose_pairs(source_poses: list[np.ndarray], target_poses: list[np.ndarray], iterations: int = 10) -> PoseFitResult:
    """Transformation rigide robuste source -> cible à partir de paires de poses caméra 4x4.

    Les paires aberrantes (résidu > 3 × médiane, plancher 5 cm) sont écartées
    itérativement : quelques poses photogrammétriques peuvent être fausses.
    """
    src = np.stack([_camera_points(p) for p in source_poses])
    dst = np.stack([_camera_points(p) for p in target_poses])
    keep = np.ones(len(src), bool)
    m = np.eye(4)
    residual = np.zeros(len(src))
    for _ in range(iterations):
        m = umeyama(src[keep].reshape(-1, 3), dst[keep].reshape(-1, 3), with_scale=False)
        residual = np.linalg.norm(apply(m, src[:, 0]) - dst[:, 0], axis=1)
        new_keep = residual < max(3 * np.median(residual), 0.05)
        if (new_keep == keep).all():
            break
        keep = new_keep
    return PoseFitResult(m, float(np.median(residual[keep])), int(keep.sum()), len(src))


def estimate_normals(points: np.ndarray, k: int = 12) -> np.ndarray:
    """Normales locales par ACP sur les k plus proches voisins."""
    _, idx = cKDTree(points).query(points, k=k)
    neigh = points[idx] - points[idx].mean(axis=1, keepdims=True)
    cov = np.einsum("nki,nkj->nij", neigh, neigh)
    _, vecs = np.linalg.eigh(cov)
    return vecs[:, :, 0]


def register_clouds(source: np.ndarray, target: np.ndarray, sample: int = 200_000, seed: int = 0) -> IcpResult:
    """Recalage rigide nuage -> nuage (ICP point-à-plan, rejet progressif).

    Les zones qui ont changé entre deux captures (personnes, mobilier) sont
    écartées par le rejet des appariements lointains : seul le décor stable
    (sol, façades, végétation) contraint le résultat.
    """
    rng = np.random.default_rng(seed)
    src = source[rng.choice(len(source), min(sample, len(source)), replace=False)]
    tgt = target[rng.choice(len(target), min(sample * 3, len(target)), replace=False)]
    return icp(src, tgt, estimate_normals(tgt), max_distance=0.6, final_distance=0.04, iterations=80)


def segment_table_top(
    points: np.ndarray,
    colors: np.ndarray,
    height_hint: float,
    *,
    search: float = 0.2,
    thickness: float = 0.06,
    max_saturation: float = 0.25,
    min_value: float = 0.35,
    cell: float = 0.03,
) -> tuple[np.ndarray, np.ndarray, float]:
    """Plateau de table gris/blanc : (points, luminosité, hauteur du plateau).

    1. hauteur : mode des hauteurs des points peu saturés près de `height_hint` ;
    2. tranche fine à cette hauteur, couleurs peu saturées (gris, blanc) ;
    3. plus grande composante connexe en vue de dessus.
    """
    rgb = colors.astype(np.float64) / 255 if colors.dtype == np.uint8 else colors
    vmax, vmin = rgb.max(1), rgb.min(1)
    neutral = ((vmax - vmin) / np.maximum(vmax, 1e-6) < max_saturation) & (vmax > min_value)
    near = neutral & (np.abs(points[:, 1] - height_hint) < search)
    hist, edges = np.histogram(points[near, 1], bins=80)
    height = float((edges[hist.argmax()] + edges[hist.argmax() + 1]) / 2)

    sel = neutral & (np.abs(points[:, 1] - height) < thickness)
    top, lum = points[sel], rgb[sel].mean(1)
    ij = np.floor(top[:, [0, 2]] / cell).astype(int)
    ij -= ij.min(0)
    grid = np.zeros(ij.max(0) + 1, bool)
    grid[ij[:, 0], ij[:, 1]] = True
    grid = ndimage.binary_closing(grid, iterations=2)
    labels, n = ndimage.label(grid)
    largest = 1 + int(np.argmax(ndimage.sum(grid, labels, range(1, n + 1))))
    keep = labels[ij[:, 0], ij[:, 1]] == largest
    return top[keep], lum[keep], height


def refine_on_anchor(
    source: np.ndarray,
    source_lum: np.ndarray,
    target: np.ndarray,
    target_lum: np.ndarray,
    *,
    color_weight: float = 1.0,
    max_distance: float = 0.8,
    final_distance: float = 0.04,
    iterations: int = 70,
) -> IcpResult:
    """ICP rigide sur un objet fixe (ex. table), guidé par la luminosité.

    Une forme longue et uniforme peut glisser le long de son axe : apparier
    aussi le clair (nappe, papiers) avec le clair et le gris avec le gris
    lève l'ambiguïté. Les luminosités sont comparées par rang, ce qui
    neutralise les différences d'exposition entre deux captures.
    """
    rank = lambda v: np.argsort(np.argsort(v)) / max(1, len(v) - 1)  # noqa: E731
    tree = cKDTree(np.c_[target, color_weight * rank(target_lum)])
    src_lum = color_weight * rank(source_lum)
    geo = cKDTree(target)
    m = np.eye(4)
    median_before = float(np.median(geo.query(source)[0]))
    inliers = np.zeros(len(source), bool)
    for thr in np.geomspace(max_distance, final_distance, iterations):
        moved = apply(m, source)
        dist, idx = tree.query(np.c_[moved, src_lum], distance_upper_bound=thr)
        inliers = np.isfinite(dist)
        if inliers.sum() < 50:
            break
        m = umeyama(moved[inliers], target[idx[inliers]], with_scale=False) @ m
    median_after = float(np.median(geo.query(apply(m, source))[0]))
    return IcpResult(m, median_before, median_after, float(inliers.mean()))
