/**
 * Node's `ws` delivers binary frames as Buffer, but msedge-tts only accepts ArrayBuffer —
 * so Path:audio chunks are dropped and the socket closes with "no turn.end".
 */
const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "..", "node_modules", "msedge-tts", "dist", "MsEdgeTTS.js");
if (!fs.existsSync(target)) {
  console.warn("patch-msedge-tts: msedge-tts not installed, skip");
  process.exit(0);
}

let src = fs.readFileSync(target, "utf8");
const bad = "m.data instanceof ArrayBuffer";
const good = "(m.data instanceof ArrayBuffer || Buffer.isBuffer(m.data))";
if (src.includes(good)) {
  console.log("patch-msedge-tts: already patched");
  process.exit(0);
}
if (!src.includes(bad)) {
  console.warn("patch-msedge-tts: pattern not found — package may have changed");
  process.exit(0);
}
src = src.split(bad).join(good);
fs.writeFileSync(target, src);
console.log("patch-msedge-tts: applied Buffer.isBuffer fix");
