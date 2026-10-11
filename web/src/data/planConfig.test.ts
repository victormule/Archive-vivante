import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { parsePlanConfig, placementMatrix } from "./planConfig";

const plan = { center: [1, -2], rotation: 30, floor: -1.45 };
const placement = { anchor: [-0.6, -1.4, -4.2], position: [3, 5], rotation: 90, scale: 1 };

describe("parsePlanConfig", () => {
  it("lit le plan, les emplacements, et résout « sameAs » (échelle propre comprise)", () => {
    const config = parsePlanConfig({
      svg: "plan/plan.svg",
      metersPerUnit: 0.1,
      plan,
      sessions: { $aide: "x", a: placement, b: { sameAs: "a", scale: 1.1 }, c: { sameAs: "a" } },
    });
    expect(config?.plan).toEqual(plan);
    expect(config?.sessions.a).toEqual(placement);
    expect(config?.sessions.b).toEqual({ ...placement, scale: 1.1 });
    expect(config?.sessions.c).toEqual(placement);
    expect(config?.sessions.$aide).toBeUndefined();
    expect(config?.opacity).toBe(0.35);
  });

  it("écarte avec un avertissement une session mal décrite, sans lever", () => {
    const warnings: string[] = [];
    const config = parsePlanConfig({
      svg: "plan/plan.svg",
      metersPerUnit: 0.1,
      opacity: 3,
      plan,
      sessions: { a: { anchor: [1, 2], position: [0, 0], rotation: 0 }, b: { sameAs: "a" }, c: { ...placement, scale: -1 }, d: placement },
    }, (m) => warnings.push(m));
    expect(Object.keys(config!.sessions)).toEqual(["d"]);
    expect(config!.opacity).toBe(1);
    expect(warnings.join("\n")).toMatch(/a : attendu/);
    expect(warnings.join("\n")).toMatch(/c : attendu/);
    expect(warnings.join("\n")).toMatch(/b : « sameAs » vise « a »/);
  });

  it("lit l'atténuation de la vue d'ensemble ; une valeur incohérente garde celle par défaut", () => {
    const base = { svg: "plan/plan.svg", metersPerUnit: 0.1, plan };
    expect(parsePlanConfig({ ...base, fullFade: { inner: 2, outer: 6 } })?.fullFade).toEqual({ inner: 2, outer: 6 });
    const warnings: string[] = [];
    expect(parsePlanConfig({ ...base, fullFade: { inner: 5, outer: 4 } }, (m) => warnings.push(m))?.fullFade).toEqual({ inner: 3, outer: 5 });
    expect(warnings.join("\n")).toMatch(/fullFade/);
  });

  it("sans plan, ni échelle, ni pose du plan : pas de plan", () => {
    expect(parsePlanConfig({ metersPerUnit: 0.1, plan }, () => {})).toBeNull();
    expect(parsePlanConfig({ svg: "p.svg", metersPerUnit: -1, plan }, () => {})).toBeNull();
    expect(parsePlanConfig({ svg: "p.svg", metersPerUnit: 0.1 }, () => {})).toBeNull();
    expect(parsePlanConfig([], () => {})).toBeNull();
  });
});

describe("placementMatrix", () => {
  it("pose le point repère au sol, à sa position, et tourne / agrandit autour de lui", () => {
    const m = placementMatrix({ anchor: [-0.6, -1.4, -4.2], position: [3, 5], rotation: 90, scale: 2 }, -1.45);
    expect(new THREE.Vector3(-0.6, -1.4, -4.2).applyMatrix4(m).toArray().map((v) => +v.toFixed(6))).toEqual([3, -1.45, 5]);
    // 1 m vers +x depuis le repère -> 2 m, tourné de 90° (sens trigonométrique vu de dessus : +x -> -z)
    const p = new THREE.Vector3(0.4, -1.4, -4.2).applyMatrix4(m);
    expect(p.x).toBeCloseTo(3);
    expect(p.y).toBeCloseTo(-1.45);
    expect(p.z).toBeCloseTo(3);
  });
});
