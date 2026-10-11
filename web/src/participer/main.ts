import "../styles/tokens.css";
import "./participer.css";
import { submitContribution } from "@/contrib/api";
import { MAX_AUTHOR, MAX_MESSAGE, MAX_VIDEO_SECONDS } from "@/contrib/config";
import { isVideoFile, prepareImage, prepareVideo } from "@/contrib/media";
import type { PreparedMedia } from "@/contrib/types";

/** Le média est compressé dès qu'il est choisi, pendant que le visiteur écrit ; l'envoi attend la fin de la compression. */

const AUTHOR_KEY = "archive.contribution.author";
const EVENT_URL = "/?session=j4-event";

const app = document.getElementById("app")!;
app.innerHTML = `
  <main class="page">
    <header class="intro">
      <p class="intro__kicker">Performance Archive · Journée 4</p>
      <h1 class="intro__title">Laisser une impression</h1>
      <p class="intro__lead">Un mot, une photo ou une courte vidéo : votre impression apparaît en direct sur le site, à côté de l'Événement.</p>
    </header>

    <form class="form" novalidate>
      <label class="field">
        <span class="field__label">Nom ou pseudonyme</span>
        <input class="field__input" name="author" maxlength="${MAX_AUTHOR}" autocomplete="nickname" enterkeyhint="next" required />
      </label>

      <label class="field">
        <span class="field__label">Commentaire <span class="field__count">0 / ${MAX_MESSAGE}</span></span>
        <textarea class="field__input field__textarea" name="message" maxlength="${MAX_MESSAGE}" rows="4"></textarea>
      </label>

      <div class="field">
        <span class="field__label">Photo ou vidéo <span class="field__hint">facultatif</span></span>
        <label class="picker">
          <input class="picker__input" type="file" accept="image/*,video/*" />
          <span class="picker__text">＋ Ajouter une photo ou une vidéo</span>
        </label>
        <div class="preview" hidden>
          <img class="preview__media preview__image" alt="" hidden />
          <video class="preview__media preview__video" muted playsinline hidden></video>
          <button class="preview__remove" type="button" aria-label="Retirer le média">×</button>
          <div class="preview__state">
            <div class="bar"><span></span></div>
            <p class="preview__label"></p>
          </div>
        </div>
        <p class="field__note">Vidéos : ${MAX_VIDEO_SECONDS} s au plus, gardées sans le son.</p>
      </div>

      <label class="trap" aria-hidden="true">Site web <input name="website" tabindex="-1" autocomplete="off" /></label>

      <label class="consent">
        <input type="checkbox" name="consent" />
        <span>J'accepte que mon impression soit publiée sur le site, et les personnes visibles sur ma photo ou ma vidéo sont d'accord.</span>
      </label>

      <p class="form__error" role="alert" hidden></p>
      <button class="button form__submit" type="submit">Envoyer</button>
      <div class="sending" hidden>
        <div class="bar"><span></span></div>
        <p class="sending__label">Envoi…</p>
      </div>
    </form>

    <section class="done" hidden>
      <h2 class="done__title">Merci !</h2>
      <p class="done__text">Votre impression est en ligne.</p>
      <button class="button done__again" type="button">Laisser une autre impression</button>
      <a class="button button--ghost" href="${EVENT_URL}">Voir l'archive</a>
    </section>
  </main>
`;

const form = app.querySelector<HTMLFormElement>(".form")!;
const authorInput = form.querySelector<HTMLInputElement>('[name="author"]')!;
const messageInput = form.querySelector<HTMLTextAreaElement>('[name="message"]')!;
const trap = form.querySelector<HTMLInputElement>('[name="website"]')!;
const consent = form.querySelector<HTMLInputElement>('[name="consent"]')!;
const count = form.querySelector<HTMLElement>(".field__count")!;
const fileInput = form.querySelector<HTMLInputElement>(".picker__input")!;
const picker = form.querySelector<HTMLElement>(".picker")!;
const preview = form.querySelector<HTMLElement>(".preview")!;
const previewImage = preview.querySelector<HTMLImageElement>(".preview__image")!;
const previewVideo = preview.querySelector<HTMLVideoElement>(".preview__video")!;
const previewState = preview.querySelector<HTMLElement>(".preview__state")!;
const previewBar = preview.querySelector<HTMLElement>(".bar span")!;
const previewLabel = preview.querySelector<HTMLElement>(".preview__label")!;
const errorBox = form.querySelector<HTMLElement>(".form__error")!;
const submit = form.querySelector<HTMLButtonElement>(".form__submit")!;
const sending = form.querySelector<HTMLElement>(".sending")!;
const sendingBar = sending.querySelector<HTMLElement>(".bar span")!;
const sendingLabel = sending.querySelector<HTMLElement>(".sending__label")!;
const done = app.querySelector<HTMLElement>(".done")!;

try {
  authorInput.value = localStorage.getItem(AUTHOR_KEY) ?? "";
} catch {
  // navigation privée : rien à préremplir
}

messageInput.addEventListener("input", () => {
  count.textContent = `${messageInput.value.length} / ${MAX_MESSAGE}`;
});

// --- Média : compressé dès qu'il est choisi ---------------------------------------

interface MediaState {
  prepared: Promise<PreparedMedia>;
  abort: AbortController;
  url: string | null;
}
let media: MediaState | null = null;

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (file) selectMedia(file);
});
preview.querySelector(".preview__remove")!.addEventListener("click", () => clearMedia());

function selectMedia(file: File): void {
  clearMedia();
  showError(null);
  const video = isVideoFile(file);
  const abort = new AbortController();
  picker.hidden = true;
  preview.hidden = false;
  previewImage.hidden = video;
  previewVideo.hidden = !video;
  setPreviewState(0, video ? "Préparation de la vidéo… gardez cette page ouverte." : "Préparation de la photo…");

  let wakeLock: { release: () => Promise<void> } | null = null;
  if (video) {
    // Écran allumé pendant la compression (elle dure le temps de la vidéo)
    void (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock
      ?.request("screen")
      .then((lock) => (wakeLock = lock))
      .catch(() => {});
    previewVideo.addEventListener(
      "loadedmetadata",
      () => {
        if (previewVideo.duration > MAX_VIDEO_SECONDS + 0.5) {
          setPreviewState(0, `Préparation… seules les ${MAX_VIDEO_SECONDS} premières secondes sont gardées.`);
        }
      },
      { once: true },
    );
  }

  const prepared = video
    ? prepareVideo(file, previewVideo, (r) => setPreviewState(r, null), abort.signal)
    : prepareImage(file);
  const state: MediaState = { prepared, abort, url: null };
  media = state;
  prepared.then(
    (result) => {
      if (media !== state) return;
      state.url = URL.createObjectURL(result.blob);
      if (result.kind === "video") {
        previewVideo.loop = true;
        previewVideo.src = state.url;
        void previewVideo.play().catch(() => {});
      } else {
        previewImage.src = state.url;
      }
      setPreviewState(1, `Prêt · ${formatBytes(result.blob.size)}`);
      previewState.classList.add("is-ready");
    },
    (err: unknown) => {
      if (media !== state || isAbort(err)) return;
      clearMedia();
      showError(err instanceof Error ? err.message : "Ce fichier n'a pas pu être préparé.");
    },
  ).finally(() => void wakeLock?.release().catch(() => {}));
  // L'erreur est traitée ci-dessus ; l'envoi la retrouve s'il attend ce média
  prepared.catch(() => {});
}

function clearMedia(): void {
  if (media) {
    media.abort.abort();
    if (media.url) URL.revokeObjectURL(media.url);
  }
  media = null;
  previewVideo.pause();
  previewVideo.removeAttribute("src");
  previewVideo.load();
  previewImage.removeAttribute("src");
  previewState.classList.remove("is-ready");
  preview.hidden = true;
  picker.hidden = false;
}

function setPreviewState(ratio: number, label: string | null): void {
  previewBar.style.width = `${Math.round(ratio * 100)}%`;
  if (label !== null) previewLabel.textContent = label;
}

// --- Envoi -------------------------------------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void send();
});

async function send(): Promise<void> {
  showError(null);
  const author = authorInput.value.trim();
  const message = messageInput.value.trim();
  if (!author) return fail("Indiquez un nom ou un pseudonyme.", authorInput);
  if (!message && !media) return fail("Écrivez un commentaire ou ajoutez une photo ou une vidéo.", messageInput);
  if (!consent.checked) return fail("Cochez l'accord de publication pour envoyer.", consent);
  // Robot (champ invisible rempli) : on fait comme si de rien n'était
  if (trap.value) return showDone();

  setBusy(true);
  try {
    let prepared: PreparedMedia | null = null;
    if (media) {
      setSending(0, "Préparation du média…");
      prepared = await media.prepared;
    }
    setSending(0, "Envoi… 0 %");
    await submitContribution({ author, message, media: prepared }, (r) => setSending(r, `Envoi… ${Math.round(r * 100)} %`));
    try {
      localStorage.setItem(AUTHOR_KEY, author);
    } catch {
      // sans conséquence
    }
    showDone();
  } catch (err) {
    showError(err instanceof Error ? err.message : "L'envoi a échoué. Réessayez.");
  } finally {
    setBusy(false);
  }
}

function fail(message: string, field: HTMLElement): void {
  showError(message);
  field.focus();
}

function setBusy(busy: boolean): void {
  submit.hidden = busy;
  sending.hidden = !busy;
  form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button").forEach((el) => {
    if (el !== submit) el.disabled = busy;
  });
}

function setSending(ratio: number, label: string): void {
  sendingBar.style.width = `${Math.round(ratio * 100)}%`;
  sendingLabel.textContent = label;
}

function showError(message: string | null): void {
  errorBox.hidden = message === null;
  errorBox.textContent = message ?? "";
}

function showDone(): void {
  form.hidden = true;
  done.hidden = false;
  window.scrollTo({ top: 0 });
}

done.querySelector(".done__again")!.addEventListener("click", () => {
  clearMedia();
  messageInput.value = "";
  count.textContent = `0 / ${MAX_MESSAGE}`;
  done.hidden = true;
  form.hidden = false;
  messageInput.focus();
});

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} ko` : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`;
}
