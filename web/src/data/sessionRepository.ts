import { applyAnnotationConfig, EMPTY_CONFIG, parseAnnotationConfig, type AnnotationConfig } from "./annotationConfig";
import type { AnnotationsData, CameraPathData, SessionIndex, SessionManifest } from "./types";

const SESSIONS_ROOT = `${import.meta.env.BASE_URL}sessions`;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Chargement impossible : ${url} (${res.status})`);
  return res.json() as Promise<T>;
}

/** Résout une URL relative d'un manifest vers une URL absolue servie. */
export function sessionAssetUrl(sessionId: string, relative: string): string {
  return `${SESSIONS_ROOT}/${sessionId}/${relative}`;
}

let annotationConfig: Promise<AnnotationConfig> | null = null;

/**
 * Configuration éditoriale des annotations (`annotations.config.json`), lue une fois.
 * Fichier absent ou illisible : les annotations gardent leurs valeurs d'origine.
 */
export function loadAnnotationConfig(): Promise<AnnotationConfig> {
  annotationConfig ??= (async () => {
    const warn = (message: string) => console.warn(`[annotations.config.json] ${message}`);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}annotations.config.json`, { cache: "no-cache" });
      if (!res.ok) return EMPTY_CONFIG;
      return parseAnnotationConfig(await res.json(), warn);
    } catch (err) {
      console.error("[annotations.config.json] fichier illisible (virgule, guillemet ou accolade manquants ?), valeurs d'origine conservées :", err);
      return EMPTY_CONFIG;
    }
  })();
  return annotationConfig;
}

export function loadSessionIndex(): Promise<SessionIndex> {
  return fetchJson(`${SESSIONS_ROOT}/index.json`);
}

export function loadSessionManifest(sessionId: string): Promise<SessionManifest> {
  return fetchJson(sessionAssetUrl(sessionId, "manifest.json"));
}

export function loadCameraPath(manifest: SessionManifest): Promise<CameraPathData> {
  if (!manifest.playback) throw new Error(`La session ${manifest.id} n'a pas de replay`);
  return fetchJson(sessionAssetUrl(manifest.id, manifest.playback.cameraPathUrl));
}

export async function loadAnnotations(manifest: SessionManifest): Promise<AnnotationsData> {
  if (!manifest.annotations) return { annotations: [] };
  const data = await fetchJson<AnnotationsData>(sessionAssetUrl(manifest.id, manifest.annotations.url));
  // Les URLs des médias (images, vidéos, PDF et leurs vignettes) sont relatives au dossier de la session
  const resolve = (url: string) => sessionAssetUrl(manifest.id, url);
  for (const a of data.annotations) {
    for (const img of a.images) img.url = resolve(img.url);
    for (const video of a.videos ?? []) {
      video.url = resolve(video.url);
      if (video.poster) video.poster.url = resolve(video.poster.url);
    }
    for (const audio of a.audios ?? []) audio.url = resolve(audio.url);
    for (const document of a.documents ?? []) {
      document.url = resolve(document.url);
      if (document.thumbnail) document.thumbnail.url = resolve(document.thumbnail.url);
    }
  }
  const config = await loadAnnotationConfig();
  const warn = (message: string) => console.warn(`[annotations.config.json] ${message}`);
  return { annotations: applyAnnotationConfig(manifest.id, data.annotations, config, import.meta.env.BASE_URL, warn) };
}
