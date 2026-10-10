import { describe, expect, it } from "vitest";
import type { Annotation, AnnotationImage } from "@/data/types";
import { annotationMedia } from "./annotationMedia";

const image = (name: string): AnnotationImage => ({ url: `annotations/${name}.jpg`, width: 4, height: 3, source: `${name}.jpeg` });
const base: Annotation = {
  id: "a", title: "t", text: "", kind: "point", points: [[0, 0, 0]], closed: false, updatedAt: null, images: [],
};

describe("annotationMedia", () => {
  it("ne renvoie rien sans média, y compris pour d'anciens manifests sans vidéos ni documents", () => {
    expect(annotationMedia(base)).toEqual([]);
  });

  it("ajoute les audios après les documents, sans vignette", () => {
    const entries = annotationMedia({
      ...base,
      images: [image("a-1")],
      audios: [
        { url: "annotations/a-a1.m4a", duration: 40.7, source: "voix1.m4a" },
        { url: "annotations/a-a2.m4a", duration: 113.2, label: "Seconde prise", source: "voix2.m4a" },
      ],
    });
    expect(entries.map((e) => e.item.kind)).toEqual(["image", "audio", "audio"]);
    expect(entries[2]).toEqual({ item: { kind: "audio", url: "annotations/a-a2.m4a", source: "voix2.m4a", duration: 113.2, label: "Seconde prise" }, thumbnail: null });
  });

  it("range les médias : images, vidéos, puis PDF", () => {
    const entries = annotationMedia({
      ...base,
      images: [image("a-1"), image("a-2")],
      videos: [{ url: "annotations/a-v1.mp4", width: 16, height: 9, poster: image("a-v1"), source: "essai.mp4" }],
      documents: [{ url: "annotations/a-d1.pdf", pages: 5, thumbnail: image("a-d1"), source: "carnet.pdf" }],
    });
    expect(entries.map((e) => e.item.kind)).toEqual(["image", "image", "video", "pdf"]);
    expect(entries[2].item).toEqual({ kind: "video", url: "annotations/a-v1.mp4", poster: "annotations/a-v1.jpg", source: "essai.mp4" });
    expect(entries[3].item).toMatchObject({ kind: "pdf", pages: 5 });
    expect(entries[3].thumbnail?.url).toBe("annotations/a-d1.jpg");
  });
});
