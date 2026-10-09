import type { MediaItem } from "@/data/types";

/**
 * Visionneuse plein écran : images, vidéos (en boucle, sans le son) et PDF.
 * Échap / clic hors média : fermer ; ← → : naviguer.
 */
export class MediaLightbox {
  readonly element: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly video: HTMLVideoElement;
  private readonly frame: HTMLIFrameElement;
  private readonly caption: HTMLElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private items: MediaItem[] = [];
  private index = 0;
  private title = "";
  private returnFocus: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.element = document.createElement("div");
    this.element.className = "lightbox";
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-modal", "true");
    this.element.hidden = true;
    this.element.innerHTML = `
      <figure class="lightbox__figure">
        <img class="lightbox__media lightbox__image" alt="" />
        <video class="lightbox__media lightbox__video" muted loop playsinline hidden></video>
        <iframe class="lightbox__media lightbox__document" title="" hidden></iframe>
        <figcaption class="lightbox__caption"></figcaption>
      </figure>
      <button class="lightbox__nav lightbox__nav--prev" type="button" aria-label="Précédent">‹</button>
      <button class="lightbox__nav lightbox__nav--next" type="button" aria-label="Suivant">›</button>
      <button class="lightbox__close" type="button" aria-label="Fermer">×</button>
    `;
    this.img = this.element.querySelector(".lightbox__image")!;
    this.video = this.element.querySelector(".lightbox__video")!;
    this.frame = this.element.querySelector(".lightbox__document")!;
    this.caption = this.element.querySelector(".lightbox__caption")!;
    this.prev = this.element.querySelector(".lightbox__nav--prev")!;
    this.next = this.element.querySelector(".lightbox__nav--next")!;
    // Le son n'est jamais activé : une vidéo d'annotation est une boucle muette
    this.video.muted = true;

    this.prev.addEventListener("click", () => this.show(this.index - 1));
    this.next.addEventListener("click", () => this.show(this.index + 1));
    this.element.querySelector(".lightbox__close")!.addEventListener("click", () => this.close());
    this.element.addEventListener("click", (e) => {
      if (e.target === this.element) this.close();
    });
    window.addEventListener("keydown", this.onKeyDown, true);
    container.appendChild(this.element);
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  open(items: MediaItem[], index: number, title: string): void {
    if (items.length === 0) return;
    this.items = items;
    this.title = title;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.element.hidden = false;
    this.show(index);
    this.element.querySelector<HTMLButtonElement>(".lightbox__close")!.focus();
  }

  close(): void {
    this.element.hidden = true;
    this.reset();
    this.returnFocus?.focus();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown, true);
    this.element.remove();
  }

  /** Arrête la vidéo et vide le document : rien ne tourne derrière la visionneuse fermée. */
  private reset(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.frame.removeAttribute("src");
  }

  private show(index: number): void {
    const n = this.items.length;
    this.index = ((index % n) + n) % n;
    const item = this.items[this.index];
    this.reset();
    this.img.hidden = item.kind !== "image";
    this.video.hidden = item.kind !== "video";
    this.frame.hidden = item.kind !== "pdf";

    if (item.kind === "image") {
      this.img.src = item.url;
      this.img.alt = `${this.title} — ${item.source}`;
    } else if (item.kind === "video") {
      this.video.poster = item.poster;
      this.video.src = item.url;
      this.video.muted = true;
      void this.video.play().catch(() => {});
    } else {
      this.frame.title = `${this.title} — ${item.source}`;
      this.frame.src = `${item.url}#view=FitH`;
    }

    this.caption.textContent = this.items.length > 1 ? `${this.title} · ${this.index + 1} / ${n}` : this.title;
    if (item.kind === "pdf") {
      const link = document.createElement("a");
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Ouvrir dans un onglet";
      this.caption.append(" · ", link);
    }
    this.prev.hidden = this.next.hidden = n < 2;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;
    if (e.key === "Tab") return;
    // La visionneuse capture le clavier : pas de lecture ni de bascule de couche dessous
    e.stopImmediatePropagation();
    if (e.key === "Escape") this.close();
    else if (e.key === "ArrowLeft") this.show(this.index - 1);
    else if (e.key === "ArrowRight") this.show(this.index + 1);
    else return;
    e.preventDefault();
  };
}
