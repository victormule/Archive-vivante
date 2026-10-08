import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import type { CameraView } from "@/data/types";

/** free : navigation à la souris ; replay / auto : caméra pilotée (lecture, rotation automatique). */
export type CameraMode = "free" | "replay" | "auto";

export interface SceneViewerOptions {
  container: HTMLElement;
  fovY?: number;
}

/** Distance (m) du pivot de l'orbite devant la caméra. */
const ORBIT_TARGET_DISTANCE = 1.5;

const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;

interface Flight {
  from: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  to: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  start: number;
  duration: number;
  resolve: (completed: boolean) => void;
}

/**
 * Viewer three.js + Spark partagé par toutes les sessions : rendu, caméra,
 * navigation libre (OrbitControls) et mode replay piloté de l'extérieur.
 * Le contenu (couches de chaque session) est ajouté à `scene` par les sessions.
 */
export class SceneViewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  private readonly spark: SparkRenderer;
  /** Contenu splat modifié : mises à jour Spark forcées jusqu'à ce que l'affichage suive. */
  private splatsDirty = false;
  private splatUpdatePending = false;

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly frameCallbacks = new Set<(dt: number) => void>();
  private readonly cameraCallbacks = new Set<(dt: number) => void>();
  private _mode: CameraMode = "free";
  /** Pivot à reprendre tel quel à la première interaction (vue enregistrée). */
  private pendingTarget: THREE.Vector3 | null = null;
  /** Faux tant que la pose posée par setPose n'a pas été reprise par l'orbite. */
  private orbitSynced = false;
  private lastFrame = performance.now();
  private flight: Flight | null = null;

  constructor({ container, fovY = 50 }: SceneViewerOptions) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0b0b0c);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(fovY, 1, 0.01, 500);
    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 0.6;
    // La pose exacte (roulis compris) est conservée jusqu'à la première interaction
    this.controls.addEventListener("start", () => {
      if (this.orbitSynced) return;
      if (this.pendingTarget) {
        this.controls.target.copy(this.pendingTarget);
        this.controls.update();
        this.orbitSynced = true;
      } else {
        this.retargetOrbit();
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(() => this.frame());
  }

  get mode(): CameraMode {
    return this._mode;
  }

  /** Place la caméra sur une pose monde ; l'orbite la reprendra à la prochaine interaction. */
  setPose(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.camera.position.copy(position);
    this.camera.quaternion.copy(quaternion);
    this.orbitSynced = false;
    this.pendingTarget = null;
  }

  /** Applique une vue enregistrée (pose exacte + pivot de l'orbite). */
  setView(view: CameraView): void {
    if (view.fovY) this.setFov(view.fovY);
    this.camera.position.set(...view.position);
    this.camera.quaternion.set(...view.quaternion);
    this.controls.target.set(...view.target);
    // Pivot fourni : l'orbite reprend la main sans recadrer la caméra
    this.orbitSynced = false;
    this.pendingTarget = new THREE.Vector3(...view.target);
  }

  /** Vue courante, au format de `sessions.json` (outil d'édition). */
  currentView(): CameraView {
    const round = (v: number) => Math.round(v * 1e4) / 1e4;
    const target = this.orbitSynced
      ? this.controls.target.clone()
      : this.camera.position.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion), ORBIT_TARGET_DISTANCE * 4);
    return {
      position: this.camera.position.toArray().map(round) as CameraView["position"],
      quaternion: this.camera.quaternion.toArray().map((v) => Math.round(v * 1e6) / 1e6) as CameraView["quaternion"],
      target: target.toArray().map(round) as CameraView["target"],
      fovY: round(this.camera.fov),
    };
  }

  /**
   * Vol de caméra vers une pose (mouvement lent, accéléré puis freiné).
   * Résout `true` à l'arrivée, `false` s'il est interrompu.
   */
  flyTo(position: THREE.Vector3, quaternion: THREE.Quaternion, duration: number): Promise<boolean> {
    this.cancelFlight();
    return new Promise((resolve) => {
      this.flight = {
        from: { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone() },
        to: { position: position.clone(), quaternion: quaternion.clone() },
        start: performance.now(),
        duration: duration * 1000,
        resolve,
      };
    });
  }

  get isFlying(): boolean {
    return this.flight !== null;
  }

  cancelFlight(): void {
    const flight = this.flight;
    this.flight = null;
    flight?.resolve(false);
  }

  /** Durée de vol (s) adaptée à la distance et à la rotation à parcourir. */
  flightDuration(position: THREE.Vector3, quaternion: THREE.Quaternion): number {
    const distance = this.camera.position.distanceTo(position);
    const angle = this.camera.quaternion.angleTo(quaternion);
    return THREE.MathUtils.clamp(1.8 + 0.45 * distance + 0.9 * angle, 2.2, 6);
  }

  setFov(fovY: number): void {
    this.camera.fov = fovY;
    this.camera.updateProjectionMatrix();
  }

  setMode(mode: CameraMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    this.controls.enabled = mode === "free";
  }

  /**
   * Place le pivot de l'orbite devant la caméra, sans la déplacer.
   * OrbitControls impose le "up" monde : le roulis éventuel est annulé.
   */
  retargetOrbit(): void {
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.controls.target.copy(this.camera.position).addScaledVector(forward, ORBIT_TARGET_DISTANCE);
    this.controls.update();
    this.orbitSynced = true;
  }

  /** Cadre une boîte englobante (vue par défaut sans replay). */
  frameBox(box: THREE.Box3): void {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.camera.position.copy(center).add(new THREE.Vector3(0, size * 0.3, size * 0.6));
    this.controls.target.copy(center);
    this.controls.update();
    this.orbitSynced = true;
  }

  /**
   * Force le renouvellement de l'affichage des splats.
   *
   * Spark ne régénère que si la caméra bouge ou si un splat visible change de
   * version, et ignore un changement d'ensemble (session masquée) survenu
   * pendant un tri. Caméra immobile, l'ancien affichage resterait figé : on
   * relance donc Spark jusqu'à ce que l'affichage contienne exactement les
   * splats visibles.
   */
  invalidateSplats(): void {
    this.splatsDirty = true;
  }

  /**
   * Résout quand l'affichage est stable : splats régénérés et triés, au
   * moins `minFrames` images rendues (shaders compilés, textures envoyées).
   * `timeout` (ms) borne l'attente sur une machine lente : on n'y bloque jamais.
   */
  settle(minFrames = 3, timeout = 4000): Promise<void> {
    return new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const off = this.onCameraUpdated(() => {
        frames += 1;
        const stable = !this.splatsDirty && !this.spark.sorting;
        if (frames > minFrames && (stable || performance.now() - start > timeout)) {
          off();
          resolve();
        }
      });
    });
  }

  /** Appelé à chaque frame, avant la mise à jour de la navigation. */
  onFrame(callback: (dt: number) => void): () => void {
    this.frameCallbacks.add(callback);
    return () => this.frameCallbacks.delete(callback);
  }

  /** Appelé à chaque frame une fois la caméra définitive (overlays écran). */
  onCameraUpdated(callback: (dt: number) => void): () => void {
    this.cameraCallbacks.add(callback);
    return () => this.cameraCallbacks.delete(callback);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private frame(): void {
    const now = performance.now();
    const dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;

    this.updateFlight(now);
    this.frameCallbacks.forEach((cb) => cb(dt));
    if (this._mode === "free" && this.orbitSynced && !this.flight) this.controls.update();
    this.camera.updateMatrixWorld();
    this.cameraCallbacks.forEach((cb) => cb(dt));
    if (this.splatsDirty && !this.splatUpdatePending) {
      this.splatUpdatePending = true;
      this.spark
        .update({ scene: this.scene, camera: this.camera })
        .then(() => {
          if (this.splatDisplayUpToDate()) this.splatsDirty = false;
        })
        .catch((err) => console.error(err))
        .finally(() => (this.splatUpdatePending = false));
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** L'affichage Spark montre-t-il exactement les SplatMesh visibles ? (champs internes de Spark) */
  private splatDisplayUpToDate(): boolean {
    const spark = this.spark as unknown as { sorting: boolean; display?: { mapping?: Array<{ node: THREE.Object3D }> } };
    const shown = spark.display?.mapping?.map((m) => m.node);
    if (!shown) return true; // API interne absente : on ne force pas indéfiniment
    const visible: THREE.Object3D[] = [];
    this.scene.traverseVisible((o) => {
      if (o instanceof SplatMesh) visible.push(o);
    });
    return !spark.sorting && shown.length === visible.length && visible.every((o) => shown.includes(o));
  }

  private updateFlight(now: number): void {
    const f = this.flight;
    if (!f) return;
    const x = Math.min(1, (now - f.start) / f.duration);
    const e = easeInOutSine(x);
    this.camera.position.lerpVectors(f.from.position, f.to.position, e);
    this.camera.quaternion.slerpQuaternions(f.from.quaternion, f.to.quaternion, e);
    this.orbitSynced = false;
    this.pendingTarget = null;
    if (x >= 1) {
      this.flight = null;
      f.resolve(true);
    }
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
