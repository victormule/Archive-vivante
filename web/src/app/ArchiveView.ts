import * as THREE from "three";
import { loadPlanConfig, loadSessionManifest } from "@/data/sessionRepository";
import { placementMatrix, type PlanConfig } from "@/data/planConfig";
import type { CameraView, LayerId, Quat, SceneConfig, SessionSummary, Vec3 } from "@/data/types";
import type { Insets } from "@/ui/annotations/AnnotationOverlay";
import { formatDayAndTime } from "@/ui/formatTime";
import { AnnotationOverlay } from "@/ui/annotations/AnnotationOverlay";
import { AudioPlayer } from "@/ui/AudioPlayer";
import { ContributionFeed } from "@/ui/ContributionFeed";
import { MediaLightbox } from "@/ui/MediaLightbox";
import { ANNOTATIONS_ITEM, LAYER_ITEMS, type LayerToggleItem, LayerToggles, PLAN_ITEM, type ToggleId } from "@/ui/LayerToggles";
import { PathStarts } from "@/ui/PathStarts";
import { PlayerControls } from "@/ui/PlayerControls";
import { SessionSwitcher, sessionLabel } from "@/ui/SessionSwitcher";
import { AutoOrbit } from "@/viewer/AutoOrbit";
import { loadPlanImage, PlanFloor } from "@/viewer/PlanFloor";
import { SceneViewer } from "@/viewer/SceneViewer";
import { IdleWatcher } from "./IdleWatcher";
import { SessionScene } from "./SessionScene";

export interface ArchiveViewOptions {
  /** Écart-type (s) du lissage du trajet caméra. */
  cameraSmoothing: number;
  /** Lissage imposé (paramètre d'URL) : prime sur celui que fixe une session. */
  cameraSmoothingForced?: boolean;
  /** ms */
  crossfadeDuration: number;
  /** ms */
  idleCrossfadeDuration: number;
  /** Ouvre directement la scène, sans bouton « Entrer » ni plein écran (outils, captures). */
  skipEntry?: boolean;
}

const DEFAULT_LAYER_BYTES = 4e6;
/** Part de la barre de chargement couverte par les couches ; le reste est la préparation GPU. */
const LOAD_SHARE = 0.9;
/** Dans une couche, part du téléchargement ; le décodage (splat, glTF, BVH) complète la couche. */
const DOWNLOAD_SHARE = 0.9;

const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

export const FULL_VIEW_ID = "full";
/** Vue d'ensemble : recul horizontal et hauteur (m) de la caméra par rapport au centre du plan. */
const OVERVIEW_DISTANCE = 34;
const OVERVIEW_HEIGHT = 30;

/** Scène partagée où les sessions se succèdent en fondu ; tout est chargé et préparé sur le GPU avant l'affichage. */
export class ArchiveView {
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private viewer!: SceneViewer;
  private toggles: LayerToggles | null = null;
  private switcher: SessionSwitcher | null = null;
  private lightbox: MediaLightbox | null = null;
  private audioPlayer: AudioPlayer | null = null;
  private controls: PlayerControls | null = null;
  private feed: ContributionFeed | null = null;

  private readonly scenes = new Map<string, Promise<SessionScene>>();
  private current: SessionScene | null = null;
  /** Identifiant de la dernière session demandée (la plus récente gagne). */
  private requested: string | null = null;

  private readonly layerVisible: Record<LayerId, boolean> = { splat: true, mesh: false, pointCloud: false };
  private annotationsVisible = true;
  private planConfig: PlanConfig | null = null;
  private planFloor: PlanFloor | null = null;
  private planVisible = true;
  private full = false;
  private fullButton: HTMLButtonElement | null = null;
  private fullAnnotations: AnnotationOverlay | null = null;
  private pathStarts: PathStarts | null = null;
  /** Fondu en cours : un nouveau fondu prend la main sur le précédent. */
  private fadeToken = 0;
  private readonly disposers: Array<() => void> = [];
  private readonly sessionDisposers: Array<() => void> = [];
  private idle: IdleWatcher | null = null;
  private orbit: AutoOrbit | null = null;
  /** Couches chargées : l'audio de la session courante peut alors être mis en mémoire. */
  private loaded = false;

  constructor(
    container: HTMLElement,
    private readonly sessions: SessionSummary[],
    private readonly sceneConfig: SceneConfig,
    private readonly options: ArchiveViewOptions,
  ) {
    this.root = document.createElement("div");
    this.root.className = "session";
    this.root.innerHTML = `
      <div class="session__stage"></div>
      <div class="session__topbar"></div>
      <header class="session__header">
        <h1 class="session__title"></h1>
        <p class="session__meta"></p>
      </header>
      <div class="session__loader" role="status">
        <div class="loader__bar"><span></span></div>
        <p class="loader__label">Chargement de la session…</p>
        <button class="loader__enter" type="button" hidden>Entrer</button>
      </div>
      <p class="session__hint">Glisser : orbiter · Clic droit : déplacer · Molette : zoom</p>
      <footer class="session__footer"></footer>
    `;
    this.stage = this.root.querySelector(".session__stage")!;
    container.appendChild(this.root);
  }

  async start(initialId: string): Promise<void> {
    const loaderBar = this.root.querySelector<HTMLElement>(".loader__bar span")!;
    // La barre n'avance jamais à reculons et n'atteint 100 % qu'une fois la scène prête
    let shown = 0;
    const setProgress = (ratio: number) => {
      shown = Math.max(shown, Math.min(1, ratio));
      loaderBar.style.width = `${(shown * 100).toFixed(1)}%`;
    };
    this.viewer = new SceneViewer({ container: this.stage });
    this.viewer.setSuspended(true);
    this.viewer.renderer.domElement.addEventListener("webglcontextlost", () => {
      this.showFatal("L'affichage 3D a été interrompu (mémoire graphique saturée). Rechargez la page.");
    });
    this.lightbox = new MediaLightbox(this.root);
    this.audioPlayer = new AudioPlayer(this.root, { onStart: () => this.current?.playback?.pause() });
    if (this.sessions.some((s) => s.kind === "event")) {
      this.feed = new ContributionFeed(this.root, { onOpenMedia: (items, index, title) => this.lightbox?.open(items, index, title) });
    }
    this.setupSwitcher();
    this.disposers.push(this.viewer.onFrame(() => this.onFrame()));

    this.planConfig = await loadPlanConfig();
    const scenes = await Promise.all(this.sessions.map((s) => this.scene(s.id)));
    const scene = scenes.find((s) => s.id === initialId) ?? scenes[0];
    this.requested = scene.id;
    await Promise.all([...scenes.map((s) => s.prepare()), this.setupPlan()]);
    this.setupLayerToggles(scenes);
    scenes.forEach((s) => this.applyLayerState(s));
    if (scene.path) this.viewer.setFov(scene.path.fovY);
    this.placeInitialCamera(scene);
    this.activate(scene);
    this.setupFullView(scenes);

    try {
      await this.loadEverything(scenes, scene, (r) => setProgress(r * LOAD_SHARE));
      // Modèles prêts : l'audio de la session courante n'est plus en concurrence avec eux
      this.loaded = true;
      this.current?.playback?.preload();
      this.root.querySelector(".loader__label")!.textContent = "Préparation de l'affichage…";
      await this.warmUp(scenes, scene, (r) => setProgress(LOAD_SHARE + r * (1 - LOAD_SHARE)));
    } catch (err) {
      this.root.querySelector(".loader__label")!.textContent = "Erreur de chargement";
      throw err;
    }
    if (!this.options.skipEntry) await this.waitForEntry();
    this.viewer.setSuspended(false);
    this.root.classList.add("is-ready");
    // Le volet ne se connecte qu'une fois la scène prête : rien ne concurrence le chargement
    this.updateFeed();
    window.addEventListener("keydown", this.onKeyDown);
    this.disposers.push(() => window.removeEventListener("keydown", this.onKeyDown));
    this.setupIdleOrbit();
    if (initialId === FULL_VIEW_ID) await this.enterFull();
  }

  private async setupPlan(): Promise<void> {
    const config = this.planConfig;
    if (!config) return;
    try {
      const anisotropy = this.viewer.renderer.capabilities.getMaxAnisotropy();
      const image = await loadPlanImage(`${import.meta.env.BASE_URL}${config.svg}`, anisotropy);
      this.planFloor = new PlanFloor(image, config, config.plan);
      this.planFloor.setVisible(this.planVisible);
      this.viewer.scene.add(this.planFloor.object);
    } catch (err) {
      // Le plan est une aide à la lecture : son absence ne bloque jamais la scène
      console.error(err);
    }
  }

  /** Bouton « Entrer » : le plein écran doit être demandé dans le geste de l'utilisateur. */
  private waitForEntry(): Promise<void> {
    const button = this.root.querySelector<HTMLButtonElement>(".loader__enter")!;
    this.root.classList.add("is-waiting");
    button.hidden = false;
    button.focus();
    return new Promise((resolve) => {
      button.addEventListener(
        "click",
        () => {
          document.documentElement.requestFullscreen?.().catch(() => {});
          resolve();
        },
        { once: true },
      );
    });
  }

  /** Progression pondérée par le poids des fichiers. Un échec est retenté une fois ; seul le splat de la session d'arrivée est indispensable. */
  private async loadEverything(scenes: SessionScene[], first: SessionScene, onProgress: (ratio: number) => void): Promise<void> {
    const jobs = [first, ...scenes.filter((s) => s !== first)].flatMap((scene) =>
      LAYER_ITEMS.filter(({ id }) => scene.hasLayer(id)).map(({ id }) => ({
        scene,
        id,
        bytes: scene.manifest.layers[id]?.bytes ?? DEFAULT_LAYER_BYTES,
        ratio: 0,
      })),
    );
    const total = jobs.reduce((sum, j) => sum + j.bytes, 0);
    const report = () => onProgress(jobs.reduce((sum, j) => sum + j.bytes * j.ratio, 0) / total);
    const run = async (job: (typeof jobs)[number]) => {
      const progress = (r: number) => {
        job.ratio = Math.min(1, r) * DOWNLOAD_SHARE;
        report();
      };
      try {
        await job.scene.loadLayer(job.id, progress).catch((err) => {
          console.warn(`Couche ${job.id} de ${job.scene.id} : nouvel essai`, err);
          return job.scene.loadLayer(job.id, progress);
        });
      } catch (err) {
        if (job.scene === first && job.id === "splat") throw err;
        console.error(err);
      }
      job.ratio = 1;
      report();
    };
    await Promise.all(jobs.map(run));
  }

  /**
   * Chaque couche de chaque session est rendue une fois derrière l'écran de chargement (en fondu puis opaque) :
   * shaders compilés, textures envoyées, tampons Spark dimensionnés.
   */
  private async warmUp(scenes: SessionScene[], current: SessionScene, onProgress: (ratio: number) => void): Promise<void> {
    const show = (scene: SessionScene, opacity: number) => {
      for (const { id } of LAYER_ITEMS) scene.setLayerVisible(id, true);
      scene.setOpacity(opacity);
    };
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const next = scenes[(i + 1) % scenes.length];
      // Chaque session a son lieu : la caméra s'y place, sinon rien n'y serait rendu (hors champ)
      const view = this.siteView(scene);
      if (view) this.viewer.setView(view);
      show(scene, 0.5);
      show(next, 0.5);
      await this.viewer.settle();
      if (next !== scene) next.setOpacity(0);
      show(scene, 1);
      await this.viewer.settle();
      scene.setOpacity(0);
      onProgress((i + 1) / (scenes.length + 1));
    }
    scenes.forEach((s) => this.applyLayerState(s));
    this.placeInitialCamera(current);
    current.setOpacity(1);
    await this.viewer.settle();
    onProgress(1);
  }

  /**
   * Shift+V : copie la vue courante (à coller dans `scene.initial_view` de
   * sessions.json), ramenée dans le repère commun des sessions.
   */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!e.shiftKey || e.code !== "KeyV" || e.ctrlKey || e.metaKey) return;
    const view = this.viewer.currentView();
    const json = JSON.stringify(this.current ? transformView(view, this.current.placement.clone().invert()) : view);
    console.info("Vue courante :", json);
    navigator.clipboard?.writeText(json).then(
      () => this.toast("Vue copiée dans le presse-papiers"),
      () => this.toast("Vue affichée dans la console"),
    );
  };

  private showFatal(message: string): void {
    if (this.root.querySelector(".app-error")) return;
    const el = document.createElement("div");
    el.className = "app-error";
    el.textContent = message;
    this.root.appendChild(el);
  }

  private toast(message: string): void {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    this.root.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  dispose(): void {
    this.sessionDisposers.forEach((d) => d());
    this.disposers.forEach((d) => d());
    this.idle?.dispose();
    this.controls?.dispose();
    this.toggles?.dispose();
    this.lightbox?.dispose();
    this.audioPlayer?.dispose();
    this.feed?.dispose();
    this.planFloor?.dispose();
    for (const p of this.scenes.values()) p.then((s) => s.dispose());
    this.viewer?.dispose();
    this.root.remove();
  }

  // --- Sessions ----------------------------------------------------------------

  private scene(id: string): Promise<SessionScene> {
    let promise = this.scenes.get(id);
    if (!promise) {
      promise = loadSessionManifest(id).then(
        (manifest) =>
          new SessionScene(manifest, {
            viewer: this.viewer,
            overlayContainer: this.stage,
            cameraSmoothing: this.options.cameraSmoothing,
            cameraSmoothingForced: this.options.cameraSmoothingForced === true,
            placement: this.placementOf(id),
            insets: () => this.overlayInsets(),
            onOpenMedia: (items, index, title) => this.lightbox?.open(items, index, title),
            onPlayAudio: (audio, title) => this.audioPlayer?.open(audio, title),
            onLayerChange: (layerId) => this.refreshToggle(layerId),
          }),
      );
      promise.catch(() => this.scenes.delete(id));
      this.scenes.set(id, promise);
    }
    return promise;
  }

  private placementOf(id: string): THREE.Matrix4 | undefined {
    const config = this.planConfig;
    const placement = config?.sessions[id];
    return config && placement ? placementMatrix(placement, config.plan.floor) : undefined;
  }

  private siteView(scene: SessionScene): CameraView | null {
    const view = scene.manifest.view ?? this.sceneConfig.initialView;
    return view ? transformView(view, scene.placement) : null;
  }

  private orbitCenter(scene: SessionScene): THREE.Vector3 | null {
    const config = scene.manifest.orbit ?? this.sceneConfig.orbit;
    return config ? new THREE.Vector3(...config.center).applyMatrix4(scene.placement) : null;
  }

  /** Renvoie la durée du fondu, allongée s'il le faut pour couvrir le trajet de la caméra. */
  private travel(from: SessionScene, to: SessionScene, duration: number): number {
    if (this.orbit) {
      const center = this.orbitCenter(to);
      if (center) this.orbit.moveCenter(center, duration / 1000);
      return duration;
    }
    // L'Event a sa propre vue : on la rejoint, et celle des sessions en le quittant ;
    // ailleurs, la caméra garde son cadrage, transporté d'un lieu à l'autre
    const view = to.manifest.view || from.manifest.view
      ? this.siteView(to)
      : transformView(this.viewer.currentView(), to.placement.clone().multiply(from.placement.clone().invert()));
    return this.travelTo(view, duration);
  }

  private travelTo(view: CameraView | null, duration: number): number {
    if (!view) return duration;
    const position = new THREE.Vector3(...view.position);
    const quaternion = new THREE.Quaternion(...view.quaternion);
    const { camera } = this.viewer;
    if (camera.position.distanceTo(position) < 0.01 && camera.quaternion.angleTo(quaternion) < 1e-3) return duration;
    const flight = this.viewer.flightDuration(position, quaternion);
    void this.flyToView(view, flight);
    return Math.max(duration, flight * 1000);
  }

  // --- Vue d'ensemble -------------------------------------------------------------

  private setupFullView(scenes: SessionScene[]): void {
    if (scenes.length < 2) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sessions-full";
    button.dataset.state = "idle";
    button.innerHTML = `<span class="sessions__name">Toutes les sessions</span><span class="sessions__time">vue d'ensemble</span>`;
    button.setAttribute("aria-label", "Toutes les sessions, réunies dans le bâtiment");
    button.addEventListener("click", () => {
      if (!this.full) this.enterFull().catch((err) => console.error(err));
    });
    this.root.querySelector(".session__topbar")!.appendChild(button);
    this.fullButton = button;

    const annotations = scenes.flatMap((s) => s.worldAnnotations().map((a) => ({ ...a, tag: sessionTag(s.manifest) })));
    if (annotations.length > 0) {
      const occluder = new MultiOccluder(() => scenes.map((s) => s.layerObject("mesh")).filter((o): o is THREE.Object3D => o !== null));
      this.fullAnnotations = new AnnotationOverlay({
        container: this.stage,
        camera: this.viewer.camera,
        annotations,
        occluder: () => occluder,
        insets: () => this.overlayInsets(),
        onOpenMedia: (items, index, title) => this.lightbox?.open(items, index, title),
        onPlayAudio: (audio, title) => this.audioPlayer?.open(audio, title),
      });
      this.fullAnnotations.setOpacity(0);
      this.disposers.push(() => this.fullAnnotations?.dispose());
    }

    const starts = scenes.flatMap((s) => {
      const position = s.playback ? s.startPosition() : null;
      return position ? [{ id: s.id, label: sessionLabel(s.manifest), position }] : [];
    });
    if (starts.length > 0) {
      // Les trajets ne se montrent qu'au survol de leur départ : tous ensemble, ils brouillent la vue
      this.pathStarts = new PathStarts(
        this.stage,
        this.viewer.camera,
        starts,
        (id) => this.playFromFull(id).catch((err) => console.error(err)),
        (id) => {
          if (!this.full) return;
          for (const s of scenes) s.forcePathVisible(s.id === id);
        },
      );
      this.disposers.push(() => this.pathStarts?.dispose());
    }
    const fade = this.planConfig?.fullFade;
    if (fade) {
      for (const s of scenes) {
        const center = s.manifest.kind === "event" ? null : this.orbitCenter(s);
        if (center) s.configureSplatFade(center, fade.inner, fade.outer);
      }
    }
    this.disposers.push(this.viewer.onCameraUpdated((dt) => {
      this.fullAnnotations?.update(dt);
      this.pathStarts?.update();
    }));
  }

  private async enterFull(): Promise<void> {
    const previous = this.current;
    if (!previous || this.full || !this.fullButton) return;
    this.requested = FULL_VIEW_ID;
    previous.playback?.pause();
    this.audioPlayer?.close();
    this.deactivate(previous);
    this.setFull(true);
    let duration = this.options.crossfadeDuration;
    if (this.orbit) {
      const center = this.overviewCenter();
      this.orbit.moveCenter(center, duration / 1000);
    } else {
      duration = this.travelTo(this.overviewView(), duration);
    }
    await this.fade(() => 1, duration);
  }

  private setFull(full: boolean): void {
    if (full === this.full) return;
    this.full = full;
    if (this.fullButton) {
      this.fullButton.dataset.state = full ? "active" : "idle";
      this.fullButton.setAttribute("aria-current", String(full));
    }
    this.fullAnnotations?.setOpacity(full ? 1 : 0);
    this.fullAnnotations?.setVisible(this.annotationsVisible);
    this.pathStarts?.setVisible(full);
    this.pathStarts?.setActive(null);
    for (const p of this.scenes.values()) {
      p.then((s) => {
        this.applyAnnotationVisibility(s);
        s.forcePathVisible(full ? false : null);
      });
    }
    if (!full) return;
    for (const s of this.sessions) this.switcher?.setState(s.id, "idle");
    this.root.querySelector(".session__title")!.textContent = "Toutes les sessions";
    this.root.querySelector(".session__meta")!.textContent = "Chaque session à son endroit du bâtiment";
    this.updateFeed();
    const url = new URL(location.href);
    url.searchParams.set("session", FULL_VIEW_ID);
    history.replaceState(null, "", url);
    document.title = "Toutes les sessions · Performance Archive";
  }

  private async playFromFull(id: string): Promise<void> {
    if (!this.full) return;
    const scene = await this.scene(id);
    if (this.current !== scene || !this.controls) {
      this.current?.playback?.pause();
      if (this.current) this.deactivate(this.current);
      this.current = scene;
      this.setupPlayback(scene);
      scene.playback?.preload();
    }
    this.pathStarts?.setActive(id);
    this.root.querySelector(".session__meta")!.textContent = `${sessionLabel(scene.manifest)} · ${formatDayAndTime(scene.manifest.startDate)}`;
    scene.playback?.seek(0);
    await this.startPlayback(scene);
  }

  private overviewCenter(): THREE.Vector3 {
    const plan = this.planConfig?.plan;
    if (plan) return new THREE.Vector3(plan.center[0], plan.floor, plan.center[1]);
    return (this.current && this.orbitCenter(this.current)) ?? new THREE.Vector3();
  }

  private overviewView(): CameraView {
    const center = this.overviewCenter();
    const initial = this.sceneConfig.initialView;
    const forward = initial ? new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...initial.quaternion)) : new THREE.Vector3(0, 0, -1);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const position = center.clone().addScaledVector(forward, -OVERVIEW_DISTANCE).setY(center.y + OVERVIEW_HEIGHT);
    const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(position, center, new THREE.Vector3(0, 1, 0)));
    return {
      position: position.toArray() as Vec3,
      quaternion: quaternion.toArray() as Quat,
      target: center.toArray() as Vec3,
    };
  }

  private applyAnnotationVisibility(scene: SessionScene): void {
    scene.setAnnotationsVisible(this.annotationsVisible && !this.full);
  }

  private async prefetch(id: string): Promise<void> {
    if (id === this.current?.id) return;
    const scene = await this.scene(id);
    await scene.prepare();
    this.applyLayerState(scene);
    scene.loadLayers(this.visibleLayers(scene)).catch((err) => console.error(err));
  }

  private async switchTo(id: string, duration = this.options.crossfadeDuration): Promise<void> {
    if (!this.current || id === this.requested) return;
    this.requested = id;
    const previous = this.current;

    const next = await this.scene(id);
    await next.prepare();
    this.applyLayerState(next);
    await next.loadLayers(this.visibleLayers(next), (r) => {
      if (this.requested === id) this.switcher?.setState(id, "loading", r);
    });
    if (this.requested !== id) return; // une autre session a été demandée entre-temps

    previous.playback?.pause();
    this.audioPlayer?.close();
    this.deactivate(previous);
    const fromFull = this.full;
    this.setFull(false);
    this.activate(next);
    if (fromFull) duration = this.travelTo(this.siteView(next), duration);
    else if (next !== previous) duration = this.travel(previous, next, duration);
    await this.crossfade(next, duration);
  }

  private async flyToView(view: CameraView, duration?: number): Promise<void> {
    this.stopOrbit();
    const position = new THREE.Vector3(...view.position);
    const quaternion = new THREE.Quaternion(...view.quaternion);
    if (await this.viewer.flyTo(position, quaternion, duration ?? this.viewer.flightDuration(position, quaternion))) this.viewer.setView(view);
  }

  /** Un fondu interrompu repart de l'opacité courante. */
  private crossfade(to: SessionScene, duration: number): Promise<void> {
    return this.fade((scene) => (scene === to ? 1 : 0), duration);
  }

  private async fade(target: (scene: SessionScene) => number, duration: number): Promise<void> {
    const token = ++this.fadeToken;
    const scenes = await Promise.all(this.scenes.values());
    const starts = new Map(scenes.map((s) => [s, s.currentOpacity]));
    const fadeStarts = new Map(scenes.map((s) => [s, s.splatFadeStrength]));
    const fadeTarget = (s: SessionScene) => (this.full && s.manifest.kind !== "event" ? 1 : 0);
    const start = performance.now();
    return new Promise((resolve) => {
      const step = () => {
        if (token !== this.fadeToken) return resolve();
        const x = Math.min(1, (performance.now() - start) / duration);
        const e = easeInOutCubic(x);
        for (const [scene, from] of starts) {
          scene.setOpacity(from + (target(scene) - from) * e);
          const fadeFrom = fadeStarts.get(scene)!;
          scene.setSplatFadeStrength(fadeFrom + (fadeTarget(scene) - fadeFrom) * e);
        }
        if (x < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  private activate(scene: SessionScene): void {
    this.current = scene;
    const { manifest } = scene;
    const day = this.sessions.find((s) => s.id === scene.id)?.day ?? manifest.day;
    this.root.querySelector(".session__title")!.textContent = `Journée ${day} · ${sessionLabel(manifest)}`;
    this.switcher?.reveal(scene.id);
    this.root.querySelector(".session__meta")!.textContent = formatDayAndTime(manifest.startDate);
    for (const s of this.sessions) this.switcher?.setState(s.id, s.id === scene.id ? "active" : "idle");
    this.applyAnnotationVisibility(scene);
    if (this.loaded) scene.playback?.preload();
    this.setupPlayback(scene);
    LAYER_ITEMS.forEach(({ id }) => this.refreshToggle(id));
    this.updateFeed();

    const url = new URL(location.href);
    url.searchParams.set("session", scene.id);
    history.replaceState(null, "", url);
    document.title = `${manifest.title} · Performance Archive`;
  }

  private updateFeed(): void {
    const scene = this.current;
    const isEvent = scene !== null && this.sessions.find((s) => s.id === scene.id)?.kind === "event";
    this.feed?.setAvailable(isEvent && this.root.classList.contains("is-ready"));
  }

  private deactivate(scene: SessionScene): void {
    this.viewer.cancelFlight();
    this.sessionDisposers.splice(0).forEach((d) => d());
    this.controls?.dispose();
    this.controls = null;
    scene.setPathVisible(false);
    // La rotation automatique continue d'une session à l'autre
    if (this.viewer.mode === "replay") this.viewer.setMode("free");
    this.root.classList.remove("is-replay", "has-playback");
  }

  private placeInitialCamera(scene: SessionScene): void {
    const view = this.siteView(scene);
    if (view) return this.viewer.setView(view);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    if (scene.samplePose(0, position, quaternion)) {
      this.viewer.setPose(position, quaternion);
    } else {
      const box = scene.bounds();
      if (box) this.viewer.frameBox(box);
    }
  }

  private setupSwitcher(): void {
    if (this.sessions.length < 2) return;
    this.switcher = new SessionSwitcher(
      this.sessions,
      (id) => this.switchTo(id).catch((err) => console.error(err)),
      (id) => this.prefetch(id).catch((err) => console.error(err)),
    );
    this.root.querySelector(".session__topbar")!.appendChild(this.switcher.element);
    this.root.classList.add("has-sessions");
  }

  // --- Lecture -------------------------------------------------------------------

  private setupPlayback(scene: SessionScene): void {
    const playback = scene.playback;
    scene.setPathVisible(!this.orbit);
    if (!playback) return;

    const controls = new PlayerControls(playback, {
      play: () => this.startPlayback(scene).catch((err) => console.error("Lecture impossible", err)),
      cancel: () => this.viewer.cancelFlight(),
    });
    this.controls = controls;
    this.root.querySelector(".session__footer")!.appendChild(controls.element);
    this.root.classList.add("has-playback");

    this.sessionDisposers.push(playback.onChange(() => {
      const replay = playback.isPlaying;
      scene.setPathVisible(!replay);
      this.viewer.setMode(replay ? "replay" : "free");
      this.root.classList.toggle("is-replay", replay);
    }));

    // Un déplacement de la timeline en pause recale aussi la caméra
    const scrubber = controls.element.querySelector("input")!;
    const onScrub = () => {
      if (!playback.isPlaying) this.applyPose(scene, playback.currentTime);
    };
    scrubber.addEventListener("input", onScrub);
    this.sessionDisposers.push(() => scrubber.removeEventListener("input", onScrub));
  }

  /** La lecture est précédée d'un vol vers la pose enregistrée à l'instant de reprise. */
  private async startPlayback(scene: SessionScene): Promise<void> {
    const playback = scene.playback;
    if (!playback || !this.controls) return;
    this.audioPlayer?.close();
    const t = playback.state === "ended" ? 0 : playback.currentTime;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    if (!scene.samplePose(t, position, quaternion)) return playback.play();

    const controls = this.controls;
    this.stopOrbit();
    controls.setPending(true);
    scene.setPathVisible(false);
    this.viewer.setMode("replay");
    this.root.classList.add("is-replay");
    const arrived = await this.viewer.flyTo(position, quaternion, this.viewer.flightDuration(position, quaternion));
    controls.setPending(false);
    if (!arrived || this.current !== scene) {
      // Vol interrompu : retour à la navigation libre là où l'on se trouve
      if (this.current === scene && !playback.isPlaying) {
        this.viewer.setMode("free");
        scene.setPathVisible(true);
        this.root.classList.remove("is-replay");
      }
      return;
    }
    if (playback.state === "ended") playback.seek(0);
    await playback.play();
  }

  private onFrame(): void {
    const scene = this.current;
    const playback = scene?.playback;
    if (!scene || !playback || !this.controls) return;
    const t = playback.currentTime;
    if (this.viewer.mode === "replay" && playback.isPlaying) this.applyPose(scene, t);
    this.controls.update(t);
  }

  private readonly pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

  private applyPose(scene: SessionScene, t: number): void {
    if (scene.samplePose(t, this.pose.position, this.pose.quaternion)) {
      this.viewer.setPose(this.pose.position, this.pose.quaternion);
    }
  }

  // --- Rotation automatique -----------------------------------------------------

  private setupIdleOrbit(): void {
    const config = this.sceneConfig.orbit;
    if (!config) return;
    this.idle = new IdleWatcher({
      timeout: (config.idle_seconds ?? 30) * 1000,
      isBusy: () =>
        this.viewer.isFlying ||
        this.viewer.mode === "replay" ||
        this.lightbox?.isOpen === true ||
        this.audioPlayer?.isOpen === true ||
        this.current?.playback?.isPlaying === true,
      onIdle: () => this.startOrbit(),
      onActive: () => this.stopOrbit(),
    });
    this.disposers.push(this.viewer.onFrame((dt) => this.orbit?.update(dt)));
  }

  private startOrbit(): void {
    const base = this.sceneConfig.orbit;
    if (!base || this.orbit || !this.current) return;
    const config = this.current.manifest.orbit ?? base;
    this.orbit = new AutoOrbit(
      this.viewer.camera,
      this.full
        ? {
          center: this.overviewCenter(),
          turnSeconds: (base.turn_seconds ?? 80) * 2,
          radius: { min: OVERVIEW_DISTANCE * 0.7, max: OVERVIEW_DISTANCE * 1.3 },
          height: { min: OVERVIEW_HEIGHT * 0.6, max: OVERVIEW_HEIGHT * 1.3 },
        }
        : {
          center: this.orbitCenter(this.current) ?? new THREE.Vector3(...config.center),
          turnSeconds: config.turn_seconds ?? base.turn_seconds ?? 80,
          stepDegrees: config.switch_degrees ?? base.switch_degrees ?? 360,
          radius: config.radius,
          height: config.height,
        },
      () => this.nextSessionOnTurn(),
    );
    this.viewer.setMode("auto");
    this.current.setPathVisible(false);
    this.root.classList.add("is-idle");
  }

  /** Reprise en main : l'orbite manuelle repart de la pose atteinte, sans à-coup. */
  private stopOrbit(): void {
    const orbit = this.orbit;
    if (!orbit) return;
    this.orbit = null;
    const { camera } = this.viewer;
    this.viewer.setView({
      position: camera.position.toArray() as CameraView["position"],
      quaternion: camera.quaternion.toArray() as CameraView["quaternion"],
      target: orbit.focus(new THREE.Vector3()).toArray() as CameraView["target"],
    });
    this.viewer.setMode("free");
    this.current?.setPathVisible(true);
    this.root.classList.remove("is-idle");
  }

  private nextSessionOnTurn(): void {
    // L'Event se contemple seul, la vue d'ensemble aussi ; les sessions se succèdent entre elles
    if (!this.current || this.full || this.current.manifest.kind === "event") return;
    const cycle = this.sessions.filter((s) => s.kind !== "event");
    if (cycle.length < 2) return;
    const i = cycle.findIndex((s) => s.id === this.current!.id);
    const next = cycle[(i + 1) % cycle.length];
    this.switchTo(next.id, this.options.idleCrossfadeDuration)
      .then(() => this.current?.setPathVisible(!this.orbit))
      .catch((err) => console.error(err));
  }

  // --- Couches -------------------------------------------------------------------

  private visibleLayers(scene: SessionScene): LayerId[] {
    return LAYER_ITEMS.map((i) => i.id).filter((id) => this.layerVisible[id] && scene.hasLayer(id));
  }

  private applyLayerState(scene: SessionScene): void {
    for (const { id } of LAYER_ITEMS) scene.setLayerVisible(id, this.layerVisible[id]);
    this.applyAnnotationVisibility(scene);
  }

  private setupLayerToggles(scenes: SessionScene[]): void {
    const items: LayerToggleItem[] = LAYER_ITEMS.filter((item) => scenes.some((s) => s.hasLayer(item.id)));
    const hasAnnotations = scenes.some((s) => s.annotations);
    if (hasAnnotations) items.push(ANNOTATIONS_ITEM);
    if (this.planFloor) items.push({ ...PLAN_ITEM, groupStart: !hasAnnotations });
    this.toggles = new LayerToggles(items, (id) => this.toggle(id));
    this.root.appendChild(this.toggles.element);
    LAYER_ITEMS.forEach(({ id }) => this.refreshToggle(id));
    this.toggles.setState("annotations", this.annotationsVisible ? "on" : "off");
    this.toggles.setState("plan", this.planVisible ? "on" : "off");
  }

  private toggle(id: ToggleId): void {
    if (id === "annotations") {
      this.annotationsVisible = !this.annotationsVisible;
      for (const p of this.scenes.values()) p.then((s) => this.applyAnnotationVisibility(s));
      this.fullAnnotations?.setVisible(this.annotationsVisible);
      this.toggles?.setState("annotations", this.annotationsVisible ? "on" : "off");
      return;
    }
    if (id === "plan") {
      this.planVisible = !this.planVisible;
      this.planFloor?.setVisible(this.planVisible);
      this.toggles?.setState("plan", this.planVisible ? "on" : "off");
      return;
    }
    this.layerVisible[id] = !this.layerVisible[id];
    for (const p of this.scenes.values()) p.then((s) => s.setLayerVisible(id, this.layerVisible[id]));
    if (this.layerVisible[id]) this.current?.loadLayer(id).catch((err) => console.error(err));
    this.refreshToggle(id);
  }

  private refreshToggle(id: LayerId): void {
    const scene = this.current;
    if (!scene || !this.toggles) return;
    const status = scene.layerStatus(id);
    const state = !this.layerVisible[id] ? "off" : status === "error" ? "error" : status === "ready" ? "on" : "loading";
    this.toggles.setState(id, state, scene.layerProgress(id));
  }

  private overlayInsets(): Insets {
    const box = this.stage.getBoundingClientRect();
    const rect = (selector: string) => this.root.querySelector(selector)?.getBoundingClientRect();
    const header = rect(".session__header");
    const layers = rect(".layers");
    const footer = this.root.classList.contains("has-playback") ? rect(".session__footer") : undefined;
    const feed = this.feed?.isOpen ? this.feed.element.getBoundingClientRect() : undefined;
    const margin = 14;
    return {
      top: header ? header.bottom - box.top + margin : margin,
      left: layers ? layers.right - box.left + margin : margin,
      right: Math.max(margin + 6, feed ? box.right - feed.left + margin : 0),
      bottom: footer ? box.bottom - footer.top + margin : margin + 10,
    };
  }
}

function sessionTag(session: { kind?: string; index: number }): string {
  return session.kind === "event" ? "Év" : `S${session.index}`;
}

function transformView(view: CameraView, matrix: THREE.Matrix4): CameraView {
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(matrix));
  return {
    ...view,
    position: new THREE.Vector3(...view.position).applyMatrix4(matrix).toArray() as Vec3,
    quaternion: new THREE.Quaternion(...view.quaternion).premultiply(rotation).toArray() as Quat,
    target: new THREE.Vector3(...view.target).applyMatrix4(matrix).toArray() as Vec3,
  };
}

/** Occultation par les maillages de plusieurs sessions, testés chacun à son tour. */
class MultiOccluder extends THREE.Object3D {
  constructor(private readonly parts: () => THREE.Object3D[]) {
    super();
  }

  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    for (const part of this.parts()) raycaster.intersectObject(part, true, intersects);
  }
}
