import type { Annotation, AnnotationImage, MediaItem } from "@/data/types";

/** Un média d'annotation : ce que montre la visionneuse, et sa vignette dans l'étiquette. */
export interface AnnotationMediaEntry {
  item: MediaItem;
  thumbnail: AnnotationImage;
}

/** Médias d'une annotation, dans l'ordre : images, vidéos, documents PDF. */
export function annotationMedia(annotation: Annotation): AnnotationMediaEntry[] {
  return [
    ...annotation.images.map((image): AnnotationMediaEntry => ({
      item: { kind: "image", url: image.url, source: image.source },
      thumbnail: image,
    })),
    ...(annotation.videos ?? []).map((video): AnnotationMediaEntry => ({
      item: { kind: "video", url: video.url, poster: video.poster.url, source: video.source },
      thumbnail: video.poster,
    })),
    ...(annotation.documents ?? []).map((document): AnnotationMediaEntry => ({
      item: { kind: "pdf", url: document.url, source: document.source, pages: document.pages },
      thumbnail: document.thumbnail,
    })),
  ];
}
