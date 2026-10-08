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
  // Les URLs d'images sont relatives au dossier de la session
  for (const a of data.annotations) {
    for (const img of a.images) img.url = sessionAssetUrl(manifest.id, img.url);
  }
  return data;
}
