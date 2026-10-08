export type PlaybackState = "idle" | "playing" | "paused" | "ended";

type Listener = () => void;

/**
 * Horloge de lecture pilotée par l'audio.
 *
 * L'élément <audio> est la référence temporelle. Comme `currentTime` n'est
 * rafraîchi que par paliers dans certains navigateurs, on extrapole entre deux
 * mises à jour avec `performance.now()` pour obtenir un mouvement fluide, tout
 * en se recalant sur l'audio dès qu'il avance.
 */
export class PlaybackController {
  readonly audio: HTMLAudioElement;
  private _state: PlaybackState = "idle";
  private readonly listeners = new Set<Listener>();

  private anchorMediaTime = 0;
  private anchorWallTime = 0;

  constructor(src: string, readonly duration: number) {
    this.audio = new Audio(src);
    this.audio.preload = "auto";

    this.audio.addEventListener("play", () => this.setState("playing"));
    this.audio.addEventListener("pause", () => {
      if (!this.audio.ended) this.setState("paused");
    });
    this.audio.addEventListener("ended", () => this.setState("ended"));
    this.audio.addEventListener("seeked", () => this.reanchor());
  }

  get state(): PlaybackState {
    return this._state;
  }

  get isPlaying(): boolean {
    return this._state === "playing";
  }

  /** Temps courant lissé, en secondes. */
  get currentTime(): number {
    const media = this.audio.currentTime;
    if (!this.isPlaying) return media;

    if (media !== this.anchorMediaTime) this.reanchor();
    const extrapolated =
      this.anchorMediaTime + ((performance.now() - this.anchorWallTime) / 1000) * this.audio.playbackRate;
    // L'extrapolation ne doit jamais s'éloigner de l'audio réel
    return Math.min(Math.max(extrapolated, media), media + 0.3, this.duration);
  }

  async play(): Promise<void> {
    if (this._state === "ended") this.audio.currentTime = 0;
    this.reanchor();
    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  toggle(): Promise<void> | void {
    return this.isPlaying ? this.pause() : this.play();
  }

  seek(time: number): void {
    this.audio.currentTime = Math.min(Math.max(time, 0), this.duration);
    if (this._state === "ended") this.setState("paused");
    this.reanchor();
    this.emit();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.listeners.clear();
  }

  private reanchor(): void {
    this.anchorMediaTime = this.audio.currentTime;
    this.anchorWallTime = performance.now();
  }

  private setState(state: PlaybackState): void {
    this._state = state;
    this.reanchor();
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}
