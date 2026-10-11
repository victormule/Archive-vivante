import type * as THREE from "three";
import type { LayerId } from "@/data/types";

export type ProgressCallback = (ratio: number) => void;

export interface Layer {
  readonly id: LayerId;
  readonly object: THREE.Object3D;
  load(onProgress?: ProgressCallback): Promise<void>;
  setOpacity(opacity: number): void;
  dispose(): void;
}

export function progressRatio(onProgress?: ProgressCallback) {
  return (e: ProgressEvent) => {
    if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
  };
}
