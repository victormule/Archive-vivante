import * as THREE from "three";
import type { PointCloudLayerData } from "@/data/types";
import type { Layer, ProgressCallback } from "./Layer";

/** Taille apparente d'un point en mètres, relative à la taille de voxel. */
const POINT_SIZE_FACTOR = 1.6;

/**
 * Nuage de points coloré (format points.bin, voir pipeline/point_cloud.py).
 *
 * Les positions uint16 sont envoyées telles quelles au GPU (attribut
 * normalisé) ; la dé-quantification est portée par la matrice de l'objet.
 */
export class PointCloudLayer implements Layer {
  readonly id = "pointCloud" as const;
  readonly object: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.PointsMaterial;

  constructor(private readonly url: string, private readonly data: PointCloudLayerData) {
    this.material = new THREE.PointsMaterial({
      size: data.voxelSize * POINT_SIZE_FACTOR,
      sizeAttenuation: true,
      vertexColors: true,
    });
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.name = "pointCloud";

    const [x0, y0, z0] = data.boundsMin;
    const [x1, y1, z1] = data.boundsMax;
    this.object.position.set(x0, y0, z0);
    this.object.scale.set(x1 - x0 || 1, y1 - y0 || 1, z1 - z0 || 1);
  }

  async load(onProgress?: ProgressCallback): Promise<void> {
    const buffer = await fetchWithProgress(this.url, onProgress);
    const n = this.data.count;
    if (buffer.byteLength !== n * 9) {
      throw new Error(`points.bin : taille inattendue (${buffer.byteLength} octets pour ${n} points)`);
    }
    const positions = new Uint16Array(buffer, 0, n * 3);
    const colors = new Uint8Array(buffer, n * 6, n * 3);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3, true));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
    this.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));
    this.geometry.boundingSphere = this.geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  }

  setOpacity(opacity: number): void {
    const fading = opacity < 0.999;
    if (this.material.transparent !== fading) this.material.needsUpdate = true;
    this.material.transparent = fading;
    this.material.depthWrite = !fading;
    this.material.opacity = opacity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

async function fetchWithProgress(url: string, onProgress?: ProgressCallback): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Chargement impossible : ${url} (${res.status})`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total) onProgress?.(loaded / total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}
