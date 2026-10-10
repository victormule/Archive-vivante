/**
 * Contrat de données produit par pipeline/build_sessions.py.
 * Toute évolution doit être répercutée des deux côtés.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface SessionSummary {
  id: string;
  title: string;
  day: number;
  index: number;
  startDate?: string;
}

/** Réglages communs à toutes les sessions (repère commun du projet). */
export interface SceneConfig {
  /** Vue d'arrivée. */
  initialView: CameraView | null;
  /** Rotation automatique après inactivité, autour d'un axe vertical. */
  orbit: OrbitConfig | null;
}

export interface OrbitConfig {
  /** Point de l'axe vertical (et hauteur du regard). */
  center: Vec3;
  /** Inactivité (s) avant le démarrage de la rotation. */
  idle_seconds?: number;
  /** Durée (s) d'un tour complet ; une session par tour. */
  turn_seconds?: number;
  switch_degrees?: number;
}

export interface SessionIndex {
  scene?: SceneConfig;
  sessions: SessionSummary[];
}

export type LayerId = "splat" | "mesh" | "pointCloud";

export interface SplatLayerData {
  url: string;
  /** Taille du fichier (progression globale du chargement). */
  bytes?: number;
  count: number | null;
  shDegree: number | null;
}

export interface MeshLayerData {
  url: string;
  bytes?: number;
  triangles: number;
}

/**
 * Nuage binaire : N×3 uint16 (positions quantifiées dans [boundsMin, boundsMax])
 * suivis de N×3 uint8 (RGB).
 */
export interface PointCloudLayerData {
  url: string;
  bytes?: number;
  count: number;
  voxelSize: number;
  boundsMin: Vec3;
  boundsMax: Vec3;
}

export interface SessionManifest extends SessionSummary {
  sessionId: string;
  startDate: string;
  endDate: string;
  author: string | null;
  /** Toutes les couches partagent le repère du splat. */
  layers: {
    splat: SplatLayerData | null;
    mesh: MeshLayerData | null;
    pointCloud: PointCloudLayerData | null;
  };
  annotations: { url: string; count: number } | null;
  /** Repère de la session -> repère commun du projet (4x4 column-major). */
  worldTransform?: number[];
  bounds: { min: Vec3 | null; max: Vec3 | null };
  alignment: Record<string, unknown>;
  playback: {
    audioUrl: string;
    cameraPathUrl: string;
    duration: number;
    recordedAt: string;
    /** Lissage gaussien du trajet caméra (s) propre à la session ; à défaut, celui de l'application. */
    cameraSmoothing?: number;
  } | null;
}

export interface CameraView {
  position: Vec3;
  /** Quaternion [x, y, z, w], caméra -> monde. */
  quaternion: Quat;
  /** Pivot de l'orbite. */
  target: Vec3;
  fovY?: number;
}

export interface CameraKeyframe {
  /** Temps en secondes depuis le début de la vidéo. */
  t: number;
  position: Vec3;
  /** Quaternion [x, y, z, w], caméra -> monde. */
  quaternion: Quat;
}

export interface CameraPathData {
  coordinateSystem: string;
  videoId: string;
  duration: number;
  /** Champ de vision vertical en degrés. */
  fovY: number;
  aspect: number;
  keyframes: CameraKeyframe[];
}

export interface AnnotationImage {
  url: string;
  width: number;
  height: number;
  /** Nom du fichier d'origine. */
  source: string;
}

/** Vidéo d'annotation : lue en boucle, sans le son. */
export interface AnnotationVideo {
  url: string;
  width: number;
  height: number;
  duration?: number;
  /** Image d'attente (premier plan de la vidéo). */
  poster?: AnnotationImage;
  source: string;
}

/** Document PDF d'annotation, illustré par sa première page. */
export interface AnnotationDocument {
  url: string;
  pages?: number;
  thumbnail?: AnnotationImage;
  source: string;
}

/** Enregistrement audio d'annotation : écouté au clic, dans un petit lecteur. */
export interface AnnotationAudio {
  url: string;
  /** Durée en secondes. */
  duration?: number;
  /** Nom affiché (« Audio 1 » par défaut). */
  label?: string;
  source: string;
}

/** Un média d'annotation tel que l'étiquette et la visionneuse l'affichent. */
export type MediaItem =
  | { kind: "image"; url: string; source: string }
  | { kind: "video"; url: string; poster?: string; source: string }
  | { kind: "pdf"; url: string; source: string; pages?: number }
  | { kind: "audio"; url: string; source: string; duration?: number; label?: string };

/** Un média d'annotation tel que la visionneuse l'affiche, avec sa vignette (absente : vignette de repli). */
export interface AnnotationMediaEntry {
  item: MediaItem;
  thumbnail: AnnotationImage | null;
}

export interface Annotation {
  id: string;
  title: string;
  /** Couleur commune à toutes les sessions pour un même titre. */
  colorIndex?: number | null;
  /** Texte libre ; paragraphes séparés par une ligne vide. */
  text: string;
  kind: string;
  /** Points 3D dans le repère du splat (1 point pour une épingle). */
  points: Vec3[];
  closed: boolean;
  updatedAt: string | null;
  images: AnnotationImage[];
  /** Absents des manifests construits avant l'ajout des vidéos et des PDF. */
  videos?: AnnotationVideo[];
  documents?: AnnotationDocument[];
  audios?: AnnotationAudio[];
  /** Couleur CSS imposée (annotations.config.json). */
  color?: string;
  /** Médias dans l'ordre voulu (annotations.config.json) : prioritaires sur images / vidéos / documents. */
  media?: AnnotationMediaEntry[];
}

export interface AnnotationsData {
  annotations: Annotation[];
}
