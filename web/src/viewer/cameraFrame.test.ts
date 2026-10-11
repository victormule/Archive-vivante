import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { placementMatrix } from "@/data/planConfig";
import type { CameraView, Vec3 } from "@/data/types";
import { cameraFrame, transformView } from "./cameraFrame";

const CENTER: Vec3 = [-0.62, -0.71, -4.2];
const FLOOR = -1.456;
const VIEW: CameraView = { position: [-5.9, 2.15, 0.29], quaternion: [0, 0, 0, 1], target: [-0.36, -1.24, -3.77] };

const frameOf = (anchor: Vec3, position: [number, number], rotation: number, scale: number) =>
  cameraFrame(placementMatrix({ anchor, position, rotation, scale }, FLOOR), CENTER, FLOOR);

describe("cameraFrame", () => {
  it("laisse la caméra en place quand le modèle n'est ni déplacé ni tourné", () => {
    const frame = frameOf([-0.62, -1.4, -4.2], [-0.62, -4.2], 0, 1.1);
    expect(new THREE.Vector3(...VIEW.position).applyMatrix4(frame).toArray()).toEqual(VIEW.position.map((v) => expect.closeTo(v, 6)));
  });

  it("garde la distance au centre et la hauteur au-dessus du sol d'un lieu à l'autre", () => {
    const from = frameOf([-0.62, -1.456, -4.2], [-0.62, -4.2], 0, 1);
    // Modèle agrandi, tourné, dont le sol d'origine est 1 m plus bas
    const placement = placementMatrix({ anchor: [1.199, -2.48, -5.115], position: [-11.965, -6.057], rotation: -15.47, scale: 1.25 }, FLOOR);
    const to = cameraFrame(placement, CENTER, FLOOR);
    const moved = transformView(VIEW, to.clone().multiply(from.clone().invert()));
    const site = new THREE.Vector3(...CENTER).applyMatrix4(placement);

    expect(moved.position[1]).toBeCloseTo(VIEW.position[1], 6);
    const before = Math.hypot(VIEW.position[0] - CENTER[0], VIEW.position[2] - CENTER[2]);
    const after = Math.hypot(moved.position[0] - site.x, moved.position[2] - site.z);
    expect(after).toBeCloseTo(before, 6);
    const reach = (v: CameraView) => new THREE.Vector3(...v.position).distanceTo(new THREE.Vector3(...v.target));
    expect(reach(moved)).toBeCloseTo(reach(VIEW), 6);
  });
});
