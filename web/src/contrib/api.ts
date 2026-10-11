import { BUCKET, SUPABASE_KEY, SUPABASE_URL, TABLE } from "./config";
import type { PreparedMedia } from "./types";

/** API REST de Supabase, sans la bibliothèque cliente : le formulaire reste léger sur téléphone. */

export interface ContributionDraft {
  author: string;
  message: string;
  media: PreparedMedia | null;
}

const NETWORK_ERROR = "Connexion impossible. Vérifiez le réseau et réessayez.";

export async function submitContribution(draft: ContributionDraft, onProgress: (ratio: number) => void): Promise<void> {
  let media: Record<string, unknown> = {};
  if (draft.media) {
    const { blob, ext, thumb, thumbExt, kind, width, height } = draft.media;
    const id = uuid();
    const mediaPath = `${id}.${ext}`;
    const thumbPath = `${id}-thumb.${thumbExt}`;
    const total = blob.size + thumb.size;
    await uploadFile(thumbPath, thumb, (loaded) => onProgress((loaded / total) * 0.95));
    await uploadFile(mediaPath, blob, (loaded) => onProgress(((thumb.size + loaded) / total) * 0.95));
    media = { media_kind: kind, media_path: mediaPath, thumb_path: thumbPath, media_width: width, media_height: height };
  }
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ author: draft.author, message: draft.message, ...media }),
    });
  } catch {
    throw new Error(NETWORK_ERROR);
  }
  if (!res.ok) throw new Error(await errorMessage(res));
  onProgress(1);
}

/** XHR : fetch ne donne pas la progression à l'envoi. */
function uploadFile(path: string, blob: Blob, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`);
    xhr.setRequestHeader("apikey", SUPABASE_KEY);
    xhr.setRequestHeader("Content-Type", blob.type);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("Cache-Control", "max-age=31536000");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      reject(new Error(parseError(xhr.responseText) ?? `Envoi du fichier refusé (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error(NETWORK_ERROR));
    xhr.send(blob);
  });
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return parseError(text) ?? `Envoi refusé (${res.status}).`;
}

function parseError(text: string): string | null {
  try {
    const body = JSON.parse(text) as { message?: string; error?: string };
    const message = body.message ?? body.error ?? null;
    // Limite de débit (déclencheur SQL) : message déjà rédigé pour le public
    if (message && /réessayez/i.test(message)) return message;
    if (message && /too large|exceeded/i.test(message)) return "Fichier trop lourd (10 Mo au plus).";
    return message ? `Envoi refusé : ${message}` : null;
  } catch {
    return null;
  }
}

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
