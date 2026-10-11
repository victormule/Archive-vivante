// QR code du formulaire de contribution, pour l'affiche imprimée (print/).
// Usage : node scripts/qr.mjs  (l'adresse est imprimée : elle ne doit jamais changer)
import { writeFileSync } from "node:fs";
import QRCode from "qrcode";

const URL = "https://impressiondarchive.netlify.app/participer/";
const options = { type: "svg", errorCorrectionLevel: "Q", color: { dark: "#0b0b0cff", light: "#ffffffff" } };

writeFileSync(new globalThis.URL("../../print/participer-qr.svg", import.meta.url), await QRCode.toString(URL, { ...options, margin: 4 }));
console.log("QR :", URL);
