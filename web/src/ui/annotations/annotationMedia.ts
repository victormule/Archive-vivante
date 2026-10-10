import type { Annotation, AnnotationMediaEntry } from "@/data/types";

export type { AnnotationMediaEntry };

/**
 * Médias d'une annotation. Si la configuration en impose la liste, elle est suivie
 * telle quelle ; sinon : images, vidéos, puis documents PDF (sortie du pipeline).
 */
export function annotationMedia(annotation: Annotation): AnnotationMediaEntry[] {
  if (annotation.media) return annotation.media;
  return [
    ...annotation.images.map((image): AnnotationMediaEntry => ({
      item: { kind: "image", url: image.url, source: image.source },
      thumbnail: image,
    })),
    ...(annotation.videos ?? []).map((video): AnnotationMediaEntry => ({
      item: { kind: "video", url: video.url, poster: video.poster?.url, source: video.source },
      thumbnail: video.poster ?? null,
    })),
    ...(annotation.documents ?? []).map((document): AnnotationMediaEntry => ({
      item: { kind: "pdf", url: document.url, source: document.source, pages: document.pages },
      thumbnail: document.thumbnail ?? null,
    })),
    ...(annotation.audios ?? []).map((audio): AnnotationMediaEntry => ({
      item: { kind: "audio", url: audio.url, source: audio.source, duration: audio.duration, label: audio.label },
      thumbnail: null,
    })),
  ];
}
