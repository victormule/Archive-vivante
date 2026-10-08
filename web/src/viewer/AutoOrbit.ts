import * as THREE from "three";

export interface AutoOrbitOptions {
  /** Point de l'axe vertical ; la caméra regarde vers ce point. */
  center: THREE.Vector3;
  /** Durée (s) d'un tour complet à vitesse de croisière. */
  turnSeconds: number;
  /** Angle (degrés) parcouru entre deux appels à `onStep` (défaut : 360, un tour). */
  stepDegrees?: number;
  /** Distance horizontale à l'axe : la caméra s'y ramène doucement si elle en sort. */
  radius?: { min: number; max: number };
  /** Hauteur au-dessus du centre : idem. */
  height?: { min: number; max: number };
}

/** Durée (s) de la mise en mouvement (vitesse, regard, rayon). */
const EASE_IN = 7;
/** Amplitude relative de la respiration (rayon) et absolue (hauteur, m) sur un tour. */
const BREATH_RADIUS = 0.06;
const BREATH_HEIGHT = 0.3;

const smoothstep = (x: number) => {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Rotation lente de la caméra autour d'un axe vertical.
 *
 * Le mouvement part exactement de la pose courante : la vitesse monte
 * progressivement, le regard glisse vers l'axe, le rayon et la hauteur
 * rejoignent une orbite confortable. Une légère respiration (rayon, hauteur)
 * accompagne chaque tour. `onStep` est appelé tous les `stepDegrees` parcourus.
 */
export class AutoOrbit {
  private readonly startQuaternion = new THREE.Quaternion();
  private readonly lookQuaternion = new THREE.Quaternion();
  private readonly matrix = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly lookAt = new THREE.Vector3();
  private readonly startAngle: number;
  private readonly startRadius: number;
  private readonly startHeight: number;
  private readonly targetRadius: number;
  private readonly targetHeight: number;
  private elapsed = 0;
  /** Angle parcouru depuis le départ (rad). */
  private travelled = 0;
  private steps = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly options: AutoOrbitOptions,
    private readonly onStep: (step: number) => void,
  ) {
    const { center } = options;
    const offset = camera.position.clone().sub(center);
    this.startAngle = Math.atan2(offset.x, offset.z);
    this.startRadius = Math.hypot(offset.x, offset.z);
    this.startHeight = offset.y;
    this.startQuaternion.copy(camera.quaternion);
    const radius = options.radius ?? { min: 3.5, max: 9 };
    const height = options.height ?? { min: 1.2, max: 4.5 };
    this.targetRadius = THREE.MathUtils.clamp(this.startRadius, radius.min, radius.max);
    this.targetHeight = THREE.MathUtils.clamp(this.startHeight, height.min, height.max);
  }

  update(dt: number): void {
    // Un onglet en arrière-plan peut renvoyer un très grand dt
    const step = Math.min(dt, 0.1);
    this.elapsed += step;
    const ease = smoothstep(this.elapsed / EASE_IN);
    const speed = (2 * Math.PI) / this.options.turnSeconds;
    // Sens horaire vu du dessus
    this.travelled += speed * ease * step;

    const breath = Math.sin(this.travelled);
    const radius = THREE.MathUtils.lerp(this.startRadius, this.targetRadius, ease) * (1 + BREATH_RADIUS * breath * ease);
    const height = THREE.MathUtils.lerp(this.startHeight, this.targetHeight, ease) + BREATH_HEIGHT * Math.sin(this.travelled * 0.5) ** 2 * ease;
    const angle = this.startAngle - this.travelled;
    const { center } = this.options;
    this.camera.position.set(center.x + radius * Math.sin(angle), center.y + height, center.z + radius * Math.cos(angle));

    // Le regard glisse de l'orientation de départ vers l'axe
    this.lookAt.copy(center);
    this.matrix.lookAt(this.camera.position, this.lookAt, this.up);
    this.lookQuaternion.setFromRotationMatrix(this.matrix);
    this.camera.quaternion.slerpQuaternions(this.startQuaternion, this.lookQuaternion, smoothstep(this.elapsed / (EASE_IN * 1.3)));

    const stepAngle = THREE.MathUtils.degToRad(this.options.stepDegrees ?? 360);
    const steps = Math.floor(this.travelled / stepAngle);
    if (steps > this.steps) {
      this.steps = steps;
      this.onStep(steps);
    }
  }

  /** Point regardé, pour que l'orbite manuelle reprenne sans à-coup. */
  focus(target: THREE.Vector3): THREE.Vector3 {
    const distance = this.camera.position.distanceTo(this.options.center);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return target.copy(this.camera.position).addScaledVector(forward, distance);
  }
}
