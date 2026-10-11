import { describe, expect, it } from "vitest";
import { relativeTime } from "@/ui/ContributionFeed";
import { MAX_UPLOAD_BYTES, MAX_VIDEO_SECONDS } from "./config";
import { fitSize, fitVideo, videoBitrate } from "./media";

describe("compression des contributions", () => {
  it("réduit sans jamais agrandir", () => {
    expect(fitSize(4032, 3024, 1920, 1920)).toEqual({ width: 1920, height: 1440 });
    expect(fitSize(800, 600, 1920, 1920)).toEqual({ width: 800, height: 600 });
  });

  it("cadre les vidéos en 720p, paysage comme portrait, dimensions paires", () => {
    expect(fitVideo(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(fitVideo(1080, 1920)).toEqual({ width: 720, height: 1280 });
    expect(fitVideo(641, 361)).toEqual({ width: 642, height: 362 });
  });

  it("garde une vidéo de 30 s sous la limite d'envoi", () => {
    expect((videoBitrate(MAX_VIDEO_SECONDS) * MAX_VIDEO_SECONDS) / 8).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(videoBitrate(1)).toBe(4_000_000);
  });

  it("date les impressions en temps relatif", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(relativeTime("2026-10-11T11:59:30Z", now)).toBe("à l'instant");
    expect(relativeTime("2026-10-11T11:55:00Z", now)).toBe("il y a 5 min");
    expect(relativeTime("2026-10-11T09:00:00Z", now)).toBe("il y a 3 h");
  });
});
