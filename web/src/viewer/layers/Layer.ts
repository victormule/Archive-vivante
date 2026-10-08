import type * as THREE from "three";
import type { LayerId } from "@/data/types";

export type ProgressCallback = (ratio: number) => void;

/**
 * Une représentation de la scène (splat, maillage, nuage).
 * Toutes les couches sont exprimées dans le même repère monde.
 */
export interface Layer {
  readonly id: LayerId;
  readonly object: THREE.Object3D;
  load(onProgress?: ProgressCallback): Promise<void>;
  /** Opacité globale [0, 1], utilisée pour les fondus entre sessions. */
  setOpacity(opacity: number): void;
  dispose(): void;
}

/** Adapte un ProgressEvent de fetch/loader en ratio [0, 1]. */
export function progressRatio(onProgress?: ProgressCallback) {
  return (e: ProgressEvent) => {
    if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
  };
}
