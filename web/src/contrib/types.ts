/** Une contribution telle qu'enregistrée (table `contributions`). */
export interface Contribution {
  id: string;
  created_at: string;
  author: string;
  message: string;
  media_kind: "image" | "video" | null;
  media_path: string | null;
  thumb_path: string | null;
  media_width: number | null;
  media_height: number | null;
}

/** Média prêt à l'envoi, déjà compressé. */
export interface PreparedMedia {
  kind: "image" | "video";
  blob: Blob;
  /** Extension du fichier principal (webp, jpg, mp4, webm). */
  ext: string;
  thumb: Blob;
  thumbExt: string;
  width: number;
  height: number;
}
