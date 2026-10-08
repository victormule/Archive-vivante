// Compresse un Gaussian splat (PLY 3DGS) au format SPZ, lu nativement par Spark.
// Utilise l'encodeur de Spark (dépendance du viewer : web/node_modules).
//
//   node pipeline/scripts/transcode_spz.mjs <entrée.ply> <sortie.spz> [--max-sh 3]
//
// Gain typique : ×15 (32 Mo -> 2 Mo) pour une perte visuelle négligeable
// (positions au 1/4096 m, rotations et harmoniques quantifiées).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "max-sh": { type: "string", default: "3" } },
});
const [input, output] = positionals;
if (!input || !output) {
  console.error("usage : transcode_spz.mjs <entrée.ply> <sortie.spz> [--max-sh 3]");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sparkUrl = pathToFileURL(resolve(root, "web/node_modules/@sparkjsdev/spark/dist/spark.module.js"));
const { transcodeSpz } = await import(sparkUrl.href);

const fileBytes = new Uint8Array(readFileSync(input));
const { fileBytes: spz } = await transcodeSpz({
  inputs: [{ fileBytes, pathOrUrl: input }],
  maxSh: Number(values["max-sh"]),
});
writeFileSync(output, spz);
console.log(JSON.stringify({ input: fileBytes.length, output: spz.length }));
