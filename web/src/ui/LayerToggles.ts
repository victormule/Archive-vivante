import type { LayerId } from "@/data/types";

export type ToggleId = LayerId | "annotations";

export interface LayerToggleItem {
  id: ToggleId;
  label: string;
  shortcut: string;
  icon: string;
  /** Démarre un nouveau groupe visuel (séparateur au-dessus). */
  groupStart?: boolean;
}

export type LayerToggleState = "off" | "loading" | "on" | "error";

/** Ordre d'affichage : Gaussian, photogrammétrie, nuage de points. */
export const LAYER_ITEMS: Array<LayerToggleItem & { id: LayerId }> = [
  {
    id: "splat",
    label: "Gaussian splatting",
    shortcut: "1",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="10" r="5" opacity=".9"/><circle cx="15.5" cy="14.5" r="5.5" opacity=".55"/><circle cx="15" cy="7" r="2.5" opacity=".7"/></svg>`,
  },
  {
    id: "mesh",
    label: "Photogrammétrie",
    shortcut: "2",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3 21 8v8l-9 5-9-5V8z"/><path d="M12 3v18M3 8l18 8M21 8 3 16"/></svg>`,
  },
  {
    id: "pointCloud",
    label: "Nuage de points",
    shortcut: "3",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><g><circle cx="5" cy="7" r="1.5"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="15" cy="8" r="1.5"/><circle cx="19.5" cy="5" r="1.5"/><circle cx="7" cy="12.5" r="1.5"/><circle cx="12.5" cy="12" r="1.5"/><circle cx="18" cy="13" r="1.5"/><circle cx="4.5" cy="18" r="1.5"/><circle cx="10" cy="18.5" r="1.5"/><circle cx="15.5" cy="18" r="1.5"/><circle cx="20" cy="19" r="1.5"/></g></svg>`,
  },
];

export const ANNOTATIONS_ITEM: LayerToggleItem = {
  id: "annotations",
  label: "Annotations",
  shortcut: "4",
  groupStart: true,
  icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c-3.6 0-6.5 2.9-6.5 6.5 0 4.9 6.5 12.5 6.5 12.5s6.5-7.6 6.5-12.5c0-3.6-2.9-6.5-6.5-6.5zm0 3.8a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4z" fill-rule="evenodd"/></svg>`,
};

/**
 * Colonne de boutons à gauche : chaque couche s'active indépendamment et
 * les couches se cumulent. Raccourcis clavier 1, 2, 3 (+ 4 : annotations).
 */
export class LayerToggles {
  readonly element: HTMLElement;
  private readonly buttons = new Map<ToggleId, HTMLButtonElement>();
  private readonly shortcuts: Map<string, ToggleId>;

  constructor(items: LayerToggleItem[], private readonly onToggle: (id: ToggleId) => void) {
    this.element = document.createElement("nav");
    this.element.className = "layers";
    this.element.setAttribute("aria-label", "Couches affichées");

    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = item.groupStart ? "layers__toggle layers__toggle--group" : "layers__toggle";
      button.dataset.state = "off";
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", item.label);
      button.innerHTML = `${item.icon}<span class="layers__label">${item.label}<kbd>${item.shortcut}</kbd></span>`;
      button.addEventListener("click", () => onToggle(item.id));
      this.buttons.set(item.id, button);
      this.element.appendChild(button);
    }

    this.shortcuts = new Map(items.map((i) => [i.shortcut, i.id]));
    window.addEventListener("keydown", this.onKeyDown);
  }

  setState(id: ToggleId, state: LayerToggleState, progress?: number): void {
    const button = this.buttons.get(id);
    if (!button) return;
    button.dataset.state = state;
    button.setAttribute("aria-pressed", String(state === "on"));
    button.style.setProperty("--progress", String(progress ?? 0));
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    this.element.remove();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const id = this.shortcuts.get(e.key);
    if (id && this.buttons.has(id)) this.onToggle(id);
  };
}
