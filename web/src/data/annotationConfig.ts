import { annotationMedia } from "@/ui/annotations/annotationMedia";
import type { Annotation, AnnotationImage, AnnotationMediaEntry, MediaItem, Vec3 } from "./types";

/**
 * Configuration éditoriale des annotations : `public/annotations.config.json`.
 *
 * Lue par le site au chargement, par-dessus les annotations produites par le
 * pipeline (qui restent intactes). Tout est optionnel : une annotation absente
 * du fichier, ou un champ absent, garde sa valeur d'origine.
 */

/** Un média : un nom de fichier, ou un objet quand on veut préciser la vignette. */
export type MediaConfigEntry =
  | string
  | {
      file: string;
      /** Vidéo : image d'attente. */
      poster?: string;
      /** PDF : image de la première page. */
      thumbnail?: string;
      /** PDF : nombre de pages (pastille). */
      pages?: number;
      /** Audio : nom affiché (« Audio 1 » par défaut). */
      label?: string;
      /** Audio : durée en secondes (affichée avant l'écoute). */
      duration?: number;
    };

export interface AnnotationOverride {
  title?: string;
  /** Un texte (lignes à la suite) ou une liste de paragraphes. */
  text?: string | string[];
  /** Couleur CSS (`#d99a35`, `rgb(…)`, nom) ou numéro de la palette. */
  color?: string | number;
  /** Remplace tous les médias, dans cet ordre. `[]` les retire tous. */
  media?: MediaConfigEntry[];
  hidden?: boolean;
  /** Décalage de l'épingle, en mètres, dans le repère de la session (y vers le haut). */
  offset?: Vec3;
}

export interface AnnotationConfig {
  /** Couleurs numérotées (le numéro est celui des annotations, par titre). */
  palette?: string[];
  /** session -> (titre d'origine de l'annotation, ou 8 premiers caractères de son id) -> réglages. */
  sessions: Record<string, Record<string, AnnotationOverride>>;
}

export const EMPTY_CONFIG: AnnotationConfig = { sessions: {} };

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov", "m4v"]);
const DOCUMENT_EXT = new Set(["pdf"]);
const AUDIO_EXT = new Set(["m4a", "mp3", "wav", "aac", "ogg", "opus", "flac"]);

type Warn = (message: string) => void;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Valide le JSON lu : ce qui est inutilisable est écarté avec un avertissement, jamais d'exception. */
export function parseAnnotationConfig(raw: unknown, warn: Warn = () => {}): AnnotationConfig {
  if (!isRecord(raw)) {
    warn("le fichier doit être un objet { \"sessions\": { … } }");
    return EMPTY_CONFIG;
  }
  const config: AnnotationConfig = { sessions: {} };

  if (raw.palette !== undefined) {
    if (Array.isArray(raw.palette) && raw.palette.every((c) => typeof c === "string" && c.trim())) {
      config.palette = raw.palette as string[];
    } else {
      warn("« palette » doit être une liste de couleurs (texte)");
    }
  }

  const sessions = raw.sessions;
  if (sessions !== undefined && !isRecord(sessions)) warn("« sessions » doit être un objet");
  for (const [sessionId, entries] of Object.entries(isRecord(sessions) ? sessions : {})) {
    if (sessionId.startsWith("$")) continue;
    if (!isRecord(entries)) {
      warn(`${sessionId} : attendu un objet { "titre de l'annotation": { … } }`);
      continue;
    }
    const overrides: Record<string, AnnotationOverride> = {};
    for (const [key, value] of Object.entries(entries)) {
      if (key.startsWith("$")) continue;
      if (!isRecord(value)) {
        warn(`${sessionId} › ${key} : attendu un objet de réglages`);
        continue;
      }
      overrides[key] = parseOverride(`${sessionId} › ${key}`, value, warn);
    }
    config.sessions[sessionId] = overrides;
  }
  return config;
}

function parseOverride(where: string, raw: Record<string, unknown>, warn: Warn): AnnotationOverride {
  const out: AnnotationOverride = {};
  const expect = (field: string, ok: boolean, wanted: string): boolean => {
    if (!ok) warn(`${where} : « ${field} » ignoré (${wanted})`);
    return ok;
  };
  if (raw.title !== undefined && expect("title", typeof raw.title === "string", "texte attendu")) out.title = raw.title as string;
  if (raw.text !== undefined) {
    const ok = typeof raw.text === "string" || (Array.isArray(raw.text) && raw.text.every((t) => typeof t === "string"));
    if (expect("text", ok, "texte ou liste de paragraphes attendu")) out.text = raw.text as string | string[];
  }
  if (raw.color !== undefined) {
    const ok = (typeof raw.color === "string" && raw.color.trim() !== "") || (typeof raw.color === "number" && Number.isInteger(raw.color) && raw.color >= 0);
    if (expect("color", ok, "couleur CSS ou numéro de palette attendu")) out.color = raw.color as string | number;
  }
  if (raw.media !== undefined) {
    if (expect("media", Array.isArray(raw.media), "liste attendue")) {
      out.media = (raw.media as unknown[]).filter((m, i): m is MediaConfigEntry => {
        const ok = typeof m === "string" || (isRecord(m) && typeof m.file === "string");
        if (!ok) warn(`${where} : media n°${i + 1} ignoré (nom de fichier ou { "file": … } attendu)`);
        return ok;
      });
    }
  }
  if (raw.hidden !== undefined && expect("hidden", typeof raw.hidden === "boolean", "true ou false attendu")) out.hidden = raw.hidden as boolean;
  if (raw.offset !== undefined && expect("offset", isVec3(raw.offset), "[x, y, z] en mètres attendu")) out.offset = raw.offset as Vec3;
  return out;
}

/** `https://…` et `/…` tels quels ; `dossier/fichier` depuis la racine du site ; un nom seul vient de `media/`. */
export function resolveConfigUrl(file: string, base = "/"): string {
  const name = file.trim();
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(name) || name.startsWith("/")) return name;
  return encodeURI(name.includes("/") ? `${base}${name}` : `${base}media/${name}`);
}

const extension = (file: string): string => file.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
const basename = (file: string): string => decodeURI(file.split(/[?#]/)[0].split("/").pop() ?? file);

function thumbnailImage(url: string, source: string): AnnotationImage {
  // Dimensions inconnues : la mise en page se fait sur le conteneur
  return { url, width: 0, height: 0, source };
}

function resolveMedia(
  entries: MediaConfigEntry[],
  base: string,
  known: Map<string, AnnotationMediaEntry>,
  where: string,
  warn: Warn,
): AnnotationMediaEntry[] {
  const result: AnnotationMediaEntry[] = [];
  for (const entry of entries) {
    const file = typeof entry === "string" ? entry : entry.file;
    const options: { poster?: string; thumbnail?: string; pages?: number; label?: string; duration?: number } =
      typeof entry === "string" ? {} : entry;
    const ext = extension(file);
    const url = resolveConfigUrl(file, base);
    // Média déjà publié par le pipeline : on garde ses dimensions, sa vignette et son nombre de pages
    const published = known.get(url);
    if (published && !options.poster && !options.thumbnail) {
      const named = published.item.kind === "audio" && (options.label || options.duration)
        ? { ...published, item: { ...published.item, label: options.label ?? published.item.label, duration: options.duration ?? published.item.duration } }
        : published;
      result.push(named);
      continue;
    }
    const source = basename(file);
    let item: MediaItem;
    let thumbnail: AnnotationImage | null = null;
    if (IMAGE_EXT.has(ext)) {
      item = { kind: "image", url, source };
      thumbnail = thumbnailImage(url, source);
    } else if (VIDEO_EXT.has(ext)) {
      const poster = options.poster ? resolveConfigUrl(options.poster, base) : undefined;
      item = { kind: "video", url, poster, source };
      thumbnail = poster ? thumbnailImage(poster, source) : null;
    } else if (DOCUMENT_EXT.has(ext)) {
      const preview = options.thumbnail ? resolveConfigUrl(options.thumbnail, base) : undefined;
      item = { kind: "pdf", url, source, pages: options.pages };
      thumbnail = preview ? thumbnailImage(preview, source) : null;
    } else if (AUDIO_EXT.has(ext)) {
      item = { kind: "audio", url, source, duration: options.duration, label: options.label };
    } else {
      warn(`${where} : « ${file} » ignoré (formats : ${[...IMAGE_EXT, ...VIDEO_EXT, ...DOCUMENT_EXT, ...AUDIO_EXT].join(", ")})`);
      continue;
    }
    result.push({ item, thumbnail });
  }
  return result;
}

/**
 * Applique la configuration d'une session à ses annotations (sans modifier les originales).
 * `base` : préfixe des URLs du site (`import.meta.env.BASE_URL`).
 */
export function applyAnnotationConfig(
  sessionId: string,
  annotations: Annotation[],
  config: AnnotationConfig,
  base = "/",
  warn: Warn = () => {},
): Annotation[] {
  const overrides = config.sessions[sessionId] ?? {};
  const used = new Set<string>();
  const result: Annotation[] = [];

  for (const annotation of annotations) {
    // Repérée par son titre d'origine ; à défaut par les 8 premiers caractères de son identifiant
    const key = [annotation.title, annotation.id.slice(0, 8)].find((k) => k in overrides && !used.has(k))
      ?? Object.keys(overrides).find((k) => k.toLowerCase() === annotation.id.slice(0, 8).toLowerCase() && !used.has(k));
    if (key === undefined) {
      result.push(applyPalette(annotation, config));
      continue;
    }
    used.add(key);
    const override = overrides[key];
    if (override.hidden) continue;

    const next: Annotation = { ...annotation };
    if (override.title !== undefined) next.title = override.title;
    if (override.text !== undefined) next.text = Array.isArray(override.text) ? override.text.join("\n\n") : override.text;
    if (override.offset) {
      const [dx, dy, dz] = override.offset;
      next.points = annotation.points.map(([x, y, z]): Vec3 => [x + dx, y + dy, z + dz]);
    }
    if (override.media) {
      const known = new Map(annotationMedia(annotation).map((m) => [m.item.url, m]));
      next.media = resolveMedia(override.media, base, known, `${sessionId} › ${key}`, warn);
    }
    if (typeof override.color === "number") {
      next.colorIndex = override.color;
      result.push(applyPalette(next, config));
      continue;
    }
    if (typeof override.color === "string") next.color = override.color;
    result.push(next.color ? next : applyPalette(next, config));
  }

  for (const key of Object.keys(overrides)) {
    if (!used.has(key)) {
      warn(`${sessionId} : aucune annotation « ${key} » (titre d'origine ou 8 premiers caractères de l'identifiant)`);
    }
  }
  return result;
}

/** Palette personnalisée : la couleur numérotée de l'annotation (les couleurs par défaut sinon). */
function applyPalette(annotation: Annotation, config: AnnotationConfig): Annotation {
  const { palette } = config;
  if (!palette || palette.length === 0 || annotation.color || annotation.colorIndex == null) return annotation;
  return { ...annotation, color: palette[annotation.colorIndex % palette.length] };
}
