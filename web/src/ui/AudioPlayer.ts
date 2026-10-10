import type { MediaItem } from "@/data/types";

export type AudioItem = Extract<MediaItem, { kind: "audio" }>;

export interface AudioPlayerOptions {
  /** L'écoute démarre : le reste de la scène (replay vidéo) doit se taire. */
  onStart: () => void;
}

/** 75 -> « 1:15 ». */
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Petit lecteur flottant d'un audio d'annotation : il s'ouvre au clic, lit
 * tout de suite, et se referme tout seul à la fin de l'enregistrement.
 * Un seul audio à la fois ; un clic sur un autre audio remplace le premier.
 */
export class AudioPlayer {
  readonly element: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly title: HTMLElement;
  private readonly seek: HTMLInputElement;
  private readonly time: HTMLElement;
  private audio: HTMLAudioElement | null = null;
  private current: AudioItem | null = null;
  private seeking = false;
  private closing = 0;

  constructor(container: HTMLElement, private readonly options: AudioPlayerOptions) {
    this.element = document.createElement("div");
    this.element.className = "audio-player";
    this.element.setAttribute("role", "region");
    this.element.setAttribute("aria-label", "Écoute d'un audio");
    this.element.hidden = true;
    this.element.innerHTML = `
      <button class="audio-player__toggle" type="button" aria-label="Pause"></button>
      <div class="audio-player__body">
        <span class="audio-player__title"></span>
        <input class="audio-player__seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Position dans l'audio" />
      </div>
      <span class="audio-player__time">0:00</span>
      <button class="audio-player__close" type="button" aria-label="Fermer l'audio">×</button>
    `;
    this.toggle = this.element.querySelector(".audio-player__toggle")!;
    this.title = this.element.querySelector(".audio-player__title")!;
    this.seek = this.element.querySelector(".audio-player__seek")!;
    this.time = this.element.querySelector(".audio-player__time")!;

    this.toggle.addEventListener("click", () => this.togglePlay());
    this.element.querySelector(".audio-player__close")!.addEventListener("click", () => this.close());
    this.seek.addEventListener("input", () => {
      this.seeking = true;
      if (this.audio && Number.isFinite(this.audio.duration)) {
        this.audio.currentTime = (Number(this.seek.value) / 1000) * this.audio.duration;
      }
      this.refresh();
    });
    this.seek.addEventListener("change", () => (this.seeking = false));
    window.addEventListener("keydown", this.onKeyDown);
    container.appendChild(this.element);
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  get isPlaying(): boolean {
    return !!this.audio && !this.audio.paused;
  }

  /** Ouvre le lecteur et lance l'écoute. Un second clic sur le même audio le met en pause / le reprend. */
  open(item: AudioItem, title: string): void {
    if (this.current?.url === item.url && this.audio) return void this.togglePlay();
    this.stop();
    this.current = item;
    this.title.textContent = title ? `${title} · ${item.label ?? "Audio"}` : (item.label ?? "Audio");
    this.seek.value = "0";

    const audio = new Audio(item.url);
    audio.preload = "auto";
    audio.addEventListener("play", () => {
      this.options.onStart();
      this.refresh();
    });
    audio.addEventListener("pause", () => this.refresh());
    audio.addEventListener("timeupdate", () => this.refresh());
    audio.addEventListener("loadedmetadata", () => this.refresh());
    audio.addEventListener("ended", () => this.close());
    audio.addEventListener("error", () => this.close());
    this.audio = audio;

    window.clearTimeout(this.closing);
    this.element.classList.remove("is-closing");
    this.element.hidden = false;
    this.refresh();
    void audio.play().catch(() => this.close());
  }

  /** Ferme le lecteur et arrête l'audio (fin de l'enregistrement, ×, Échap, changement de session). */
  close(): void {
    if (!this.isOpen) return;
    this.stop();
    this.element.classList.add("is-closing");
    window.clearTimeout(this.closing);
    this.closing = window.setTimeout(() => {
      this.element.hidden = true;
      this.element.classList.remove("is-closing");
    }, 260);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.clearTimeout(this.closing);
    this.stop();
    this.element.remove();
  }

  private stop(): void {
    const audio = this.audio;
    this.audio = null;
    this.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }

  private togglePlay(): void {
    const audio = this.audio;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => this.close());
    else audio.pause();
  }

  private refresh(): void {
    const audio = this.audio;
    const playing = !!audio && !audio.paused;
    this.element.classList.toggle("is-playing", playing);
    this.toggle.setAttribute("aria-label", playing ? "Pause" : "Lecture");
    const total = audio && Number.isFinite(audio.duration) ? audio.duration : (this.current?.duration ?? 0);
    const now = audio?.currentTime ?? 0;
    if (!this.seeking && total > 0) this.seek.value = String(Math.round((now / total) * 1000));
    this.seek.style.setProperty("--progress", `${total > 0 ? (now / total) * 100 : 0}%`);
    this.time.textContent = total > 0 ? `${clock(now)} / ${clock(total)}` : clock(now);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.isOpen && !document.querySelector(".lightbox:not([hidden])")) this.close();
  };
}
