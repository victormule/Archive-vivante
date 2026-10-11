import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { AutoOrbit } from "./AutoOrbit";

function setup() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(-5.9, 2.15, 0.29);
  camera.quaternion.set(-0.2019, -0.4409, -0.1039, 0.8684).normalize();
  const turns: number[] = [];
  const orbit = new AutoOrbit(camera, { center: new THREE.Vector3(-0.62, -0.71, -4.2), turnSeconds: 80 }, (n) => turns.push(n));
  return { camera, orbit, turns };
}

describe("AutoOrbit", () => {
  it("part exactement de la pose courante (aucun à-coup)", () => {
    const { camera, orbit } = setup();
    const position = camera.position.clone();
    const quaternion = camera.quaternion.clone();
    orbit.update(1 / 60);
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-3);
    expect(camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-3);
  });

  it("garde un mouvement continu image par image", () => {
    const { camera, orbit } = setup();
    let previous = camera.position.clone();
    for (let i = 0; i < 60 * 30; i++) {
      orbit.update(1 / 60);
      // < 2 cm par image à 60 i/s
      expect(camera.position.distanceTo(previous)).toBeLessThan(0.02);
      previous = camera.position.clone();
    }
  });

  it("annonce chaque tour complet (une session par tour)", () => {
    const { orbit, turns } = setup();
    for (let t = 0; t < 200; t += 1 / 30) orbit.update(1 / 30);
    // Mise en mouvement progressive : deux tours en un peu plus de 160 s
    expect(turns).toEqual([1, 2]);
  });

  it("peut annoncer chaque demi-tour", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(-5.9, 2.15, 0.29);
    const steps: number[] = [];
    const orbit = new AutoOrbit(camera, { center: new THREE.Vector3(-0.62, -0.71, -4.2), turnSeconds: 80, stepDegrees: 180 }, (n) => steps.push(n));
    for (let t = 0; t < 200; t += 1 / 30) orbit.update(1 / 30);
    expect(steps).toEqual([1, 2, 3, 4]);
  });

  it("suit en douceur l'axe déplacé vers un autre lieu, sans s'arrêter de tourner", () => {
    const { camera, orbit } = setup();
    for (let t = 0; t < 10; t += 1 / 60) orbit.update(1 / 60);
    const target = new THREE.Vector3(10, -0.71, 6);
    orbit.moveCenter(target, 5);
    let previous = camera.position.clone();
    for (let i = 0; i < 60 * 6; i++) {
      orbit.update(1 / 60);
      // 14 m en 5 s : < 10 cm par image, sans à-coup
      expect(camera.position.distanceTo(previous)).toBeLessThan(0.1);
      previous = camera.position.clone();
    }
    const offset = camera.position.clone().sub(target);
    expect(Math.hypot(offset.x, offset.z)).toBeLessThan(9.5);
    expect(orbit.focus(new THREE.Vector3()).distanceTo(target)).toBeLessThan(0.05);
  });

  it("finit par regarder l'axe de rotation", () => {
    const { camera, orbit } = setup();
    for (let t = 0; t < 20; t += 1 / 30) orbit.update(1 / 30);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const toCenter = new THREE.Vector3(-0.62, -0.71, -4.2).sub(camera.position).normalize();
    expect(forward.angleTo(toCenter)).toBeLessThan(0.01);
  });
});
