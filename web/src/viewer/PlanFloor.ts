import * as THREE from "three";
import type { PlanConfig, PlanPose } from "@/data/planConfig";

/** Largeur (px) de la texture du plan : traits nets de près, poids GPU raisonnable (~30 Mo avec mipmaps). */
const TEXTURE_WIDTH = 2048;
/** Le plan flotte à peine au-dessus du sol : pas de scintillement contre la photogrammétrie. */
const FLOOR_LIFT = 0.005;

export interface PlanImage {
  texture: THREE.Texture;
  /** Dimensions de la viewBox du SVG (unités du plan). */
  width: number;
  height: number;
}

/** Rastérise le SVG en traits blancs sur fond transparent (la couleur vient du matériau). */
export async function loadPlanImage(url: string, maxAnisotropy: number): Promise<PlanImage> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Plan introuvable : ${url} (${res.status})`);
  const doc = new DOMParser().parseFromString(await res.text(), "image/svg+xml");
  const svg = doc.documentElement;
  const viewBox = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite)) throw new Error(`Plan sans viewBox : ${url}`);
  const [, , width, height] = viewBox;

  const w = TEXTURE_WIDTH;
  const h = Math.round((TEXTURE_WIDTH * height) / width);
  // Dimensions explicites : sans elles, certains navigateurs rastérisent le SVG à 300×150
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);
    // Traits du SVG (noirs) -> blancs, le fond reste transparent
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAnisotropy;
    return { texture, width, height };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export class PlanFloor {
  readonly object: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor(image: PlanImage, config: PlanConfig, pose: PlanPose) {
    const s = config.metersPerUnit;
    const geometry = new THREE.PlaneGeometry(image.width * s, image.height * s);
    // À plat, face vers le haut : x du SVG -> x, y du SVG (vers le bas) -> z
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      map: image.texture,
      color: new THREE.Color(config.color),
      transparent: true,
      opacity: config.opacity,
      depthWrite: false,
      toneMapped: false,
    });
    this.object = new THREE.Mesh(geometry, material);
    this.object.name = "plan";
    this.object.renderOrder = -1;
    this.object.position.set(pose.center[0], pose.floor + FLOOR_LIFT, pose.center[1]);
    this.object.rotation.y = THREE.MathUtils.degToRad(pose.rotation);
    this.object.visible = false;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.object.material.dispose();
  }
}
