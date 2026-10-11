import * as THREE from "three";
import type { Vec3 } from "./types";

/**
 * `public/plan.config.json`. Le plan (SVG) est fixe ; chaque session y est posée : son point `anchor` (au sol)
 * est amené en `position`, tourné de `rotation` et mis à l'échelle de `scale` autour de lui.
 */

export interface PlanPose {
  /** Point (x, z) où tombe le centre du SVG (milieu de sa viewBox). */
  center: [number, number];
  /** Rotation autour de la verticale (degrés, sens trigonométrique vu de dessus). */
  rotation: number;
  /** Hauteur du sol (y) : celle du plan et de tous les modèles. */
  floor: number;
}

export interface SessionPlacement {
  /** Point du modèle, au sol (repère de la `worldTransform`), qui sert de repère. */
  anchor: Vec3;
  /** Où ce point est posé sur le plan (x, z) ; il y arrive au niveau du sol. */
  position: [number, number];
  /** Rotation du modèle autour de la verticale (degrés). */
  rotation: number;
  scale: number;
}

export interface PlanConfig {
  /** Fichier du plan, depuis la racine du site. */
  svg: string;
  metersPerUnit: number;
  color: string;
  opacity: number;
  plan: PlanPose;
  /** Emplacement de chaque session (`{ "sameAs": "j1-s1" }` reprend celui d'une autre, `scale` en plus). */
  sessions: Record<string, SessionPlacement>;
  /** Vue d'ensemble : splats d'une session nets jusqu'à `inner` m de son centre, effacés au-delà de `outer` m. */
  fullFade: { inner: number; outer: number };
}

const DEFAULT_FULL_FADE = { inner: 3, outer: 5 };

type Warn = (message: string) => void;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumbers = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(isFiniteNumber);

/** Valide le JSON lu ; une session mal décrite est ignorée avec un avertissement, jamais d'exception. */
export function parsePlanConfig(raw: unknown, warn: Warn = () => {}): PlanConfig | null {
  if (!isRecord(raw)) {
    warn("le fichier doit être un objet");
    return null;
  }
  if (typeof raw.svg !== "string" || !raw.svg.trim()) {
    warn("« svg » : chemin du plan attendu");
    return null;
  }
  if (!isFiniteNumber(raw.metersPerUnit) || raw.metersPerUnit <= 0) {
    warn("« metersPerUnit » : nombre positif attendu");
    return null;
  }
  const plan = isRecord(raw.plan) ? raw.plan : {};
  if (!isNumbers(plan.center, 2) || !isFiniteNumber(plan.rotation) || !isFiniteNumber(plan.floor)) {
    warn("« plan » : attendu { \"center\": [x, z], \"rotation\": degrés, \"floor\": y }");
    return null;
  }
  const opacity = isFiniteNumber(raw.opacity) ? Math.min(1, Math.max(0, raw.opacity)) : 0.35;
  const color = typeof raw.color === "string" && raw.color.trim() ? raw.color : "#c8c8c8";

  const entries = isRecord(raw.sessions) ? raw.sessions : {};
  if (raw.sessions !== undefined && !isRecord(raw.sessions)) warn("« sessions » doit être un objet");
  const own = new Map<string, SessionPlacement>();
  const aliases = new Map<string, { target: string; scale?: number }>();
  for (const [id, value] of Object.entries(entries)) {
    if (id.startsWith("$")) continue;
    if (isRecord(value) && typeof value.sameAs === "string") {
      const scale = isFiniteNumber(value.scale) && value.scale > 0 ? value.scale : undefined;
      aliases.set(id, { target: value.sameAs, scale });
      continue;
    }
    const placement = parsePlacement(value);
    if (placement) own.set(id, placement);
    else warn(`${id} : attendu { "anchor": [x, y, z], "position": [x, z], "rotation": degrés, "scale": 1 } ou { "sameAs": "<session>" }`);
  }
  const sessions: Record<string, SessionPlacement> = Object.fromEntries(own);
  for (const [id, { target, scale }] of aliases) {
    const placement = own.get(target);
    if (placement) sessions[id] = { ...placement, scale: scale ?? placement.scale };
    else warn(`${id} : « sameAs » vise « ${target} », qui n'a pas d'emplacement propre`);
  }
  let fullFade = DEFAULT_FULL_FADE;
  if (raw.fullFade !== undefined) {
    const f = isRecord(raw.fullFade) ? raw.fullFade : {};
    if (isFiniteNumber(f.inner) && isFiniteNumber(f.outer) && f.inner >= 0 && f.outer > f.inner) fullFade = { inner: f.inner, outer: f.outer };
    else warn("« fullFade » : attendu { \"inner\": m, \"outer\": m } avec 0 ≤ inner < outer");
  }
  return {
    svg: raw.svg,
    metersPerUnit: raw.metersPerUnit,
    color,
    opacity,
    plan: { center: [plan.center[0], plan.center[1]], rotation: plan.rotation, floor: plan.floor },
    sessions,
    fullFade,
  };
}

function parsePlacement(raw: unknown): SessionPlacement | null {
  if (!isRecord(raw)) return null;
  const { anchor, position, rotation } = raw;
  const scale = raw.scale ?? 1;
  if (!isNumbers(anchor, 3) || !isNumbers(position, 2) || !isFiniteNumber(rotation)) return null;
  if (!isFiniteNumber(scale) || scale <= 0) return null;
  return { anchor: [anchor[0], anchor[1], anchor[2]], position: [position[0], position[1]], rotation, scale };
}

export function placementMatrix(placement: SessionPlacement, floor: number): THREE.Matrix4 {
  const [ax, ay, az] = placement.anchor;
  return new THREE.Matrix4()
    .makeTranslation(placement.position[0], floor, placement.position[1])
    .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(placement.rotation)))
    .multiply(new THREE.Matrix4().makeScale(placement.scale, placement.scale, placement.scale))
    .multiply(new THREE.Matrix4().makeTranslation(-ax, -ay, -az));
}
