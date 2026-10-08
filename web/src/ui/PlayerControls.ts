import type { PlaybackController } from "@/playback/PlaybackController";
import { formatTime } from "./formatTime";

const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>`;

export interface PlayerActions {
  /** Démarrer la lecture (ex. après un vol de caméra vers la pose de départ). */
  play: () => void;
  /** Interrompre une lecture en préparation (vol en cours). */
  cancel: () => void;
}

/** Barre de lecture : play/pause, timeline, temps. Raccourci : Espace. */
export class PlayerControls {
  readonly element: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly scrubber: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private scrubbing = false;
  /** Lecture demandée mais pas encore démarrée (vol de caméra). */
  private pending = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly playback: PlaybackController, private readonly actions?: PlayerActions) {
    this.element = document.createElement("div");
    this.element.className = "player";
    this.element.innerHTML = `
      <button class="player__toggle" type="button"></button>
      <input class="player__scrubber" type="range" min="0" step="0.01" aria-label="Position de lecture" />
      <span class="player__time"></span>
    `;
    this.button = this.element.querySelector(".player__toggle")!;
    this.scrubber = this.element.querySelector(".player__scrubber")!;
    this.timeLabel = this.element.querySelector(".player__time")!;
    this.scrubber.max = String(playback.duration);

    this.button.addEventListener("click", () => this.toggle());
    this.scrubber.addEventListener("pointerdown", () => (this.scrubbing = true));
    this.scrubber.addEventListener("pointerup", () => (this.scrubbing = false));
    this.scrubber.addEventListener("input", () => {
      if (this.pending) this.actions?.cancel();
      playback.seek(Number(this.scrubber.value));
    });
    window.addEventListener("keydown", this.onKeyDown);

    this.unsubscribe = playback.onChange(() => this.render());
    this.render();
  }

  /** À appeler à chaque frame pour suivre la tête de lecture. */
  update(time: number): void {
    if (!this.scrubbing) this.scrubber.value = String(time);
    this.scrubber.style.setProperty("--progress", `${(time / this.playback.duration) * 100}%`);
    this.timeLabel.textContent = `${formatTime(time)} / ${formatTime(this.playback.duration)}`;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    this.unsubscribe();
    this.element.remove();
  }

  /** Affiche l'état « en préparation » (bouton pause actif pendant le vol). */
  setPending(pending: boolean): void {
    this.pending = pending;
    this.element.classList.toggle("is-pending", pending);
    this.render();
  }

  private toggle(): void {
    if (this.pending) return this.actions?.cancel();
    if (this.playback.isPlaying) return this.playback.pause();
    if (this.actions) return this.actions.play();
    this.playback.play().catch((err) => console.error("Lecture impossible", err));
  }

  private render(): void {
    const playing = this.playback.isPlaying || this.pending;
    this.button.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    this.button.setAttribute("aria-label", playing ? "Pause" : "Lecture");
    this.element.classList.toggle("is-playing", playing);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Un bouton focalisé gère déjà Espace nativement
    if (e.code !== "Space" || e.target instanceof HTMLButtonElement || e.repeat) return;
    e.preventDefault();
    this.toggle();
  };
}
