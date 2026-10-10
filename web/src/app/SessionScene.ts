import * as THREE from "three";
import { loadAnnotations, loadCameraPath, sessionAssetUrl } from "@/data/sessionRepository";
import type { LayerId, MediaItem, SessionManifest } from "@/data/types";
import { CameraPath } from "@/playback/CameraPath";
import { PlaybackController } from "@/playback/PlaybackController";
import { AnnotationOverlay, type Insets } from "@/ui/annotations/AnnotationOverlay";
import type { Layer, ProgressCallback } from "@/viewer/layers/Layer";
import { MeshLayer } from "@/viewer/layers/MeshLayer";
import { PointCloudLayer } from "@/viewer/layers/PointCloudLayer";
import { SplatLayer } from "@/viewer/layers/SplatLayer";
import type { SceneViewer } from "@/viewer/SceneViewer";

export type LayerStatus = "idle" | "loading" | "ready" | "error";

interface LayerSlot {
  layer: Layer;
  status: LayerStatus;
  progress: number;
  loading: Promise<void> | null;
}

export interface SessionSceneOptions {
  viewer: SceneViewer;
  overlayContainer: HTMLElement;
  cameraSmoothing: number;
  insets: () => Insets;
  onOpenMedia: (items: MediaItem[], index: number, title: string) => void;
  onPlayAudio: (audio: Extract<MediaItem, { kind: "audio" }>, title: string) => void;
  /** Notifié à chaque changement d'état d'une couche (chargement, progression). */
  onLayerChange: (id: LayerId) => void;
}

/**
 * Contenu d'une session dans la scène partagée : couches, annotations, trajet
 * et lecture. Tout est placé dans le repère commun du projet par la
 * `worldTransform` du manifest ; l'opacité globale sert aux fondus enchaînés.
 */
export class SessionScene {
  readonly group = new THREE.Group();
  readonly worldMatrix = new THREE.Matrix4();
  path: CameraPath | null = null;
  playback: PlaybackController | null = null;
  annotations: AnnotationOverlay | null = null;

  private readonly slots = new Map<LayerId, LayerSlot>();
  private readonly layerVisible = new Map<LayerId, boolean>();
  private pathLine: THREE.Line | null = null;
  private prepared: Promise<void> | null = null;
  private opacity = 0;
  private annotationsVisible = true;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(readonly manifest: SessionManifest, private readonly options: SessionSceneOptions) {
    this.group.name = `session:${manifest.id}`;
    this.group.matrixAutoUpdate = false;
    this.worldMatrix.fromArray(manifest.worldTransform ?? new THREE.Matrix4().toArray());
    this.group.matrix.copy(this.worldMatrix);
    this.group.visible = false;

    const url = (relative: string) => sessionAssetUrl(manifest.id, relative);
    const { layers } = manifest;
    const created: Layer[] = [];
    if (layers.splat) created.push(new SplatLayer(url(layers.splat.url)));
    if (layers.mesh) created.push(new MeshLayer(url(layers.mesh.url)));
    if (layers.pointCloud) created.push(new PointCloudLayer(url(layers.pointCloud.url), layers.pointCloud));
    for (const layer of created) {
      layer.object.visible = false;
      layer.setOpacity(0);
      this.group.add(layer.object);
      this.slots.set(layer.id, { layer, status: "idle", progress: 0, loading: null });
    }
    options.viewer.scene.add(this.group);
  }

  get id(): string {
    return this.manifest.id;
  }

  /** Métadonnées légères : trajet caméra, lecture, annotations (une seule fois). */
  prepare(): Promise<void> {
    this.prepared ??= (async () => {
      const { manifest, options } = this;
      const [pathData, annotationsData] = await Promise.all([
        manifest.playback ? loadCameraPath(manifest) : null,
        loadAnnotations(manifest),
      ]);
      if (pathData) {
        this.path = new CameraPath(pathData, { smoothing: options.cameraSmoothing });
        this.playback = new PlaybackController(sessionAssetUrl(manifest.id, manifest.playback!.audioUrl), this.path.duration);
        this.createPathLine(this.path);
      }
      if (annotationsData.annotations.length > 0) {
        this.annotations = new AnnotationOverlay({
          container: options.overlayContainer,
          camera: options.viewer.camera,
          annotations: annotationsData.annotations,
          worldMatrix: this.worldMatrix,
          // La photogrammétrie sert d'écran pour atténuer les annotations cachées
          occluder: () => this.layerObject("mesh"),
          insets: options.insets,
          onOpenMedia: options.onOpenMedia,
          onPlayAudio: options.onPlayAudio,
        });
        this.annotations.setOpacity(this.opacity);
        this.annotations.setVisible(this.annotationsVisible);
        this.unsubscribe.push(options.viewer.onCameraUpdated((dt) => this.annotations?.update(dt)));
      }
    })();
    return this.prepared;
  }

  // --- Couches ---------------------------------------------------------------

  hasLayer(id: LayerId): boolean {
    return this.slots.has(id);
  }

  layerStatus(id: LayerId): LayerStatus {
    return this.slots.get(id)?.status ?? "idle";
  }

  layerProgress(id: LayerId): number {
    return this.slots.get(id)?.progress ?? 0;
  }

  layerObject(id: LayerId): THREE.Object3D | null {
    const slot = this.slots.get(id);
    return slot?.status === "ready" ? slot.layer.object : null;
  }

  loadLayer(id: LayerId, onProgress?: ProgressCallback): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return Promise.resolve();
    slot.loading ??= (async () => {
      slot.status = "loading";
      this.options.onLayerChange(id);
      try {
        await slot.layer.load((r) => {
          slot.progress = r;
          onProgress?.(r);
          this.options.onLayerChange(id);
        });
        slot.status = "ready";
        slot.layer.setOpacity(this.opacity);
        this.applyVisibility(id);
        this.options.viewer.invalidateSplats();
      } catch (err) {
        slot.status = "error";
        slot.loading = null;
        throw err;
      } finally {
        this.options.onLayerChange(id);
      }
    })();
    return slot.loading;
  }

  /** Charge toutes les couches demandées ; la progression est la moyenne. */
  loadLayers(ids: LayerId[], onProgress?: ProgressCallback): Promise<void> {
    const present = ids.filter((id) => this.slots.has(id));
    const report = () => onProgress?.(present.reduce((s, id) => s + this.layerProgress(id), 0) / Math.max(1, present.length));
    return Promise.all(present.map((id) => this.loadLayer(id, report))).then(() => onProgress?.(1));
  }

  setLayerVisible(id: LayerId, visible: boolean): void {
    this.layerVisible.set(id, visible);
    this.applyVisibility(id);
    this.options.viewer.invalidateSplats();
  }

  // --- Présence dans la scène (fondus) ---------------------------------------

  get currentOpacity(): number {
    return this.opacity;
  }

  /** Opacité globale de la session (couches, annotations, trajet). */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
    // Spark suit seul les changements d'opacité ; seule une apparition ou une
    // disparition doit être forcée (voir SceneViewer.invalidateSplats)
    const visible = opacity > 0;
    if (visible !== this.group.visible) {
      this.group.visible = visible;
      this.options.viewer.invalidateSplats();
    }
    for (const slot of this.slots.values()) slot.layer.setOpacity(opacity);
    this.annotations?.setOpacity(opacity);
    if (this.pathLine) (this.pathLine.material as THREE.LineBasicMaterial).opacity = 0.8 * opacity;
  }

  setAnnotationsVisible(visible: boolean): void {
    this.annotationsVisible = visible;
    this.annotations?.setVisible(visible);
  }

  setPathVisible(visible: boolean): void {
    if (this.pathLine) this.pathLine.visible = visible;
  }

  /** Pose caméra du trajet enregistré, dans le repère commun. */
  samplePose(t: number, position: THREE.Vector3, quaternion: THREE.Quaternion): boolean {
    if (!this.path) return false;
    this.path.sample(t, position, quaternion);
    position.applyMatrix4(this.worldMatrix);
    quaternion.premultiply(rotationOf(this.worldMatrix));
    return true;
  }

  /** Boîte englobante du splat, dans le repère commun. */
  bounds(): THREE.Box3 | null {
    const { min, max } = this.manifest.bounds;
    if (!min || !max) return null;
    return new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)).applyMatrix4(this.worldMatrix);
  }

  dispose(): void {
    this.unsubscribe.forEach((u) => u());
    this.playback?.dispose();
    this.annotations?.dispose();
    this.slots.forEach(({ layer }) => layer.dispose());
    this.pathLine?.geometry.dispose();
    this.options.viewer.scene.remove(this.group);
  }

  private applyVisibility(id: LayerId): void {
    const slot = this.slots.get(id);
    if (slot) slot.layer.object.visible = slot.status === "ready" && (this.layerVisible.get(id) ?? false);
  }

  private createPathLine(path: CameraPath): void {
    const geometry = new THREE.BufferGeometry().setFromPoints(path.polyline());
    const material = new THREE.LineBasicMaterial({ color: 0xe8b04a, transparent: true, opacity: 0.8 * this.opacity, depthTest: false });
    this.pathLine = new THREE.Line(geometry, material);
    this.pathLine.renderOrder = 1;
    this.group.add(this.pathLine);
  }
}

const tmpPosition = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpRotation = new THREE.Quaternion();

function rotationOf(matrix: THREE.Matrix4): THREE.Quaternion {
  matrix.decompose(tmpPosition, tmpRotation, tmpScale);
  return tmpRotation;
}
