/**
 * Node's `ws` delivers binary frames as Buffer, but msedge-tts only accepts ArrayBuffer —
 * so Path:audio chunks are dropped and the socket closes with "no turn.end".
 * Also: accept truncated audio when the socket drops after real bytes (VPN / long reads).
 */
const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "..", "node_modules", "msedge-tts", "dist", "MsEdgeTTS.js");
if (!fs.existsSync(target)) {
  console.warn("patch-msedge-tts: msedge-tts not installed, skip");
  process.exit(0);
}

let src = fs.readFileSync(target, "utf8");
let changed = false;

const bad = "m.data instanceof ArrayBuffer";
const good = "(m.data instanceof ArrayBuffer || Buffer.isBuffer(m.data))";
if (src.includes(bad) && !src.includes(good)) {
  src = src.split(bad).join(good);
  changed = true;
}

if (!src.includes("_audioBytes")) {
  const oldPush = "_pushAudioData(data, requestId) {\n        this._streams[requestId]?.audio.push(data);";
  const newPush =
    "_pushAudioData(data, requestId) {\n        const s = this._streams[requestId];\n        if (s) {\n            s._audioBytes = (s._audioBytes || 0) + (data?.length || 0);\n            s.audio.push(data);\n        }";
  if (src.includes(oldPush)) {
    src = src.replace(oldPush, newPush);
    changed = true;
  }

  const truncErr =
    'stream.audio.destroy(new Error("Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated."));';
  const truncOk = `if ((stream._audioBytes || 0) >= 512) {
                        stream.turnEnded = true;
                        stream.audio.push(null);
                    } else {
                        stream.audio.destroy(new Error("Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated."));
                    }`;
  if (src.includes(truncErr) && !src.includes("_audioBytes || 0) >= 512")) {
    src = src.split(truncErr).join(truncOk);
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(target, src);
  console.log("patch-msedge-tts: applied fixes");
} else {
  console.log("patch-msedge-tts: already patched");
}
