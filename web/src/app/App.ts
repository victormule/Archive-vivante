import { loadSessionIndex } from "@/data/sessionRepository";
import { ArchiveView } from "./ArchiveView";

/** Écart-type par défaut (s) du lissage du trajet caméra. */
const DEFAULT_CAMERA_SMOOTHING = 0.7;
/** Durée (ms) du fondu enchaîné entre sessions. */
const CROSSFADE_DURATION = 1600;
/** Durée (ms) du fondu pendant la rotation automatique. */
const IDLE_CROSSFADE_DURATION = 5000;

/**
 * Point d'entrée applicatif. Paramètres d'URL :
 *  - `session=<id>`   session affichée (défaut : première de l'index)
 *  - `smoothing=<s>`  lissage du trajet caméra en secondes (0 = trajet brut), pour toutes les sessions
 *  - `idle=0`         désactive la rotation automatique (outils, captures)
 *  - `enter=0`        ouvre la scène sans bouton « Entrer » ni plein écran (outils, captures)
 */
export class App {
  private view: ArchiveView | null = null;

  constructor(private readonly container: HTMLElement) {}

  async start(): Promise<void> {
    try {
      const params = new URLSearchParams(location.search);
      const requested = params.get("session");
      const smoothing = Number(params.get("smoothing") ?? DEFAULT_CAMERA_SMOOTHING);
      const { sessions, scene } = await loadSessionIndex();
      const id = sessions.some((s) => s.id === requested) ? requested! : sessions[0]?.id;
      if (!id) throw new Error("Aucune session disponible. Lancer `python pipeline/build_sessions.py`.");

      // Toutes les sessions partagent la scène (repère commun calé sur la table) et se succèdent en fondu
      const sceneConfig = { initialView: scene?.initialView ?? null, orbit: params.get("idle") === "0" ? null : scene?.orbit ?? null };
      this.view = new ArchiveView(this.container, sessions, sceneConfig, {
        cameraSmoothing: Number.isFinite(smoothing) ? Math.max(0, smoothing) : DEFAULT_CAMERA_SMOOTHING,
        cameraSmoothingForced: params.has("smoothing"),
        crossfadeDuration: CROSSFADE_DURATION,
        idleCrossfadeDuration: IDLE_CROSSFADE_DURATION,
        skipEntry: params.get("enter") === "0",
      });
      // Outils de développement (console, tests automatisés) : jamais en production
      if (import.meta.env.DEV) Object.assign(window, { __archive: this.view });
      await this.view.start(id);
    } catch (err) {
      console.error(err);
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  private showError(message: string): void {
    // L'écran de chargement (centré lui aussi) s'efface devant le message ; le rendu s'arrête
    this.view?.dispose();
    this.view = null;
    const el = document.createElement("div");
    el.className = "app-error";
    el.textContent = message;
    this.container.appendChild(el);
  }
}
