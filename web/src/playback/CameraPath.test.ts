import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { CameraPathData } from "@/data/types";
import { CameraPath } from "./CameraPath";

/** Trajet synthétique : travelling rectiligne + tremblement à 3 Hz. */
function shakyPath(): CameraPathData {
  const keyframes = Array.from({ length: 41 }, (_, i) => {
    const t = i * 0.25;
    const shake = 0.03 * Math.sin(2 * Math.PI * 3 * t + 0.4);
    const yaw = 0.04 * Math.sin(2 * Math.PI * 2.5 * t);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
    return { t, position: [t * 0.5, 1.5 + shake, 0] as [number, number, number], quaternion: q.toArray() as [number, number, number, number] };
  });
  return { coordinateSystem: "test", videoId: "test", duration: 10, fovY: 50, aspect: 4 / 3, keyframes };
}

/**
 * Accélération moyenne (linéaire m/s², angulaire rad/s²) mesurée par
 * différences finies au pas `dt` : l'échelle des tremblements de la main.
 */
function roughness(path: CameraPath, dt = 0.1) {
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const q = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
  const angularVelocity = (a: THREE.Quaternion, b: THREE.Quaternion) => {
    const d = a.clone().invert().multiply(b);
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const s = Math.sqrt(1 - Math.min(1, d.w * d.w));
    const angle = 2 * Math.acos(Math.min(1, d.w));
    return s < 1e-9 ? new THREE.Vector3() : new THREE.Vector3(d.x, d.y, d.z).multiplyScalar(angle / s / dt);
  };
  let lin = 0;
  let ang = 0;
  let n = 0;
  for (let t = 1; t < path.duration - 1; t += dt / 2) {
    for (let k = 0; k < 3; k++) path.sample(t + (k - 1) * dt, p[k], q[k]);
    lin += p[0].clone().add(p[2]).addScaledVector(p[1], -2).length() / dt ** 2;
    ang += angularVelocity(q[1], q[2]).sub(angularVelocity(q[0], q[1])).length() / dt;
    n++;
  }
  return { lin: lin / n, ang: ang / n };
}

describe("CameraPath", () => {
  it("passe par les keyframes sans lissage (à la précision du ré-échantillonnage)", () => {
    const data = shakyPath();
    const path = new CameraPath(data);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (const k of data.keyframes.slice(1, -1)) {
      path.sample(k.t, p, q);
      expect(p.distanceTo(new THREE.Vector3(...k.position))).toBeLessThan(1e-3);
    }
  });

  it("borne l'échantillonnage aux extrémités", () => {
    const path = new CameraPath(shakyPath(), { smoothing: 0.5 });
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const q = new THREE.Quaternion();
    path.sample(-5, a, q);
    path.sample(0, b, q);
    expect(a.distanceTo(b)).toBe(0);
    path.sample(1e6, a, q);
    path.sample(path.duration, b, q);
    expect(a.distanceTo(b)).toBe(0);
  });

  it("atténue fortement les tremblements tout en suivant le trajet", () => {
    const raw = new CameraPath(shakyPath());
    const smooth = new CameraPath(shakyPath(), { smoothing: 0.5 });
    const r0 = roughness(raw);
    const r1 = roughness(smooth);
    expect(r1.lin).toBeLessThan(r0.lin * 0.2);
    expect(r1.ang).toBeLessThan(r0.ang * 0.2);

    // Le travelling de fond est conservé (écart < amplitude du tremblement)
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (let t = 2; t < 8; t += 0.5) {
      smooth.sample(t, p, q);
      expect(Math.abs(p.x - t * 0.5)).toBeLessThan(0.01);
      expect(Math.abs(p.y - 1.5)).toBeLessThan(0.03);
    }
  });

  it("lisse le trajet réel de j1-s1 si les assets sont générés", () => {
    let data: CameraPathData;
    try {
      data = JSON.parse(readFileSync(resolve(__dirname, "../../public/sessions/j1-s1/camera_path.json"), "utf-8"));
    } catch {
      return; // assets non générés : test ignoré
    }
    const r0 = roughness(new CameraPath(data));
    const r1 = roughness(new CameraPath(data, { smoothing: 0.5 }));
    console.info(`j1-s1 accélération linéaire ${r0.lin.toFixed(3)} -> ${r1.lin.toFixed(3)} m/s², angulaire ${r0.ang.toFixed(3)} -> ${r1.ang.toFixed(3)} rad/s²`);
    expect(r1.lin).toBeLessThan(r0.lin * 0.5);
    expect(r1.ang).toBeLessThan(r0.ang * 0.5);
  });
});
