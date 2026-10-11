/** Contributions du public : projet Supabase (voir supabase/contributions.sql). */
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "";
/** Clé « publishable » : publique, les droits sont fixés côté serveur. */
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY ?? "";
export const BUCKET = "contributions";
export const TABLE = "contributions";

export const MAX_AUTHOR = 40;
export const MAX_MESSAGE = 1000;
/** Aucun fichier envoyé ne dépasse cette taille (le bucket la refuse aussi). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Cible des vidéos recompressées, sous la limite par prudence (le débit réel varie). */
export const VIDEO_TARGET_BYTES = 8 * 1024 * 1024;
/** Durée maximale d'une vidéo (s) : au-delà, seul le début est gardé. */
export const MAX_VIDEO_SECONDS = 30;
export const IMAGE_MAX_SIDE = 1920;
export const VIDEO_MAX_LONG = 1280;
export const VIDEO_MAX_SHORT = 720;
export const THUMB_MAX_SIDE = 480;

export function publicMediaUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}
