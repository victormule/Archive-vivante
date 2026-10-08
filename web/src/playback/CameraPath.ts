import * as THREE from "three";
import type { CameraPathData } from "@/data/types";

export interface CameraPathOptions {
  /**
   * Écart-type (s) du lissage gaussien temporel appliqué au trajet.
   * Atténue les tremblements de la prise de vue à la main. 0 = trajet brut.
   */
  smoothing?: number;
}

/** Fréquence du ré-échantillonnage dense utilisé pour le lissage. */
const SAMPLE_RATE = 30;

/**
 * Chemin caméra échantillonnable à n'importe quel instant.
 *
 * 1. Interpolation des keyframes : spline d'Hermite (tangentes de
 *    Catmull-Rom pondérées par le temps) pour la position, slerp pour
 *    l'orientation.
 * 2. Ré-échantillonnage à SAMPLE_RATE puis lissage gaussien (position et
 *    quaternion), avec renormalisation des poids aux extrémités.
 */
export class CameraPath {
  readonly duration: number;
  readonly fovY: number;

  private readonly positions: Float64Array;
  private readonly rotations: Float64Array;
  private readonly count: number;

  constructor(data: CameraPathData, { smoothing = 0 }: CameraPathOptions = {}) {
    if (data.keyframes.length === 0) throw new Error("Chemin caméra vide");
    this.duration = data.duration;
    this.fovY = data.fovY;

    const raw = new KeyframeInterpolator(data);
    this.count = Math.max(2, Math.ceil(this.duration * SAMPLE_RATE) + 1);
    const pos = new Float64Array(this.count * 3);
    const rot = new Float64Array(this.count * 4);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (let i = 0; i < this.count; i++) {
      raw.sample(this.timeAt(i), p, q);
      p.toArray(pos, i * 3);
      q.toArray(rot, i * 4);
    }

    if (smoothing > 0) {
      this.positions = gaussianSmooth(pos, 3, smoothing * SAMPLE_RATE);
      this.rotations = gaussianSmooth(rot, 4, smoothing * SAMPLE_RATE);
      for (let i = 0; i < this.count; i++) {
        q.fromArray(this.rotations, i * 4).normalize().toArray(this.rotations, i * 4);
      }
    } else {
      this.positions = pos;
      this.rotations = rot;
    }
  }

  /** Échantillonne la pose au temps t (secondes), bornée aux extrémités. */
  sample(t: number, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): void {
    const x = Math.min(Math.max(t, 0), this.duration) * SAMPLE_RATE;
    const i = Math.min(Math.floor(x), this.count - 2);
    const u = Math.min(x - i, 1);

    const a = i * 3;
    const b = a + 3;
    outPosition.set(
      this.positions[a] + (this.positions[b] - this.positions[a]) * u,
      this.positions[a + 1] + (this.positions[b + 1] - this.positions[a + 1]) * u,
      this.positions[a + 2] + (this.positions[b + 2] - this.positions[a + 2]) * u,
    );
    outQuaternion.fromArray(this.rotations, i * 4);
    tmpQuat.fromArray(this.rotations, (i + 1) * 4);
    outQuaternion.slerp(tmpQuat, u);
  }

  /** Points échantillonnés régulièrement, pour la visualisation du trajet. */
  polyline(step = 0.1): THREE.Vector3[] {
    const pts: THREE.Vector3[] = [];
    const q = new THREE.Quaternion();
    for (let t = 0; t <= this.duration; t += step) {
      const p = new THREE.Vector3();
      this.sample(t, p, q);
      pts.push(p);
    }
    return pts;
  }

  private timeAt(i: number): number {
    return Math.min(i / SAMPLE_RATE, this.duration);
  }
}

const tmpQuat = new THREE.Quaternion();

/**
 * Convolution gaussienne d'une suite de vecteurs (`stride` composantes),
 * sigma exprimé en nombre d'échantillons. Les quaternions doivent être dans
 * un même hémisphère (garanti par KeyframeInterpolator).
 */
function gaussianSmooth(values: Float64Array, stride: number, sigma: number): Float64Array {
  const n = values.length / stride;
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, k) => Math.exp(-((k - radius) ** 2) / (2 * sigma * sigma)));
  const out = new Float64Array(values.length);
  for (let i = 0; i < n; i++) {
    let wsum = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const w = kernel[k + radius];
      wsum += w;
      for (let c = 0; c < stride; c++) out[i * stride + c] += w * values[j * stride + c];
    }
    for (let c = 0; c < stride; c++) out[i * stride + c] /= wsum;
  }
  return out;
}

/** Interpolation directe entre keyframes (trajet brut). */
class KeyframeInterpolator {
  private readonly times: Float64Array;
  private readonly positions: THREE.Vector3[];
  private readonly tangents: THREE.Vector3[];
  private readonly rotations: THREE.Quaternion[];

  constructor(data: CameraPathData) {
    const kfs = data.keyframes;
    this.times = Float64Array.from(kfs, (k) => k.t);
    this.positions = kfs.map((k) => new THREE.Vector3(...k.position));
    this.rotations = kfs.map((k) => new THREE.Quaternion(...k.quaternion).normalize());

    // Hémisphères alignés : pas de rotation à 360° ni de moyenne incohérente
    for (let i = 1; i < this.rotations.length; i++) {
      if (this.rotations[i].dot(this.rotations[i - 1]) < 0) {
        const q = this.rotations[i];
        q.set(-q.x, -q.y, -q.z, -q.w);
      }
    }

    const n = this.positions.length;
    this.tangents = this.positions.map((_, i) => {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      const dt = this.times[b] - this.times[a];
      return dt > 0
        ? new THREE.Vector3().subVectors(this.positions[b], this.positions[a]).divideScalar(dt)
        : new THREE.Vector3();
    });
  }

  sample(t: number, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): void {
    const { times, positions, rotations, tangents } = this;
    const last = times.length - 1;

    if (t <= times[0] || last === 0) {
      outPosition.copy(positions[0]);
      outQuaternion.copy(rotations[0]);
      return;
    }
    if (t >= times[last]) {
      outPosition.copy(positions[last]);
      outQuaternion.copy(rotations[last]);
      return;
    }

    const i = this.segmentIndex(t);
    const t0 = times[i];
    const dt = times[i + 1] - t0;
    const u = dt > 0 ? (t - t0) / dt : 0;

    // Bases d'Hermite
    const u2 = u * u;
    const u3 = u2 * u;
    outPosition
      .copy(positions[i]).multiplyScalar(2 * u3 - 3 * u2 + 1)
      .addScaledVector(tangents[i], (u3 - 2 * u2 + u) * dt)
      .addScaledVector(positions[i + 1], -2 * u3 + 3 * u2)
      .addScaledVector(tangents[i + 1], (u3 - u2) * dt);

    outQuaternion.slerpQuaternions(rotations[i], rotations[i + 1], u);
  }

  /** Recherche dichotomique du segment [i, i+1] contenant t. */
  private segmentIndex(t: number): number {
    let lo = 0;
    let hi = this.times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }
}
