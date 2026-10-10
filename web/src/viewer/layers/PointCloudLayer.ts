import * as THREE from "three";
import type { PointCloudLayerData } from "@/data/types";
import type { Layer, ProgressCallback } from "./Layer";

/** Diamètre d'un point en mètres, relatif à la taille de voxel. */
const POINT_SIZE_FACTOR = 1.0;
/** Diamètre maximal d'un point à l'écran (pixels CSS) : de près, des points, pas des taches. */
const MAX_POINT_PIXELS = 5;
/** Diamètre plafonné (m) : un nuage voxelisé large (Event, 5 cm) reste fait de points distincts. */
const MAX_POINT_SIZE = 0.025;
/** Opacité des points proches, et des points lointains (au-delà de FADE_FAR). */
const NEAR_ALPHA = 0.85;
const FAR_ALPHA = 0.08;
/** Distances (m) du début et de la fin de l'atténuation avec la profondeur. */
const FADE_NEAR = 1.5;
const FADE_FAR = 22;
/** Points sans couleur d'image (blanc pur dans l'export) : gris linéaire et opacité relative. */
const UNCOLORED_GRAY = 0.05;
const UNCOLORED_ALPHA = 0.4;

const vertexShader = /* glsl */ `
  #define UNCOLORED_GRAY ${UNCOLORED_GRAY.toFixed(3)}
  #define UNCOLORED_ALPHA ${UNCOLORED_ALPHA.toFixed(3)}
  uniform float uSize;
  uniform float uPixelScale;
  uniform float uMaxPixels;
  uniform float uFadeNear;
  uniform float uFadeFar;
  uniform float uNearAlpha;
  uniform float uFarAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  // Couleurs du nuage en sRGB : décodées en linéaire (sinon ré-encodées à l'affichage, elles blanchissent)
  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
  void main() {
    // Blanc pur : point LiDAR sans couleur d'image (aucune photo ne le voit) -> gris discret, plus transparent
    float uncolored = step(2.99, color.r + color.g + color.b);
    vColor = mix(srgbToLinear(color), vec3(UNCOLORED_GRAY), uncolored);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float depth = -mvPosition.z;
    // Taille en perspective (mètres -> pixels), bornée
    float size = uSize * projectionMatrix[1][1] * uPixelScale / max(depth, 0.01);
    gl_PointSize = clamp(size, 1.0, uMaxPixels);
    // Opacité décroissante avec la distance ; un point plus petit qu'un pixel s'estompe d'autant
    float fade = mix(uNearAlpha, uFarAlpha, smoothstep(uFadeNear, uFadeFar, depth));
    vAlpha = fade * clamp(size, 0.25, 1.0) * mix(1.0, UNCOLORED_ALPHA, uncolored);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    // Disque à bord doux plutôt qu'un carré
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float edge = 1.0 - smoothstep(0.45, 1.0, r2);
    gl_FragColor = vec4(vColor, vAlpha * edge * uOpacity);
    #include <colorspace_fragment>
  }
`;

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
  private readonly material: THREE.ShaderMaterial;

  constructor(private readonly url: string, private readonly data: PointCloudLayerData) {
    // Points ronds, translucides, de plus en plus légers avec la distance : la profondeur se lit
    // au lieu d'une masse blanche là où les points s'accumulent
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: Math.min(data.voxelSize * POINT_SIZE_FACTOR, MAX_POINT_SIZE) },
        uPixelScale: { value: 400 },
        uMaxPixels: { value: MAX_POINT_PIXELS },
        uFadeNear: { value: FADE_NEAR },
        uFadeFar: { value: FADE_FAR },
        uNearAlpha: { value: NEAR_ALPHA },
        uFarAlpha: { value: FAR_ALPHA },
        uOpacity: { value: 1 },
      },
      vertexShader,
      fragmentShader,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.object = new THREE.Points(this.geometry, this.material);
    this.object.name = "pointCloud";
    // Échelle pixels : moitié de la hauteur du tampon de rendu (comme PointsMaterial), taille max en pixels réels
    const size = new THREE.Vector2();
    this.object.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(size);
      this.material.uniforms.uPixelScale.value = size.y / 2;
      this.material.uniforms.uMaxPixels.value = MAX_POINT_PIXELS * renderer.getPixelRatio();
    };

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
    this.material.uniforms.uOpacity.value = opacity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

async function fetchWithProgress(url: string, onProgress?: ProgressCallback): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Chargement impossible : ${url} (${res.status})`);
  // Taille connue (fichier non compressé) : écriture directe dans le tampon final, sans copie
  const total = res.headers.has("Content-Encoding") ? 0 : Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body.getReader();
  let buffer = new Uint8Array(total || 1 << 20);
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > buffer.length) {
      const grown = new Uint8Array(Math.max(buffer.length * 2, loaded + value.length));
      grown.set(buffer.subarray(0, loaded));
      buffer = grown;
    }
    buffer.set(value, loaded);
    loaded += value.length;
    if (total) onProgress?.(Math.min(1, loaded / total));
  }
  return loaded === buffer.length ? buffer.buffer : buffer.slice(0, loaded).buffer;
}
