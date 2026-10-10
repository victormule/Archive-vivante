import * as THREE from "three";
import type { Annotation, MediaItem } from "@/data/types";
import { annotationMedia } from "./annotationMedia";
import { layoutLabels, leaderPath, type LayoutBounds, type Side } from "./labelLayout";

/** Couleurs des étiquettes, attribuées dans l'ordre des annotations. */
const PALETTE = ["#4f9066", "#d99a35", "#3f74b5", "#7b5bb5", "#c25a87", "#3e8f93", "#b8613a"];

/** Intervalle (ms) entre deux tests d'occlusion. */
const OCCLUSION_INTERVAL = 150;
/** Vitesse de lissage des déplacements d'étiquettes (1/s). */
const FOLLOW_RATE = 14;

const MEDIA_LABEL = { image: "Agrandir l'image", video: "Agrandir la vidéo", pdf: "Ouvrir le document" } as const;

const PLAY_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>`;

/** 75 -> « 1:15 ». */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const PIN_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c-2.5 0-4.5 2-4.5 4.5 0 3.4 4.5 8.6 4.5 8.6s4.5-5.2 4.5-8.6c0-2.5-2-4.5-4.5-4.5zM8 4.1a1.95 1.95 0 1 0 0 3.9 1.95 1.95 0 0 0 0-3.9z" fill="currentColor" fill-rule="evenodd"/></svg>`;

export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface AnnotationOverlayOptions {
  container: HTMLElement;
  camera: THREE.Camera;
  annotations: Annotation[];
  /** Repère de la session -> repère commun (les points sont dans le repère de la session). */
  worldMatrix?: THREE.Matrix4;
  /** Géométrie servant aux tests d'occlusion (null si indisponible). */
  occluder: () => THREE.Object3D | null;
  /** Marges à laisser libres (boutons, barre de lecture…). */
  insets: () => Insets;
  onOpenMedia: (items: MediaItem[], index: number, title: string) => void;
  /** Un audio d'annotation a été cliqué : le lecteur s'ouvre et l'écoute commence. */
  onPlayAudio: (audio: Extract<MediaItem, { kind: "audio" }>, title: string) => void;
}

interface Pin {
  data: Annotation;
  anchor: THREE.Vector3;
  dot: HTMLButtonElement;
  label: HTMLDivElement;
  leader: SVGPathElement;
  side?: Side;
  /** Point d'ancrage projeté (pixels). */
  ax: number;
  ay: number;
  /** Position lissée de l'étiquette (pixels). */
  x: number;
  y: number;
  placed: boolean;
  collapsedHeight: number;
  visible: boolean;
  occluded: boolean;
  hovered: boolean;
  pinned: boolean;
  /** Vidéos de l'étiquette : lues en boucle, sans le son, tant qu'elle est dépliée. */
  videos: HTMLVideoElement[];
}

/**
 * Annotations spatialisées : un point sur la scène, une étiquette rangée en
 * bord d'écran et un fil qui les relie. Au survol (ou au clic), l'étiquette
 * se déplie : texte et images.
 */
export class AnnotationOverlay {
  readonly element: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly pins: Pin[];
  private readonly raycaster = new THREE.Raycaster();
  private readonly projected = new THREE.Vector3();
  private lastOcclusion = 0;
  private _visible = true;
  private inert = false;

  constructor(private readonly options: AnnotationOverlayOptions) {
    this.element = document.createElement("div");
    this.element.className = "annotations";
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("annotations__leaders");
    this.svg.setAttribute("aria-hidden", "true");
    this.element.appendChild(this.svg);

    this.pins = options.annotations
      .filter((a) => a.points.length > 0)
      .map((a, i) => this.createPin(a, a.color ?? PALETTE[(a.colorIndex ?? i) % PALETTE.length]));
    options.container.appendChild(this.element);
  }

  get visible(): boolean {
    return this._visible;
  }

  setVisible(visible: boolean): void {
    this._visible = visible;
    this.element.classList.toggle("is-hidden", !visible);
    this.syncVideos();
  }

  /** Opacité globale (fondus entre sessions) ; inactif à 0. */
  setOpacity(opacity: number): void {
    this.element.style.setProperty("--session-opacity", String(opacity));
    const inert = opacity < 0.5;
    this.element.classList.toggle("is-inert", inert);
    // Une session estompée ne fait pas tourner ses vidéos en arrière-plan
    if (inert !== this.inert) {
      this.inert = inert;
      this.syncVideos();
    }
  }

  /** À appeler à chaque frame, une fois la caméra à jour. */
  update(dt: number): void {
    if (!this._visible || this.pins.length === 0) return;
    const { container, camera } = this.options;
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.projectAnchors(width, height);
    this.updateOcclusion(camera);

    const insets = this.options.insets();
    const bounds: LayoutBounds = { width, height, ...insets, gap: 8, hysteresis: 0.12 };
    const visible = this.pins.filter((p) => p.visible);

    for (const pin of visible) {
      if (!pin.hovered && !pin.pinned) pin.collapsedHeight = pin.label.offsetHeight;
    }
    const placements = layoutLabels(
      visible.map((p) => ({
        id: p.data.id,
        anchorX: p.ax,
        anchorY: p.ay,
        width: p.label.offsetWidth,
        height: p.collapsedHeight,
        previousSide: p.side,
      })),
      bounds,
    );

    const follow = 1 - Math.exp(-dt * FOLLOW_RATE);
    for (const placement of placements) {
      const pin = visible.find((p) => p.data.id === placement.id)!;
      const expanded = pin.hovered || pin.pinned;
      const labelHeight = pin.label.offsetHeight;
      // Une étiquette dépliée reste entièrement à l'écran
      let targetY = placement.y;
      if (expanded) targetY = Math.max(insets.top, Math.min(targetY, height - insets.bottom - labelHeight));

      if (!pin.placed || pin.side !== placement.side) {
        pin.x = placement.x;
        pin.y = targetY;
        pin.placed = true;
      } else {
        pin.x += (placement.x - pin.x) * follow;
        pin.y += (targetY - pin.y) * follow;
      }
      pin.side = placement.side;
      pin.label.dataset.side = placement.side;
      pin.label.style.transform = `translate3d(${pin.x.toFixed(1)}px, ${pin.y.toFixed(1)}px, 0)`;

      // Le fil rejoint le milieu de la ligne de titre, côté intérieur
      const lx = placement.side === "left" ? pin.x + pin.label.offsetWidth : pin.x;
      const ly = pin.y + Math.min(pin.collapsedHeight, labelHeight) / 2;
      pin.leader.setAttribute("d", leaderPath(pin.ax, pin.ay, lx, ly));
    }
  }

  dispose(): void {
    this.element.remove();
  }

  // --- Construction ----------------------------------------------------------

  private createPin(data: Annotation, color: string): Pin {
    const [x, y, z] = averagePoint(data.points);
    const anchor = new THREE.Vector3(x, y, z);
    if (this.options.worldMatrix) anchor.applyMatrix4(this.options.worldMatrix);

    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "annotation-dot";
    dot.style.setProperty("--color", color);
    dot.setAttribute("aria-label", `Annotation : ${data.title}`);

    const label = document.createElement("div");
    label.className = "annotation-label";
    label.style.setProperty("--color", color);
    label.tabIndex = 0;
    label.setAttribute("role", "button");
    label.setAttribute("aria-expanded", "false");
    label.innerHTML = `
      <div class="annotation-label__head">${PIN_ICON}<span class="annotation-label__title"></span></div>
      <div class="annotation-label__detail"><div class="annotation-label__inner"></div></div>
    `;
    label.querySelector(".annotation-label__title")!.textContent = data.title || "Sans titre";
    const videos: HTMLVideoElement[] = [];
    this.fillDetail(label.querySelector<HTMLElement>(".annotation-label__inner")!, data, videos);

    const leader = document.createElementNS("http://www.w3.org/2000/svg", "path");
    leader.classList.add("annotation-leader");
    leader.style.setProperty("--color", color);
    this.svg.appendChild(leader);
    this.element.append(dot, label);
    // Masqués jusqu'à la première projection
    for (const el of [dot, label, leader]) el.classList.add("is-offscreen");

    const pin: Pin = {
      data, anchor, dot, label, leader,
      ax: 0, ay: 0, x: 0, y: 0, placed: false, collapsedHeight: 0,
      visible: false, occluded: false, hovered: false, pinned: false, videos,
    };

    const setHovered = (hovered: boolean) => {
      pin.hovered = hovered;
      this.refreshExpanded(pin);
    };
    for (const el of [label, dot]) {
      el.addEventListener("pointerenter", () => setHovered(true));
      el.addEventListener("pointerleave", () => setHovered(false));
    }
    const togglePinned = () => {
      pin.pinned = !pin.pinned;
      this.refreshExpanded(pin);
    };
    dot.addEventListener("click", togglePinned);
    label.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest(".annotation-label__image, .annotation-label__audio")) togglePinned();
    });
    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        togglePinned();
      }
    });
    return pin;
  }

  private fillDetail(inner: HTMLElement, data: Annotation, videos: HTMLVideoElement[]): void {
    if (data.text) {
      const text = document.createElement("div");
      text.className = "annotation-label__text";
      for (const paragraph of data.text.split(/\n{2,}/)) {
        const p = document.createElement("p");
        paragraph.split("\n").forEach((line, i) => {
          if (i > 0) p.appendChild(document.createElement("br"));
          p.appendChild(document.createTextNode(line));
        });
        text.appendChild(p);
      }
      inner.appendChild(text);
    }
    const media = annotationMedia(data);
    const visual = media.filter((m) => m.item.kind !== "audio");
    const audios = media.filter((m): m is typeof m & { item: Extract<MediaItem, { kind: "audio" }> } => m.item.kind === "audio");
    if (visual.length > 0) {
      const items = visual.map((m) => m.item);
      const gallery = document.createElement("div");
      gallery.className = "annotation-label__images";
      gallery.dataset.count = String(Math.min(visual.length, 3));
      visual.forEach(({ item, thumbnail }, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `annotation-label__image annotation-label__image--${item.kind}`;
        button.setAttribute("aria-label", `${MEDIA_LABEL[item.kind as keyof typeof MEDIA_LABEL]} ${index + 1} : ${data.title}`);
        if (item.kind === "video") {
          // Image d'attente (ou premier plan), puis lecture en boucle sans le son quand l'étiquette se déplie
          const video = document.createElement("video");
          if (thumbnail) video.poster = thumbnail.url;
          video.src = thumbnail ? item.url : `${item.url}#t=0.001`;
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          video.preload = thumbnail ? "none" : "metadata";
          setSize(video, thumbnail);
          video.setAttribute("aria-hidden", "true");
          button.appendChild(video);
          videos.push(video);
        } else if (thumbnail) {
          const img = document.createElement("img");
          img.src = thumbnail.url;
          img.alt = `${data.title} — ${item.source}`;
          img.loading = "lazy";
          setSize(img, thumbnail);
          button.appendChild(img);
        } else {
          // PDF sans vignette : une carte avec le nom du fichier
          const card = document.createElement("span");
          card.className = "annotation-label__card";
          card.textContent = item.source;
          button.appendChild(card);
        }
        if (item.kind === "pdf") {
          const badge = document.createElement("span");
          badge.className = "annotation-label__badge";
          badge.textContent = item.pages && item.pages > 1 ? `PDF · ${item.pages} p.` : "PDF";
          button.appendChild(badge);
        }
        button.addEventListener("click", () => this.options.onOpenMedia(items, index, data.title));
        gallery.appendChild(button);
      });
      inner.appendChild(gallery);
    }
    if (audios.length > 0) {
      const list = document.createElement("div");
      list.className = "annotation-label__audios";
      audios.forEach(({ item }, index) => {
        const name = item.label || (audios.length > 1 ? `Audio ${index + 1}` : "Audio");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "annotation-label__audio";
        button.setAttribute("aria-label", `Écouter : ${name} (${data.title})`);
        button.innerHTML = `${PLAY_ICON}<span class="annotation-label__audio-name"></span>`;
        button.querySelector(".annotation-label__audio-name")!.textContent = name;
        if (item.duration) {
          const time = document.createElement("span");
          time.className = "annotation-label__audio-time";
          time.textContent = formatDuration(item.duration);
          button.appendChild(time);
        }
        button.addEventListener("click", () => this.options.onPlayAudio({ ...item, label: name }, data.title));
        list.appendChild(button);
      });
      inner.appendChild(list);
    }
  }

  private refreshExpanded(pin: Pin): void {
    const expanded = pin.hovered || pin.pinned;
    pin.label.classList.toggle("is-expanded", expanded);
    pin.label.classList.toggle("is-pinned", pin.pinned);
    pin.label.setAttribute("aria-expanded", String(expanded));
    pin.dot.classList.toggle("is-active", expanded);
    pin.leader.classList.toggle("is-active", expanded);
    this.syncVideo(pin);
  }

  /** Les vidéos tournent en boucle, sans le son, tant que l'étiquette est dépliée et visible. */
  private syncVideo(pin: Pin): void {
    const play = (pin.hovered || pin.pinned) && this._visible && !this.inert;
    for (const video of pin.videos) {
      if (play) {
        void video.play().catch(() => {});
      } else if (!video.paused) {
        video.pause();
        video.currentTime = 0;
      }
    }
  }

  private syncVideos(): void {
    for (const pin of this.pins) this.syncVideo(pin);
  }

  // --- Projection et visibilité -------------------------------------------------

  private projectAnchors(width: number, height: number): void {
    const { camera } = this.options;
    for (const pin of this.pins) {
      this.projected.copy(pin.anchor).project(camera);
      const inFront = this.projected.z > -1 && this.projected.z < 1;
      const sx = (this.projected.x * 0.5 + 0.5) * width;
      const sy = (-this.projected.y * 0.5 + 0.5) * height;
      const onScreen = inFront && sx >= 0 && sx <= width && sy >= 0 && sy <= height;

      pin.ax = sx;
      pin.ay = sy;
      // `translate` (et non `transform`) : le `scale` du survol reste centré sur le point
      pin.dot.style.translate = `${sx.toFixed(1)}px ${sy.toFixed(1)}px`;
      if (onScreen !== pin.visible) {
        pin.visible = onScreen;
        pin.placed = pin.placed && onScreen;
        for (const el of [pin.dot, pin.label, pin.leader]) el.classList.toggle("is-offscreen", !onScreen);
      }
    }
  }

  private updateOcclusion(camera: THREE.Camera): void {
    const now = performance.now();
    if (now - this.lastOcclusion < OCCLUSION_INTERVAL) return;
    this.lastOcclusion = now;

    const occluder = this.options.occluder();
    const origin = camera.getWorldPosition(new THREE.Vector3());
    for (const pin of this.pins) {
      let occluded = false;
      if (occluder && pin.visible) {
        const direction = pin.anchor.clone().sub(origin);
        const distance = direction.length();
        this.raycaster.set(origin, direction.normalize());
        this.raycaster.far = distance - 0.05;
        occluded = this.raycaster.intersectObject(occluder, true).length > 0;
      }
      if (occluded !== pin.occluded) {
        pin.occluded = occluded;
        for (const el of [pin.dot, pin.label, pin.leader]) el.classList.toggle("is-occluded", occluded);
      }
    }
  }
}

/** Dimensions d'origine (quand on les connaît) : réservent la place avant le chargement. */
function setSize(el: HTMLImageElement | HTMLVideoElement, thumbnail: { width: number; height: number } | null): void {
  if (!thumbnail || thumbnail.width <= 0 || thumbnail.height <= 0) return;
  el.width = thumbnail.width;
  el.height = thumbnail.height;
}

function averagePoint(points: [number, number, number][]): [number, number, number] {
  const sum = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}
