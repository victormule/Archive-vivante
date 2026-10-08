/** Évènements qui comptent comme une présence de l'utilisateur. */
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"] as const;

export interface IdleWatcherOptions {
  /** Inactivité (ms) avant `onIdle`. */
  timeout: number;
  /** Vrai tant que l'inactivité ne doit pas compter (lecture en cours…). */
  isBusy: () => boolean;
  onIdle: () => void;
  /** Première activité après `onIdle`. */
  onActive: () => void;
}

/** Détecte l'inactivité de l'utilisateur (souris, clavier, toucher). */
export class IdleWatcher {
  private last = performance.now();
  private idle = false;
  private readonly timer: number;

  constructor(private readonly options: IdleWatcherOptions) {
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, this.onActivity, { passive: true, capture: true });
    this.timer = window.setInterval(() => this.check(), 500);
  }

  get isIdle(): boolean {
    return this.idle;
  }

  dispose(): void {
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, this.onActivity, { capture: true });
    window.clearInterval(this.timer);
  }

  private readonly onActivity = (): void => {
    this.last = performance.now();
    if (this.idle) {
      this.idle = false;
      this.options.onActive();
    }
  };

  private check(): void {
    if (this.idle) return;
    if (this.options.isBusy() || document.hidden) {
      this.last = performance.now();
      return;
    }
    if (performance.now() - this.last >= this.options.timeout) {
      this.idle = true;
      this.options.onIdle();
    }
  }
}
