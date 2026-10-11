import * as THREE from "three";

export interface PathStart {
  id: string;
  /** « Session 3 », « Événement ». */
  label: string;
  /** Départ du trajet enregistré, dans le lieu commun. */
  position: THREE.Vector3;
}

const PLAY_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>`;

/**
 * Vue d'ensemble : un bouton « ▶ Session n » au départ de chaque trajet
 * enregistré. Un clic lance la lecture de cette session (son et caméra), au
 * milieu de toutes les autres.
 */
export class PathStarts {
  readonly element: HTMLElement;
  private readonly markers: Array<{ start: PathStart; button: HTMLButtonElement }>;
  private readonly projected = new THREE.Vector3();
  private visible = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly camera: THREE.Camera,
    starts: PathStart[],
    onSelect: (id: string) => void,
  ) {
    this.element = document.createElement("div");
    this.element.className = "path-starts is-hidden";
    this.markers = starts.map((start) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "path-start";
      button.innerHTML = `<span class="path-start__play">${PLAY_ICON}</span><span class="path-start__label"></span>`;
      button.querySelector(".path-start__label")!.textContent = start.label;
      button.setAttribute("aria-label", `Écouter ${start.label} depuis son départ`);
      button.addEventListener("click", () => onSelect(start.id));
      this.element.appendChild(button);
      return { start, button };
    });
    container.appendChild(this.element);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.element.classList.toggle("is-hidden", !visible);
  }

  /** Session en cours d'écoute (bouton mis en avant). */
  setActive(id: string | null): void {
    for (const { start, button } of this.markers) button.classList.toggle("is-active", start.id === id);
  }

  /** À appeler à chaque frame, une fois la caméra à jour. */
  update(): void {
    if (!this.visible) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    for (const { start, button } of this.markers) {
      const p = this.projected.copy(start.position).project(this.camera);
      const onScreen = p.z < 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
      button.classList.toggle("is-offscreen", !onScreen);
      if (!onScreen) continue;
      const x = (p.x * 0.5 + 0.5) * width;
      const y = (-p.y * 0.5 + 0.5) * height;
      button.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    }
  }

  dispose(): void {
    this.element.remove();
  }
}
