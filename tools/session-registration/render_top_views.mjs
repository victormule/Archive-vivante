// Rend une vue de dessus de la table pour deux sessions, avec la même caméra,
// via le viewer en mode développement (window.__archive).
//
//   node render_top_views.mjs --reference j1-s1 --session j1-s2 --center=-0.62,-0.71,-4.2
//
// Options : --url (défaut http://localhost:5173), --height 11 (m au-dessus de la table),
// --fov 30, --out ./out. Navigateur : variable CHROME_PATH (défaut : Chrome Windows) ;
// rendu : variable ANGLE (défaut d3d11, GPU ; swiftshader pour un rendu logiciel).
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:5173" },
    reference: { type: "string" },
    session: { type: "string" },
    center: { type: "string" },
    height: { type: "string", default: "11" },
    fov: { type: "string", default: "30" },
    out: { type: "string", default: "./out" },
  },
});
if (!o.reference || !o.session || !o.center) throw new Error("--reference, --session et --center sont requis");
const [cx, cy, cz] = o.center.split(",").map(Number);
const view = {
  position: [cx, cy + Number(o.height), cz],
  quaternion: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], // regard vertical, haut de l'image = -Z
  target: [cx, cy, cz],
  fovY: Number(o.fov),
};
mkdirSync(o.out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  // GPU par défaut ; ANGLE=swiftshader pour un rendu logiciel (machine sans GPU, très lent)
  args:
    process.env.ANGLE === "swiftshader"
      ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
      : [`--use-angle=${process.env.ANGLE ?? "d3d11"}`, "--enable-gpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto(`${o.url}/?session=${o.reference}&idle=0`);
await page.waitForSelector(".session.is-ready", { timeout: 600_000 });
await page.keyboard.press("4"); // annotations masquées
await page.addStyleTag({
  content: ".session__topbar,.session__header,.session__footer,.layers,.session__hint,.annotations{display:none!important}",
});

const settled = () =>
  page.waitForFunction(() => !window.__archive.viewer.splatsDirty && !window.__archive.viewer.spark.sorting, null, {
    timeout: 600_000,
    polling: 500,
  });
const shoot = async (file) => {
  await page.evaluate((v) => {
    const a = window.__archive;
    a.setView(v);
    a.current.setPathVisible(false);
    a.viewer.invalidateSplats();
  }, view);
  await page.waitForTimeout(1500);
  await settled();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${o.out}/${file}`, timeout: 300_000 });
};

await shoot("reference.png");
await page.evaluate((id) => window.__archive.showSession(id), o.session);
await shoot("session.png");
await browser.close();
console.log(JSON.stringify({ out: o.out, view }));
