/**
 * Placement des étiquettes d'annotation en deux colonnes (gauche / droite).
 *
 * Chaque étiquette rejoint le bord le plus proche de son point d'ancrage,
 * puis les étiquettes d'une même colonne sont empilées au plus près de la
 * hauteur de leur point, sans chevauchement.
 */

export type Side = "left" | "right";

export interface LayoutItem {
  id: string;
  /** Point d'ancrage projeté, en pixels écran. */
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  /** Côté précédent, pour une hystérésis (évite le clignotement au centre). */
  previousSide?: Side;
}

export interface LayoutBounds {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  gap: number;
  /** Largeur (fraction de l'écran) de la zone centrale où le côté précédent est conservé. */
  hysteresis?: number;
}

export interface LabelPlacement {
  id: string;
  side: Side;
  x: number;
  y: number;
}

export function chooseSide(anchorX: number, width: number, previous?: Side, hysteresis = 0.1): Side {
  const center = width / 2;
  const band = width * hysteresis;
  if (previous && Math.abs(anchorX - center) < band / 2) return previous;
  return anchorX < center ? "left" : "right";
}

/** Empile des boîtes [y, y+h] au plus près de leurs cibles, dans [top, bottom]. */
export function stack(targets: number[], heights: number[], top: number, bottom: number, gap: number): number[] {
  const n = targets.length;
  const y = targets.map((t, i) => Math.min(Math.max(t, top), bottom - heights[i]));
  for (let i = 1; i < n; i++) y[i] = Math.max(y[i], y[i - 1] + heights[i - 1] + gap);
  // Débordement en bas : on remonte la pile
  if (n > 0) y[n - 1] = Math.min(y[n - 1], bottom - heights[n - 1]);
  for (let i = n - 2; i >= 0; i--) y[i] = Math.min(y[i], y[i + 1] - heights[i] - gap);
  for (let i = 0; i < n; i++) y[i] = Math.max(y[i], top);
  return y;
}

export function layoutLabels(items: LayoutItem[], bounds: LayoutBounds): LabelPlacement[] {
  const columns: Record<Side, LayoutItem[]> = { left: [], right: [] };
  for (const item of items) {
    columns[chooseSide(item.anchorX, bounds.width, item.previousSide, bounds.hysteresis)].push(item);
  }

  const result: LabelPlacement[] = [];
  for (const side of ["left", "right"] as const) {
    const column = columns[side].sort((a, b) => a.anchorY - b.anchorY);
    const ys = stack(
      column.map((c) => c.anchorY - c.height / 2),
      column.map((c) => c.height),
      bounds.top,
      bounds.height - bounds.bottom,
      bounds.gap,
    );
    column.forEach((item, i) => {
      const x = side === "left" ? bounds.left : bounds.width - bounds.right - item.width;
      result.push({ id: item.id, side, x, y: ys[i] });
    });
  }
  return result;
}

/** Fil courbe (Bézier cubique, départ et arrivée horizontaux) entre le point et l'étiquette. */
export function leaderPath(ax: number, ay: number, lx: number, ly: number): string {
  const mx = ax + (lx - ax) * 0.55;
  return `M ${ax.toFixed(1)} ${ay.toFixed(1)} C ${mx.toFixed(1)} ${ay.toFixed(1)}, ${mx.toFixed(1)} ${ly.toFixed(1)}, ${lx.toFixed(1)} ${ly.toFixed(1)}`;
}
