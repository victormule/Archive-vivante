import { publicMediaUrl } from "@/contrib/config";
import { ContributionSource } from "@/contrib/live";
import type { Contribution } from "@/contrib/types";
import type { MediaItem } from "@/data/types";

const PAGE = 30;
const OPEN_KEY = "archive.feed.open";
/** Sans choix enregistré, le volet s'ouvre sur grand écran seulement. */
const WIDE_SCREEN = "(min-width: 900px)";

const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5zm4 3.25a1 1 0 0 0 0 2h8a1 1 0 1 0 0-2zm0 3.5a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2z"/></svg>`;

export interface ContributionFeedOptions {
  onOpenMedia: (items: MediaItem[], index: number, title: string) => void;
}

/** Contributions du public, en temps réel ; sur l'Event seulement, ailleurs l'abonnement est coupé. */
export class ContributionFeed {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tab: HTMLButtonElement;
  private readonly badge: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly empty: HTMLElement;
  private readonly more: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly source = new ContributionSource();
  private readonly rows = new Map<string, { row: Contribution; el: HTMLElement }>();
  private available = false;
  private started = false;
  private open = false;
  private unseen = 0;
  private clock: number | null = null;

  constructor(container: HTMLElement, private readonly options: ContributionFeedOptions) {
    this.element = document.createElement("aside");
    this.element.className = "feed";
    this.element.hidden = true;
    this.element.setAttribute("aria-label", "Impressions du public");
    this.element.innerHTML = `
      <button class="feed__tab" type="button" aria-expanded="false" aria-controls="feed-body">
        ${ICON}<span class="feed__badge" hidden></span>
      </button>
      <div class="feed__body" id="feed-body">
        <header class="feed__header">
          <h2 class="feed__title">Impressions du public</h2>
        </header>
        <div class="feed__scroll">
          <p class="feed__empty" hidden>Aucune impression pour l'instant.</p>
          <ol class="feed__list"></ol>
          <button class="feed__more" type="button" hidden>Plus anciennes</button>
          <p class="feed__status" role="status" hidden></p>
        </div>
      </div>
    `;
    this.body = this.element.querySelector(".feed__body")!;
    this.tab = this.element.querySelector(".feed__tab")!;
    this.badge = this.element.querySelector(".feed__badge")!;
    this.list = this.element.querySelector(".feed__list")!;
    this.empty = this.element.querySelector(".feed__empty")!;
    this.more = this.element.querySelector(".feed__more")!;
    this.status = this.element.querySelector(".feed__status")!;

    this.tab.addEventListener("click", () => this.setOpen(!this.open, true));
    this.more.addEventListener("click", () => void this.loadOlder());
    document.addEventListener("visibilitychange", this.onVisibility);
    this.setOpen(false, false);
    container.appendChild(this.element);
  }

  get isOpen(): boolean {
    return this.available && this.open;
  }

  setAvailable(available: boolean): void {
    if (available === this.available) return;
    this.available = available;
    this.element.hidden = !available;
    if (!available) {
      void this.source.unsubscribe();
      this.stopClock();
      return;
    }
    if (!this.started) {
      this.started = true;
      this.setOpen(this.defaultOpen(), false);
      void this.loadInitial();
    }
    if (this.open) this.startClock();
    void this.source.subscribe({
      insert: (row) => this.add(row, true),
      remove: (id) => this.remove(id),
      connected: () => void this.catchUp(),
    });
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    void this.source.unsubscribe();
    this.stopClock();
    this.element.remove();
  }

  // --- Ouverture -----------------------------------------------------------------

  private defaultOpen(): boolean {
    try {
      const saved = localStorage.getItem(OPEN_KEY);
      if (saved !== null) return saved === "1";
    } catch {
      // stockage indisponible (navigation privée) : défaut selon l'écran
    }
    return window.matchMedia(WIDE_SCREEN).matches;
  }

  private setOpen(open: boolean, remember: boolean): void {
    this.open = open;
    this.element.classList.toggle("is-open", open);
    this.tab.setAttribute("aria-expanded", String(open));
    this.tab.title = this.tab.ariaLabel = open ? "Masquer les impressions du public" : "Afficher les impressions du public";
    this.body.inert = !open;
    if (remember) {
      try {
        localStorage.setItem(OPEN_KEY, open ? "1" : "0");
      } catch {
        // sans conséquence
      }
    }
    if (open) {
      this.unseen = 0;
      this.updateBadge();
      this.refreshTimes();
      if (this.available) this.startClock();
    } else {
      this.stopClock();
    }
  }

  private updateBadge(): void {
    this.badge.hidden = this.unseen === 0;
    this.badge.textContent = this.unseen > 9 ? "9+" : String(this.unseen);
  }

  // --- Données -------------------------------------------------------------------

  private async loadInitial(): Promise<void> {
    try {
      const rows = await this.source.list(PAGE);
      rows.forEach((row) => this.add(row, false));
      this.more.hidden = rows.length < PAGE;
      this.setStatus(null);
    } catch (err) {
      console.error(err);
      this.setStatus("Les impressions ne peuvent pas être chargées pour l'instant.");
    }
    this.refreshEmpty();
  }

  private async loadOlder(): Promise<void> {
    const oldest = this.list.lastElementChild ? this.rows.get((this.list.lastElementChild as HTMLElement).dataset.id!)?.row : undefined;
    if (!oldest) return;
    this.more.disabled = true;
    try {
      const rows = await this.source.list(PAGE, oldest.created_at);
      rows.forEach((row) => this.add(row, false));
      this.more.hidden = rows.length < PAGE;
    } catch (err) {
      console.error(err);
    }
    this.more.disabled = false;
  }

  /** Après une (re)connexion ou un retour sur la page : ce qui a été posté entre-temps. */
  private async catchUp(): Promise<void> {
    if (!this.available) return;
    const newest = this.list.firstElementChild ? this.rows.get((this.list.firstElementChild as HTMLElement).dataset.id!)?.row : undefined;
    try {
      const rows = newest ? await this.source.since(newest.created_at) : await this.source.list(PAGE);
      // Des plus anciennes aux plus récentes : l'ordre d'arrivée est respecté
      rows.reverse().forEach((row) => this.add(row, Boolean(newest)));
      if (!newest) this.more.hidden = rows.length < PAGE;
      this.setStatus(null);
    } catch (err) {
      console.error(err);
    }
    this.refreshEmpty();
  }

  private readonly onVisibility = (): void => {
    if (document.visibilityState === "visible" && this.available) void this.catchUp();
  };

  private add(row: Contribution, fresh: boolean): void {
    if (this.rows.has(row.id)) return;
    const el = this.render(row);
    this.rows.set(row.id, { row, el });
    // Rang par date, la plus récente en haut (dates comparées en valeur : le format texte varie)
    const at = Date.parse(row.created_at);
    const after = [...this.list.children].find((child) => {
      const other = this.rows.get((child as HTMLElement).dataset.id!)?.row;
      return other !== undefined && Date.parse(other.created_at) < at;
    });
    this.list.insertBefore(el, after ?? null);
    if (fresh) {
      el.classList.add("is-new");
      el.addEventListener("animationend", () => el.classList.remove("is-new"), { once: true });
      if (!this.isOpen) {
        this.unseen += 1;
        this.updateBadge();
      }
    }
    this.refreshEmpty();
  }

  private remove(id: string): void {
    const entry = this.rows.get(id);
    if (!entry) return;
    entry.el.remove();
    this.rows.delete(id);
    this.refreshEmpty();
  }

  private refreshEmpty(): void {
    this.empty.hidden = this.rows.size > 0 || !this.status.hidden;
  }

  private setStatus(message: string | null): void {
    this.status.hidden = message === null;
    this.status.textContent = message ?? "";
  }

  // --- Rendu ---------------------------------------------------------------------

  private render(row: Contribution): HTMLElement {
    const item = document.createElement("li");
    item.className = "feed__item";
    item.dataset.id = row.id;

    const header = document.createElement("header");
    header.className = "feed__meta";
    const author = document.createElement("strong");
    author.className = "feed__author";
    author.textContent = row.author;
    const time = document.createElement("time");
    time.className = "feed__time";
    time.dateTime = row.created_at;
    time.textContent = relativeTime(row.created_at);
    header.append(author, time);
    item.append(header);

    if (row.message) {
      const text = document.createElement("p");
      text.className = "feed__text";
      text.textContent = row.message;
      item.append(text);
    }

    if (row.media_kind && row.media_path && row.thumb_path) {
      const thumbUrl = publicMediaUrl(row.thumb_path);
      const url = publicMediaUrl(row.media_path);
      const media: MediaItem =
        row.media_kind === "video" ? { kind: "video", url, poster: thumbUrl, source: row.author } : { kind: "image", url, source: row.author };
      const button = document.createElement("button");
      button.type = "button";
      button.className = `feed__media feed__media--${row.media_kind}`;
      button.setAttribute("aria-label", row.media_kind === "video" ? `Voir la vidéo de ${row.author}` : `Voir la photo de ${row.author}`);
      if (row.media_width && row.media_height) button.style.aspectRatio = `${row.media_width} / ${row.media_height}`;
      const img = document.createElement("img");
      img.src = thumbUrl;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      button.append(img);
      if (row.media_kind === "video") attachHoverPlayback(button, url);
      button.addEventListener("click", () => this.options.onOpenMedia([media], 0, row.author));
      item.append(button);
    }
    return item;
  }

  private refreshTimes(): void {
    for (const { row, el } of this.rows.values()) {
      el.querySelector(".feed__time")!.textContent = relativeTime(row.created_at);
    }
  }

  private startClock(): void {
    this.clock ??= window.setInterval(() => this.refreshTimes(), 30_000);
  }

  private stopClock(): void {
    if (this.clock !== null) window.clearInterval(this.clock);
    this.clock = null;
  }
}

/** Délai (ms) de survol avant de lancer la vidéo : un passage de souris en défilant ne télécharge rien. */
const HOVER_DELAY = 150;

/**
 * L'élément vidéo n'existe que pendant le survol (ou le focus clavier) : le retirer coupe aussi le
 * téléchargement. Au toucher, pas de survol : un appui ouvre la visionneuse.
 */
function attachHoverPlayback(button: HTMLElement, url: string): void {
  let video: HTMLVideoElement | null = null;
  let timer: number | null = null;

  const start = () => {
    if (video) return;
    video = document.createElement("video");
    video.className = "feed__preview";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    // La vignette reste affichée jusqu'à la première image lue
    video.addEventListener("playing", () => video?.classList.add("is-playing"), { once: true });
    button.append(video);
    void video.play().catch(() => {});
  };
  const stop = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    video = null;
  };
  const schedule = () => {
    if (timer === null && !video) timer = window.setTimeout(() => ((timer = null), start()), HOVER_DELAY);
  };

  button.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse" || e.pointerType === "pen") schedule();
  });
  button.addEventListener("pointerleave", stop);
  button.addEventListener("focus", () => button.matches(":focus-visible") && schedule());
  button.addEventListener("blur", stop);
  // La visionneuse prend le relais : une seule lecture à la fois
  button.addEventListener("click", stop);
}

const dateFormat = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return "à l'instant";
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return dateFormat.format(new Date(iso));
}
