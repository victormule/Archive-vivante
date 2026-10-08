import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Layer, ProgressCallback } from "./Layer";
import { progressRatio } from "./Layer";

/** Maillage photogrammétrique texturé (glTF, matériau unlit). */
export class MeshLayer implements Layer {
  readonly id = "mesh" as const;
  readonly object = new THREE.Group();
  private opacity = 1;

  constructor(private readonly url: string) {
    this.object.name = "photogrammetry";
  }

  async load(onProgress?: ProgressCallback): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(this.url, progressRatio(onProgress));
    this.object.add(gltf.scene);
    this.setOpacity(this.opacity);
  }

  setOpacity(opacity: number): void {
    this.opacity = opacity;
    // Opaque hors fondu : tri et écriture de profondeur normaux
    const fading = opacity < 0.999;
    this.object.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.transparent !== fading) m.needsUpdate = true;
        m.transparent = fading;
        m.depthWrite = !fading;
        m.opacity = opacity;
      }
    });
  }

  dispose(): void {
    this.object.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        materials.forEach((m: THREE.MeshBasicMaterial) => {
          m.map?.dispose();
          m.dispose();
        });
      }
    });
  }
}
