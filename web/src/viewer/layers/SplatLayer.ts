import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import type { Layer, ProgressCallback } from "./Layer";

export interface SplatSource {
  url: string;
  /** Poids du fichier, pour pondérer la progression entre plusieurs splats. */
  bytes?: number;
  /** Repère du splat -> repère de la couche (4x4 column-major). */
  transform?: number[];
}

/**
 * Gaussian splat, éventuellement fait de plusieurs fichiers placés chacun par
 * sa matrice (Event). Le téléchargement ne démarre qu'au premier `load()`.
 */
export class SplatLayer implements Layer {
  readonly id = "splat" as const;
  readonly object = new THREE.Group();
  private meshes: SplatMesh[] = [];
  private opacity = 1;

  constructor(private readonly sources: SplatSource[]) {
    this.object.name = "splat";
  }

  async load(onProgress?: ProgressCallback): Promise<void> {
    // Nouvel essai après un échec : les anciens splats sont libérés
    this.dispose();
    const ratios = this.sources.map(() => 0);
    const weights = this.sources.map((s) => s.bytes ?? 1);
    const total = weights.reduce((a, b) => a + b, 0);
    const report = () => onProgress?.(ratios.reduce((sum, r, i) => sum + r * weights[i], 0) / total);
    this.meshes = this.sources.map((source, i) => {
      const mesh = new SplatMesh({
        url: source.url,
        onProgress: (e: ProgressEvent) => {
          if (e.lengthComputable && e.total > 0) ratios[i] = e.loaded / e.total;
          report();
        },
      });
      if (source.transform) {
        mesh.matrixAutoUpdate = false;
        mesh.matrix.fromArray(source.transform);
      }
      mesh.opacity = this.opacity;
      this.object.add(mesh);
      return mesh;
    });
    // `initialized` couvre téléchargement et décodage (worker)
    await Promise.all(this.meshes.map((m) => m.initialized));
    onProgress?.(1);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    for (const mesh of this.meshes) mesh.opacity = opacity;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      this.object.remove(mesh);
      mesh.dispose();
    }
    this.meshes = [];
  }
}
