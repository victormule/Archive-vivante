import { describe, expect, it } from "vitest";
import { chooseSide, layoutLabels, stack } from "./labelLayout";

const bounds = { width: 1000, height: 600, left: 70, right: 20, top: 20, bottom: 100, gap: 8 };

describe("labelLayout", () => {
  it("empile sans chevauchement et dans les limites", () => {
    const ys = stack([100, 105, 110, 480], [30, 30, 30, 30], 20, 500, 8);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] + 30 + 8);
    expect(ys[0]).toBeGreaterThanOrEqual(20);
    expect(ys[ys.length - 1] + 30).toBeLessThanOrEqual(500);
  });

  it("conserve la position cible quand il y a de la place", () => {
    expect(stack([100, 300], [30, 30], 20, 500, 8)).toEqual([100, 300]);
  });

  it("répartit à gauche et à droite selon le point d'ancrage", () => {
    const placements = layoutLabels(
      [
        { id: "a", anchorX: 200, anchorY: 200, width: 150, height: 30 },
        { id: "b", anchorX: 800, anchorY: 200, width: 150, height: 30 },
      ],
      bounds,
    );
    const a = placements.find((p) => p.id === "a")!;
    const b = placements.find((p) => p.id === "b")!;
    expect(a.side).toBe("left");
    expect(a.x).toBe(70);
    expect(b.side).toBe("right");
    expect(b.x).toBe(1000 - 20 - 150);
    expect(a.y).toBe(185);
  });

  it("garde le côté précédent près du centre (hystérésis)", () => {
    expect(chooseSide(510, 1000, "left")).toBe("left");
    expect(chooseSide(490, 1000, "right")).toBe("right");
    expect(chooseSide(700, 1000, "left")).toBe("right");
  });
});
