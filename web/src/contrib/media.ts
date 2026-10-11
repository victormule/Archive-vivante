import {
  IMAGE_MAX_SIDE,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_SECONDS,
  THUMB_MAX_SIDE,
  VIDEO_MAX_LONG,
  VIDEO_MAX_SHORT,
  VIDEO_TARGET_BYTES,
} from "./config";
import type { PreparedMedia } from "./types";

/**
 * Compression dans le navigateur, avant tout envoi : photos en WebP (JPEG à
 * défaut) de 1920 px au plus, vidéos réencodées en 720p, muettes et limitées
 * à 30 s. Repasser par un canvas retire aussi les métadonnées (position GPS).
 */

/** Dimensions entières réduites pour tenir dans `maxW` × `maxH` (jamais agrandies). */
export function fitSize(width: number, height: number, maxW: number, maxH: number, even = false): { width: number; height: number } {
  const scale = Math.min(1, maxW / width, maxH / height);
  const round = (v: number) => (even ? Math.max(2, Math.round(v / 2) * 2) : Math.max(1, Math.round(v)));
  return { width: round(width * scale), height: round(height * scale) };
}

/** Cadre d'une vidéo : 720p au plus, en paysage comme en portrait. */
export function fitVideo(width: number, height: number): { width: number; height: number } {
  return width >= height
    ? fitSize(width, height, VIDEO_MAX_LONG, VIDEO_MAX_SHORT, true)
    : fitSize(width, height, VIDEO_MAX_SHORT, VIDEO_MAX_LONG, true);
}

/** Débit vidéo (bit/s) pour tenir la taille cible sur la durée gardée. */
export function videoBitrate(seconds: number): number {
  const ideal = (VIDEO_TARGET_BYTES * 8) / Math.max(1, seconds);
  return Math.round(Math.min(4_000_000, Math.max(400_000, ideal)));
}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || /\.(mov|mp4|m4v|webm|3gp)$/i.test(file.name);
}

// --- Photos ------------------------------------------------------------------

export async function prepareImage(file: File): Promise<PreparedMedia> {
  const source = await decodeImage(file);
  try {
    const full = fitSize(source.width, source.height, IMAGE_MAX_SIDE, IMAGE_MAX_SIDE);
    const main = await encodeImage(source.image, full.width, full.height, [0.85, 0.75, 0.6, 0.45]);
    const t = fitSize(source.width, source.height, THUMB_MAX_SIDE, THUMB_MAX_SIDE);
    const thumb = await encodeImage(source.image, t.width, t.height, [0.75]);
    return { kind: "image", blob: main.blob, ext: main.ext, thumb: thumb.blob, thumbExt: thumb.ext, ...full };
  } finally {
    source.release();
  }
}

interface DecodedImage {
  image: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    // Repli (anciens Safari) : l'élément <img> applique lui aussi l'orientation EXIF
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("Ce format d'image n'est pas pris en charge. Essayez une photo JPEG ou PNG.");
    }
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  }
}

/** Encode en WebP (JPEG si le navigateur ne sait pas), qualité décroissante jusqu'à passer sous la limite. */
async function encodeImage(
  source: CanvasImageSource,
  width: number,
  height: number,
  qualities: number[],
): Promise<{ blob: Blob; ext: string }> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  let last: Blob | null = null;
  for (const quality of qualities) {
    let blob = await toBlob(canvas, "image/webp", quality);
    // Safari ne sait pas encoder le WebP : il renvoie un PNG
    if (blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", quality);
    last = blob;
    if (blob.size <= MAX_UPLOAD_BYTES) break;
  }
  canvas.width = canvas.height = 0;
  if (!last || last.size > MAX_UPLOAD_BYTES) throw new Error("Image trop lourde, même compressée.");
  return { blob: last, ext: last.type === "image/webp" ? "webp" : "jpg" };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Compression de l'image impossible."))), type, quality),
  );
}

// --- Vidéos ------------------------------------------------------------------

/** Lecture sans progression pendant ce délai (ms) : préparation abandonnée. */
const STALL_MS = 10000;
/** Lecture sans progression pendant ce délai (ms) : relancée. */
const NUDGE_MS = 1500;

const VIDEO_TYPES = [
  "video/mp4;codecs=avc1.42E01F",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickVideoType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}


/**
 * Réencode la vidéo en la lisant dans `preview` (élément visible : sur iOS, une
 * vidéo hors de la page n'est pas décodée) et en enregistrant un canvas : le
 * flux n'a pas de piste audio, la vidéo devient muette. Dure le temps de la
 * lecture (30 s au plus). La taille est surveillée : l'enregistrement s'arrête
 * avant la limite si le débit réel dépasse la cible.
 */
export async function prepareVideo(
  file: File,
  preview: HTMLVideoElement,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
): Promise<PreparedMedia> {
  const type = pickVideoType();
  if (!type || typeof HTMLCanvasElement.prototype.captureStream !== "function") {
    throw new Error("Ce navigateur ne peut pas préparer la vidéo. Essayez avec Safari ou Chrome à jour.");
  }
  const sourceUrl = URL.createObjectURL(file);
  preview.muted = true;
  preview.playsInline = true;
  preview.loop = false;
  preview.preload = "auto";
  preview.src = sourceUrl;
  try {
    // iOS ne charge l'image qu'à la lecture : on attend seulement les métadonnées
    await waitFor(preview, "loadedmetadata", signal, "Cette vidéo est illisible sur cet appareil.");
    if (!preview.videoWidth || !preview.videoHeight) throw new Error("Cette vidéo est illisible sur cet appareil.");
    const limit = Number.isFinite(preview.duration) && preview.duration > 0 ? Math.min(preview.duration, MAX_VIDEO_SECONDS) : MAX_VIDEO_SECONDS;
    const { width, height } = fitVideo(preview.videoWidth, preview.videoHeight);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;

    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: videoBitrate(limit) });
    const chunks: Blob[] = [];
    let bytes = 0;
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    const stop = () => {
      if (recorder.state !== "inactive") recorder.stop();
      preview.pause();
    };
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      chunks.push(e.data);
      bytes += e.data.size;
      // Marge pour le dernier morceau : on coupe avant la limite
      if (bytes > MAX_UPLOAD_BYTES * 0.9) stop();
    };
    const onAbort = () => stop();
    signal.addEventListener("abort", onAbort);

    await preview.play().catch(() => {
      throw new Error("La lecture de la vidéo a été bloquée. Réessayez.");
    });
    // Première image : vignette, puis enregistrement
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (signal.aborted) {
      preview.pause();
      throw new DOMException("Annulé", "AbortError");
    }
    ctx.drawImage(preview, 0, 0, width, height);
    const t = fitSize(width, height, THUMB_MAX_SIDE, THUMB_MAX_SIDE);
    const thumbReady = encodeImage(canvas, t.width, t.height, [0.75]);
    thumbReady.catch(() => {});
    recorder.start(500);
    // Lecture figée (décodeur saturé) : relancée, puis abandonnée avec un message plutôt qu'une attente sans fin
    let lastTime = -1;
    let lastChange = performance.now();
    let nudged = 0;
    let stalled = false;
    const draw = () => {
      if (recorder.state === "inactive") return;
      ctx.drawImage(preview, 0, 0, width, height);
      onProgress(Math.min(1, preview.currentTime / limit));
      const now = performance.now();
      if (preview.currentTime !== lastTime) {
        lastTime = preview.currentTime;
        lastChange = now;
        nudged = 0;
      } else if (now - lastChange > STALL_MS) {
        stalled = true;
      } else if (now - lastChange > (nudged + 1) * NUDGE_MS) {
        nudged += 1;
        preview.pause();
        void preview.play().catch(() => {});
      }
      if (stalled || preview.ended || preview.currentTime >= limit) stop();
      else requestAnimationFrame(draw);
    };
    // Cadence d'affichage : requestVideoFrameCallback a figé le décodage matériel de Chrome
    requestAnimationFrame(draw);
    preview.addEventListener("ended", stop, { once: true });
    await stopped;
    signal.removeEventListener("abort", onAbort);
    stream.getTracks().forEach((track) => track.stop());
    if (signal.aborted) throw new DOMException("Annulé", "AbortError");
    if (stalled) throw new Error("La préparation de la vidéo s'est bloquée. Réessayez, ou choisissez une autre vidéo.");
    const thumb = await thumbReady;

    const baseType = type.split(";")[0];
    const blob = new Blob(chunks, { type: baseType });
    if (!blob.size) throw new Error("La vidéo n'a pas pu être enregistrée. Réessayez.");
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error("Vidéo trop lourde, même compressée.");
    onProgress(1);
    return {
      kind: "video",
      blob,
      ext: baseType === "video/mp4" ? "mp4" : "webm",
      thumb: thumb.blob,
      thumbExt: thumb.ext,
      width,
      height,
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function waitFor(el: HTMLMediaElement, event: "loadedmetadata", signal: AbortSignal, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) return resolve();
    const done = (fn: () => void) => () => {
      el.removeEventListener(event, ok);
      el.removeEventListener("error", fail);
      signal.removeEventListener("abort", aborted);
      fn();
    };
    const ok = done(resolve);
    const fail = done(() => reject(new Error(message)));
    const aborted = done(() => reject(new DOMException("Annulé", "AbortError")));
    el.addEventListener(event, ok);
    el.addEventListener("error", fail);
    signal.addEventListener("abort", aborted);
  });
}
