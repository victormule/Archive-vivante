import * as THREE from "three";
import { dyno } from "@sparkjsdev/spark";

/**
 * Atténuation radiale des splats autour d'un axe vertical : opacité intacte
 * jusqu'à `inner` (m, distance horizontale), nulle au-delà de `outer`. La
 * force (0 = sans effet, 1 = pleine) se règle sans recompiler : seuls les
 * uniformes changent.
 */
export class RadialFade {
  readonly center = new dyno.DynoVec3({ value: new THREE.Vector3() });
  readonly inner = new dyno.DynoFloat({ value: 0 });
  readonly outer = new dyno.DynoFloat({ value: 1 });
  readonly strength = new dyno.DynoFloat({ value: 0 });
  /** Modificateur appliqué dans le repère monde (après le placement de la session). */
  readonly modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (!gsplat) throw new Error("gsplat manquant");
    const { center, opacity } = dyno.splitGsplat(gsplat).outputs;
    const distance = dyno.length(dyno.swizzle(dyno.sub(center, this.center), "xz"));
    const kept = dyno.sub(dyno.dynoConst("float", 1), dyno.smoothstep(this.inner, this.outer, distance));
    const factor = dyno.mix(dyno.dynoConst("float", 1), kept, this.strength);
    return { gsplat: dyno.combineGsplat({ gsplat, opacity: dyno.mul(opacity, factor) }) };
  });

  /** Renvoie vrai si un uniforme a changé (les splats sont alors à régénérer). */
  set(center: THREE.Vector3, inner: number, outer: number, strength: number): boolean {
    const changed = !this.center.value.equals(center) || this.inner.value !== inner || this.outer.value !== outer || this.strength.value !== strength;
    this.center.value.copy(center);
    this.inner.value = inner;
    this.outer.value = Math.max(outer, inner + 1e-3);
    this.strength.value = strength;
    return changed;
  }
}
