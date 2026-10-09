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
      video.poster.url = resolve(video.poster.url);
    }
    for (const document of a.documents ?? []) {
      document.url = resolve(document.url);
      document.thumbnail.url = resolve(document.thumbnail.url);
    }
  }
  return data;
}
