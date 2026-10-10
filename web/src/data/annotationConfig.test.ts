import { describe, expect, it } from "vitest";
import { applyAnnotationConfig, parseAnnotationConfig, resolveConfigUrl, type AnnotationConfig } from "./annotationConfig";
import type { Annotation } from "./types";

const annotation = (title: string, id: string, extra: Partial<Annotation> = {}): Annotation => ({
  id, title, text: "texte d'origine", kind: "point", points: [[1, 2, 3]], closed: false, updatedAt: null,
  colorIndex: 2, images: [{ url: "/sessions/s/annotations/a.jpg", width: 4, height: 3, source: "a.jpeg" }], ...extra,
});
const list = () => [annotation("Doc1", "6C48E8B6-0000"), annotation("Doc2", "103EBF36-0000")];
const config = (sessions: AnnotationConfig["sessions"], palette?: string[]): AnnotationConfig => ({ sessions, palette });

describe("parseAnnotationConfig", () => {
  it("écarte avec un avertissement ce qui est inutilisable, sans jamais lever", () => {
    const warnings: string[] = [];
    const parsed = parseAnnotationConfig({
      palette: ["#fff", 3],
      sessions: {
        $aide: { x: 1 },
        s1: { Doc1: { title: 12, color: "#abc", hidden: "oui", offset: [1, 2], media: ["a.jpg", 7], text: ["a", "b"] }, $note: "x", Doc2: "pas un objet" },
        s2: 5,
      },
    }, (m) => warnings.push(m));
    expect(parsed.palette).toBeUndefined();
    expect(parsed.sessions.s1.Doc1).toEqual({ color: "#abc", media: ["a.jpg"], text: ["a", "b"] });
    expect(parsed.sessions.s1.Doc2).toBeUndefined();
    expect(parsed.sessions.$aide).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/palette.*liste de couleurs/);
    expect(warnings.join("\n")).toMatch(/title.*texte attendu/);
    expect(warnings.join("\n")).toMatch(/hidden/);
    expect(warnings.join("\n")).toMatch(/offset/);
    expect(warnings.join("\n")).toMatch(/media n°2/);
    expect(warnings.join("\n")).toMatch(/s2/);
  });

  it("un fichier qui n'est pas un objet donne une configuration vide", () => {
    expect(parseAnnotationConfig([1, 2], () => {}).sessions).toEqual({});
    expect(parseAnnotationConfig(null, () => {}).sessions).toEqual({});
  });
});

describe("resolveConfigUrl", () => {
  it("résout un nom seul dans media/, un chemin depuis la racine, une URL telle quelle", () => {
    expect(resolveConfigUrl("carnet 1.jpeg")).toBe("/media/carnet%201.jpeg");
    expect(resolveConfigUrl("sessions/j2-s4/annotations/a.jpg", "/archive/")).toBe("/archive/sessions/j2-s4/annotations/a.jpg");
    expect(resolveConfigUrl("https://exemple.org/a.mp4")).toBe("https://exemple.org/a.mp4");
    expect(resolveConfigUrl("/autre/a.pdf")).toBe("/autre/a.pdf");
  });
});

describe("applyAnnotationConfig", () => {
  it("ne change rien sans configuration, et ne modifie jamais les originales", () => {
    const original = list();
    const snapshot = JSON.stringify(original);
    expect(applyAnnotationConfig("s1", original, config({})).map((a) => a.title)).toEqual(["Doc1", "Doc2"]);
    applyAnnotationConfig("s1", original, config({ s1: { Doc1: { title: "Autre", text: "x" } } }));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("remplace titre et texte (paragraphes réunis par une ligne vide), repère aussi par l'identifiant", () => {
    const out = applyAnnotationConfig("s1", list(), config({
      s1: { Doc1: { title: "Carnet", text: ["Premier.", "Second."] }, "103ebf36": { text: "Par l'id" } },
    }));
    expect(out[0]).toMatchObject({ title: "Carnet", text: "Premier.\n\nSecond." });
    expect(out[1]).toMatchObject({ title: "Doc2", text: "Par l'id" });
  });

  it("couleur : CSS imposée, numéro de palette, ou palette personnalisée", () => {
    const palette = ["#111111", "#222222", "#333333"];
    const out = applyAnnotationConfig("s1", list(), config({ s1: { Doc1: { color: "#d99a35" }, Doc2: { color: 1 } } }, palette));
    expect(out[0].color).toBe("#d99a35");
    expect(out[1]).toMatchObject({ colorIndex: 1, color: "#222222" });
    // sans réglage propre, la palette s'applique au numéro d'origine (2)
    expect(applyAnnotationConfig("s1", list(), config({}, palette))[0].color).toBe("#333333");
    // sans palette ni couleur : valeurs par défaut du site
    expect(applyAnnotationConfig("s1", list(), config({}))[0].color).toBeUndefined();
  });

  it("masque une annotation et décale une épingle", () => {
    const out = applyAnnotationConfig("s1", list(), config({ s1: { Doc1: { hidden: true }, Doc2: { offset: [0.1, -0.2, 0.5] } } }));
    expect(out.map((a) => a.title)).toEqual(["Doc2"]);
    expect(out[0].points).toEqual([[1.1, 1.8, 3.5]]);
  });

  it("media : remplace la liste, dans l'ordre, par type d'extension ; [] la vide", () => {
    const warnings: string[] = [];
    const out = applyAnnotationConfig("s1", list(), config({
      s1: {
        Doc1: { media: ["essai.mp4", { file: "dossier/carnet.pdf", pages: 5 }, "photo.jpeg", "note.docx"] },
        Doc2: { media: [] },
      },
    }), "/", (m) => warnings.push(m));
    const media = out[0].media!;
    expect(media.map((m) => m.item.kind)).toEqual(["video", "pdf", "image"]);
    expect(media[0].item).toMatchObject({ url: "/media/essai.mp4", poster: undefined });
    expect(media[0].thumbnail).toBeNull();
    expect(media[1].item).toMatchObject({ url: "/dossier/carnet.pdf", pages: 5 });
    expect(media[2].thumbnail?.url).toBe("/media/photo.jpeg");
    expect(out[1].media).toEqual([]);
    expect(warnings.join("\n")).toMatch(/note\.docx/);
  });

  it("une vidéo ou un PDF avec vignette l'utilise", () => {
    const out = applyAnnotationConfig("s1", list(), config({
      s1: { Doc1: { media: [{ file: "a.mp4", poster: "a.jpg" }, { file: "b.pdf", thumbnail: "b.jpg" }] } },
    }));
    expect(out[0].media![0].thumbnail?.url).toBe("/media/a.jpg");
    expect(out[0].media![1].thumbnail?.url).toBe("/media/b.jpg");
  });

  it("un média déjà publié, repris tel quel, garde ses dimensions et sa vignette", () => {
    const original = annotation("Doc1", "6C48E8B6-0000", {
      images: [{ url: "/sessions/s1/annotations/a.jpg", width: 4, height: 3, source: "a.jpeg" }],
      documents: [{ url: "/sessions/s1/annotations/d.pdf", pages: 5, thumbnail: { url: "/sessions/s1/annotations/d.jpg", width: 6, height: 8, source: "d.pdf" }, source: "d.pdf" }],
    });
    const out = applyAnnotationConfig("s1", [original], config({
      s1: { Doc1: { media: [{ file: "sessions/s1/annotations/d.pdf", pages: 5 }, "sessions/s1/annotations/a.jpg", "nouvelle.png"] } },
    }));
    const media = out[0].media!;
    expect(media[0].thumbnail).toMatchObject({ url: "/sessions/s1/annotations/d.jpg", width: 6, height: 8 });
    expect(media[1].thumbnail).toMatchObject({ width: 4, height: 3 });
    expect(media[2].thumbnail).toMatchObject({ url: "/media/nouvelle.png", width: 0 });
  });

  it("prévient quand une entrée ne correspond à aucune annotation", () => {
    const warnings: string[] = [];
    applyAnnotationConfig("s1", list(), config({ s1: { "Doc9": { title: "?" } } }), "/", (m) => warnings.push(m));
    expect(warnings).toEqual([expect.stringContaining("Doc9")]);
  });
});
