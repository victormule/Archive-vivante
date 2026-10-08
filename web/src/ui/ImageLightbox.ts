import type { AnnotationImage } from "@/data/types";

/** Visionneuse plein écran. Échap / clic hors image : fermer ; ← → : naviguer. */
export class ImageLightbox {
  readonly element: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly caption: HTMLElement;
  private readonly prev: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private images: AnnotationImage[] = [];
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
        <img class="lightbox__image" alt="" />
        <figcaption class="lightbox__caption"></figcaption>
      </figure>
      <button class="lightbox__nav lightbox__nav--prev" type="button" aria-label="Image précédente">‹</button>
      <button class="lightbox__nav lightbox__nav--next" type="button" aria-label="Image suivante">›</button>
      <button class="lightbox__close" type="button" aria-label="Fermer">×</button>
    `;
    this.img = this.element.querySelector(".lightbox__image")!;
    this.caption = this.element.querySelector(".lightbox__caption")!;
    this.prev = this.element.querySelector(".lightbox__nav--prev")!;
    this.next = this.element.querySelector(".lightbox__nav--next")!;

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

  open(images: AnnotationImage[], index: number, title: string): void {
    if (images.length === 0) return;
    this.images = images;
    this.title = title;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.element.hidden = false;
    this.show(index);
    this.element.querySelector<HTMLButtonElement>(".lightbox__close")!.focus();
  }

  close(): void {
    this.element.hidden = true;
    this.returnFocus?.focus();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown, true);
    this.element.remove();
  }

  private show(index: number): void {
    const n = this.images.length;
    this.index = ((index % n) + n) % n;
    const image = this.images[this.index];
    this.img.src = image.url;
    this.img.alt = `${this.title} — ${image.source}`;
    this.caption.textContent = n > 1 ? `${this.title} · ${this.index + 1} / ${n}` : this.title;
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
