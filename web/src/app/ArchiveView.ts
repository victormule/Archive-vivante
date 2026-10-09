import * as THREE from "three";
import { loadSessionManifest } from "@/data/sessionRepository";
import type { CameraView, LayerId, SceneConfig, SessionSummary } from "@/data/types";
import type { Insets } from "@/ui/annotations/AnnotationOverlay";
import { formatDayAndTime } from "@/ui/formatTime";
import { MediaLightbox } from "@/ui/MediaLightbox";
import { ANNOTATIONS_ITEM, LAYER_ITEMS, type LayerToggleItem, LayerToggles, type ToggleId } from "@/ui/LayerToggles";
import { PlayerControls } from "@/ui/PlayerControls";
import { SessionSwitcher } from "@/ui/SessionSwitcher";
import { AutoOrbit } from "@/viewer/AutoOrbit";
import { SceneViewer } from "@/viewer/SceneViewer";
import { IdleWatcher } from "./IdleWatcher";
import { SessionScene } from "./SessionScene";

export interface ArchiveViewOptions {
  /** Écart-type (s) du lissage du trajet caméra. */
  cameraSmoothing: number;
  /** Durée (ms) du fondu enchaîné entre deux sessions. */
  crossfadeDuration: number;
  /** Durée (ms) du fondu pendant la rotation automatique (plus lent, contemplatif). */
  idleCrossfadeDuration: number;
  /** Ouvre directement la scène, sans bouton « Entrer » ni plein écran (outils, captures). */
  skipEntry?: boolean;
}

/** Taille supposée d'une couche dont le manifest n'indique pas le poids. */
const DEFAULT_LAYER_BYTES = 4e6;

const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/**
 * Vue d'archive : une scène partagée où les sessions se succèdent en fondu
 * enchaîné, dans un repère commun (la caméra ne bouge pas au changement).
 *
 * Les couches (splat, photogrammétrie, nuage) et les annotations se cumulent
 * indépendamment ; le choix est conservé d'une session à l'autre.
 *
 * Tout est chargé et préparé sur le GPU avant l'affichage : changer de session
 * est ensuite instantané. Après une période d'inactivité, la caméra tourne
 * lentement autour de l'axe de la scène et les sessions se succèdent, une
 * par tour.
 */
export class ArchiveView {
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private viewer!: SceneViewer;
  private toggles: LayerToggles | null = null;
  private switcher: SessionSwitcher | null = null;
  private lightbox: MediaLightbox | null = null;
  private controls: PlayerControls | null = null;

  private readonly scenes = new Map<string, Promise<SessionScene>>();
  private current: SessionScene | null = null;
  /** Identifiant de la dernière session demandée (la plus récente gagne). */
  private requested: string | null = null;

  private readonly layerVisible: Record<LayerId, boolean> = { splat: true, mesh: false, pointCloud: false };
  private annotationsVisible = true;
  private readonly disposers: Array<() => void> = [];
  private readonly sessionDisposers: Array<() => void> = [];
  private idle: IdleWatcher | null = null;
  private orbit: AutoOrbit | null = null;

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
    this.viewer = new SceneViewer({ container: this.stage });
    this.lightbox = new MediaLightbox(this.root);
    this.setupSwitcher();
    this.disposers.push(this.viewer.onFrame(() => this.onFrame()));

    // Toutes les sessions (manifestes, trajets, annotations)
    const scenes = await Promise.all(this.sessions.map((s) => this.scene(s.id)));
    const scene = scenes.find((s) => s.id === initialId) ?? scenes[0];
    this.requested = scene.id;
    await Promise.all(scenes.map((s) => s.prepare()));
    this.setupLayerToggles(scenes);
    scenes.forEach((s) => this.applyLayerState(s));
    if (scene.path) this.viewer.setFov(scene.path.fovY);
    this.placeInitialCamera(scene);
    this.activate(scene);

    // Toutes les couches de toutes les sessions, puis préparation GPU :
    // aucune attente ni saccade ensuite, dès le premier changement de session
    try {
      await this.loadEverything(scenes, scene, (r) => (loaderBar.style.width = `${Math.round(r * 100)}%`));
      this.root.querySelector(".loader__label")!.textContent = "Préparation de l'affichage…";
      await this.warmUp(scenes, scene);
    } catch (err) {
      this.root.querySelector(".loader__label")!.textContent = "Erreur de chargement";
      throw err;
    }
    // Tout est prêt : l'écran d'accueil attend un clic, qui passe aussi en plein écran
    if (!this.options.skipEntry) await this.waitForEntry();
    this.root.classList.add("is-ready");
    window.addEventListener("keydown", this.onKeyDown);
    this.disposers.push(() => window.removeEventListener("keydown", this.onKeyDown));
    this.setupIdleOrbit();
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

  /** Charge toutes les couches ; progression pondérée par le poids des fichiers. */
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
    await Promise.all(
      jobs.map((job) =>
        job.scene
          .loadLayer(job.id, (r) => {
            job.ratio = r;
            report();
          })
          .then(() => {
            job.ratio = 1;
            report();
          }),
      ),
    );
  }

  /**
   * Préparation GPU, derrière l'écran de chargement : chaque couche de chaque
   * session est rendue en fondu (matériaux transparents, deux sessions
   * superposées) puis opaque. Shaders compilés, textures envoyées, tampons
   * Spark dimensionnés : le premier fondu est aussi fluide que les suivants.
   */
  private async warmUp(scenes: SessionScene[], current: SessionScene): Promise<void> {
    const show = (scene: SessionScene, opacity: number) => {
      for (const { id } of LAYER_ITEMS) scene.setLayerVisible(id, true);
      scene.setOpacity(opacity);
    };
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const next = scenes[(i + 1) % scenes.length];
      show(scene, 0.5);
      show(next, 0.5);
      await this.viewer.settle();
      if (next !== scene) next.setOpacity(0);
      show(scene, 1);
      await this.viewer.settle();
      scene.setOpacity(0);
    }
    scenes.forEach((s) => this.applyLayerState(s));
    current.setOpacity(1);
    await this.viewer.settle();
  }

  /** Shift+V : copie la vue courante (à coller dans `days.<n>.initial_view` de sessions.json). */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!e.shiftKey || e.code !== "KeyV" || e.ctrlKey || e.metaKey) return;
    const json = JSON.stringify(this.viewer.currentView());
    console.info("Vue courante :", json);
    navigator.clipboard?.writeText(json).then(
      () => this.toast("Vue copiée dans le presse-papiers"),
      () => this.toast("Vue affichée dans la console"),
    );
  };

  private toast(message: string): void {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    this.root.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  /** Applique une vue (outil de développement / tests). */
  setView(view: CameraView): void {
    this.viewer.cancelFlight();
    this.viewer.setView(view);
  }

  /** Change de session (outil de développement / tests). */
  showSession(id: string): Promise<void> {
    return this.switchTo(id);
  }

  dispose(): void {
    this.sessionDisposers.forEach((d) => d());
    this.disposers.forEach((d) => d());
    this.idle?.dispose();
    this.controls?.dispose();
    this.toggles?.dispose();
    this.lightbox?.dispose();
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
            insets: () => this.overlayInsets(),
            onOpenMedia: (items, index, title) => this.lightbox?.open(items, index, title),
            onLayerChange: (layerId) => this.refreshToggle(layerId),
          }),
      );
      promise.catch(() => this.scenes.delete(id));
      this.scenes.set(id, promise);
    }
    return promise;
  }

  /** Préchargement à l'intention (survol du sélecteur). */
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

    // La lecture appartient à la session : on l'arrête avant de partir
    previous.playback?.pause();
    this.deactivate(previous);
    this.activate(next);
    await this.crossfade(next, duration);
  }

  /**
   * Fondu enchaîné vers `to` : chaque autre session s'éteint depuis son
   * opacité courante (un fondu interrompu repart d'où il en était).
   */
  private async crossfade(to: SessionScene, duration: number): Promise<void> {
    const scenes = await Promise.all(this.scenes.values());
    const starts = new Map(scenes.map((s) => [s, s.currentOpacity]));
    const start = performance.now();
    this.root.classList.add("is-transitioning");
    return new Promise((resolve) => {
      const step = () => {
        // Une nouvelle demande prend la main sur ce fondu
        if (this.current !== to) return resolve();
        const x = Math.min(1, (performance.now() - start) / duration);
        const e = easeInOutCubic(x);
        for (const [scene, from] of starts) {
          scene.setOpacity(from + ((scene === to ? 1 : 0) - from) * e);
        }
        if (x < 1) requestAnimationFrame(step);
        else {
          this.root.classList.remove("is-transitioning");
          resolve();
        }
      };
      requestAnimationFrame(step);
    });
  }

  /** La session devient courante : en-tête, lecture, boutons, URL. */
  private activate(scene: SessionScene): void {
    this.current = scene;
    const { manifest } = scene;
    const day = this.sessions.find((s) => s.id === scene.id)?.day ?? manifest.day;
    this.root.querySelector(".session__title")!.textContent = `Journée ${day} · Session ${manifest.index}`;
    this.switcher?.reveal(scene.id);
    this.root.querySelector(".session__meta")!.textContent = formatDayAndTime(manifest.startDate);
    for (const s of this.sessions) this.switcher?.setState(s.id, s.id === scene.id ? "active" : "idle");
    scene.setAnnotationsVisible(this.annotationsVisible);
    this.setupPlayback(scene);
    LAYER_ITEMS.forEach(({ id }) => this.refreshToggle(id));

    const url = new URL(location.href);
    url.searchParams.set("session", scene.id);
    history.replaceState(null, "", url);
    document.title = `${manifest.title} · Performance Archive`;
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
    if (this.sceneConfig.initialView) return this.viewer.setView(this.sceneConfig.initialView);
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

    // Lecture => replay ; pause => navigation libre depuis la pose courante
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

  /**
   * Lecture précédée d'un vol lent vers la pose enregistrée à l'instant de
   * reprise (début de la vidéo, ou position de la tête de lecture).
   */
  private async startPlayback(scene: SessionScene): Promise<void> {
    const playback = scene.playback;
    if (!playback || !this.controls) return;
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
        this.current?.playback?.isPlaying === true,
      onIdle: () => this.startOrbit(),
      onActive: () => this.stopOrbit(),
    });
    this.disposers.push(this.viewer.onFrame((dt) => this.orbit?.update(dt)));
  }

  private startOrbit(): void {
    const config = this.sceneConfig.orbit;
    if (!config || this.orbit || !this.current) return;
    this.orbit = new AutoOrbit(
      this.viewer.camera,
      { center: new THREE.Vector3(...config.center), turnSeconds: config.turn_seconds ?? 80, stepDegrees: config.switch_degrees ?? 360 },
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

  /** Chaque étape de l'orbite (`switch_degrees`) : session suivante, en fondu lent. */
  private nextSessionOnTurn(): void {
    if (this.sessions.length < 2 || !this.current) return;
    const i = this.sessions.findIndex((s) => s.id === this.current!.id);
    const next = this.sessions[(i + 1) % this.sessions.length];
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
    scene.setAnnotationsVisible(this.annotationsVisible);
  }

  private setupLayerToggles(scenes: SessionScene[]): void {
    const items: LayerToggleItem[] = LAYER_ITEMS.filter((item) => scenes.some((s) => s.hasLayer(item.id)));
    if (scenes.some((s) => s.annotations)) items.push(ANNOTATIONS_ITEM);
    this.toggles = new LayerToggles(items, (id) => this.toggle(id));
    this.root.appendChild(this.toggles.element);
    LAYER_ITEMS.forEach(({ id }) => this.refreshToggle(id));
    this.toggles.setState("annotations", this.annotationsVisible ? "on" : "off");
  }

  private toggle(id: ToggleId): void {
    if (id === "annotations") {
      this.annotationsVisible = !this.annotationsVisible;
      for (const p of this.scenes.values()) p.then((s) => s.setAnnotationsVisible(this.annotationsVisible));
      this.toggles?.setState("annotations", this.annotationsVisible ? "on" : "off");
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

  /** Zones de l'écran réservées à l'interface (titre, boutons, lecteur). */
  private overlayInsets(): Insets {
    const box = this.stage.getBoundingClientRect();
    const rect = (selector: string) => this.root.querySelector(selector)?.getBoundingClientRect();
    const header = rect(".session__header");
    const layers = rect(".layers");
    const footer = this.root.classList.contains("has-playback") ? rect(".session__footer") : undefined;
    const margin = 14;
    return {
      top: header ? header.bottom - box.top + margin : margin,
      left: layers ? layers.right - box.left + margin : margin,
      right: margin + 6,
      bottom: footer ? box.bottom - footer.top + margin : margin + 10,
    };
  }
}
