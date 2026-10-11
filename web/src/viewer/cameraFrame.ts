import * as THREE from "three";
import type { CameraView, Quat, Vec3 } from "@/data/types";

/**
 * Repère de la caméra au lieu d'une session : le centre commun des sessions (`center`, repère commun) y est
 * amené à l'endroit où le placement le pose, au niveau du sol, tourné comme le modèle. Déplacement rigide :
 * ni l'échelle du modèle ni la hauteur de son sol d'origine ne changent la distance ou la hauteur de la caméra.
 */
export function cameraFrame(placement: THREE.Matrix4, center: Vec3, floor: number): THREE.Matrix4 {
  const e = placement.elements;
  const site = new THREE.Vector3(...center).applyMatrix4(placement);
  return new THREE.Matrix4()
    .makeTranslation(site.x, floor, site.z)
    .multiply(new THREE.Matrix4().makeRotationY(Math.atan2(e[8], e[0])))
    .multiply(new THREE.Matrix4().makeTranslation(-center[0], -floor, -center[2]));
}

export function transformView(view: CameraView, matrix: THREE.Matrix4): CameraView {
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(matrix));
  return {
    ...view,
    position: new THREE.Vector3(...view.position).applyMatrix4(matrix).toArray() as Vec3,
    quaternion: new THREE.Quaternion(...view.quaternion).premultiply(rotation).toArray() as Quat,
    target: new THREE.Vector3(...view.target).applyMatrix4(matrix).toArray() as Vec3,
  };
}
