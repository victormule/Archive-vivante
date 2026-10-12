import { applyAnnotationConfig, EMPTY_CONFIG, parseAnnotationConfig, type AnnotationConfig } from "./annotationConfig";
import { parsePlanConfig, type PlanConfig } from "./planConfig";
import type { AnnotationsData, CameraPathData, SessionIndex, SessionManifest } from "./types";

const SESSIONS_ROOT = `${import.meta.env.BASE_URL}sessions`;

async function fetchJson<T>(url: string): Promise<T> {
  // Revalidés à chaque visite : une mise à jour (annotations, trajet) est visible sans attendre la fin du cache
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Chargement impossible : ${url} (${res.status})`);
  return res.json() as Promise<T>;
}

export function sessionAssetUrl(sessionId: string, relative: string): string {
  return `${SESSIONS_ROOT}/${sessionId}/${relative}`;
}

const warnAnnotations = (message: string) => console.warn(`[annotations.config.json] ${message}`);

let annotationConfig: Promise<AnnotationConfig> | null = null;

/** Lue une fois. Fichier absent ou illisible : les annotations gardent leurs valeurs d'origine. */
function loadAnnotationConfig(): Promise<AnnotationConfig> {
  annotationConfig ??= (async () => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}annotations.config.json`, { cache: "no-cache" });
      if (!res.ok) return EMPTY_CONFIG;
      return parseAnnotationConfig(await res.json(), warnAnnotations);
    } catch (err) {
      console.error("[annotations.config.json] fichier illisible (virgule, guillemet ou accolade manquants ?), valeurs d'origine conservées :", err);
      return EMPTY_CONFIG;
    }
  })();
  return annotationConfig;
}

let planConfig: Promise<PlanConfig | null> | null = null;

/** Lu une fois ; absent ou illisible : pas de plan. */
export function loadPlanConfig(): Promise<PlanConfig | null> {
  planConfig ??= (async () => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}plan.config.json`, { cache: "no-cache" });
      if (!res.ok) return null;
      return parsePlanConfig(await res.json(), (message) => console.warn(`[plan.config.json] ${message}`));
    } catch (err) {
      console.error("[plan.config.json] fichier illisible, plan désactivé :", err);
      return null;
    }
  })();
  return planConfig;
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
  return { annotations: applyAnnotationConfig(manifest.id, data.annotations, config, import.meta.env.BASE_URL, warnAnnotations) };
}
