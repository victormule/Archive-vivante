import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import type { Layer, ProgressCallback } from "./Layer";
import { progressRatio } from "./Layer";

/** Gaussian splat. Le téléchargement ne démarre qu'au premier `load()`. */
export class SplatLayer implements Layer {
  readonly id = "splat" as const;
  readonly object = new THREE.Group();
  private mesh: SplatMesh | null = null;
  private opacity = 1;

  constructor(private readonly url: string) {
    this.object.name = "splat";
  }

  async load(onProgress?: ProgressCallback): Promise<void> {
    // Nouvel essai après un échec : l'ancien splat est libéré
    this.dispose();
    const mesh = new SplatMesh({ url: this.url, onProgress: progressRatio(onProgress) });
    mesh.opacity = this.opacity;
    this.mesh = mesh;
    this.object.add(mesh);
    // `initialized` couvre téléchargement et décodage (worker)
    await mesh.initialized;
    onProgress?.(1);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    if (this.mesh) this.mesh.opacity = opacity;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.object.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
  }
}
