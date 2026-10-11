import type { SessionSummary } from "@/data/types";

export type SessionButtonState = "idle" | "loading" | "active";

const timeFormat = new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" });

export function sessionLabel(session: Pick<SessionSummary, "kind" | "index">): string {
  return session.kind === "event" ? "Événement" : `Session ${session.index}`;
}

/** Le survol annonce l'intention : la session peut être préchargée avant le clic. */
export class SessionSwitcher {
  readonly element: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();

  constructor(sessions: SessionSummary[], onSelect: (id: string) => void, onIntent: (id: string) => void) {
    this.element = document.createElement("nav");
    this.element.className = "sessions";
    this.element.setAttribute("aria-label", "Sessions");

    const days = new Set(sessions.map((s) => s.day));
    let day: number | null = null;
    for (const session of sessions) {
      if (days.size > 1 && session.day !== day) {
        day = session.day;
        const label = document.createElement("span");
        label.className = "sessions__day";
        label.textContent = `J${day}`;
        label.title = `Journée ${day}`;
        this.element.appendChild(label);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = session.kind === "event" ? "sessions__item sessions__item--event" : "sessions__item";
      button.dataset.state = "idle";
      const time = session.startDate ? timeFormat.format(new Date(session.startDate)) : "";
      button.innerHTML = `<span class="sessions__name"></span><span class="sessions__time"></span>`;
      button.querySelector(".sessions__name")!.textContent = sessionLabel(session);
      button.querySelector(".sessions__time")!.textContent = time;
      button.setAttribute("aria-label", `${session.title}${time ? `, ${time}` : ""}`);
      button.addEventListener("click", () => onSelect(session.id));
      button.addEventListener("pointerenter", () => onIntent(session.id));
      button.addEventListener("focus", () => onIntent(session.id));
      this.buttons.set(session.id, button);
      this.element.appendChild(button);
    }
  }

  setState(id: string, state: SessionButtonState, progress = 0): void {
    const button = this.buttons.get(id);
    if (!button) return;
    button.dataset.state = state;
    button.setAttribute("aria-current", state === "active" ? "true" : "false");
    button.style.setProperty("--progress", String(progress));
  }

  reveal(id: string): void {
    this.buttons.get(id)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
}
