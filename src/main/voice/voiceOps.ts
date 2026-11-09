import fs from "fs";
import path from "path";
import { projectRoot } from "../tools/allowlist";
import { sttLoadState } from "./stt";

type VoiceJson = {
  provider?: string;
  stt?: { model?: string };
};

function readVoiceJson(): VoiceJson {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectRoot(), "config", "voice.json"), "utf8")
    ) as VoiceJson;
  } catch {
    return {};
  }
}

function piperPaths(): { exe: string; modelEn: string; modelRu: string } {
  const root = projectRoot();
  const dir = path.join(root, "data", "voice", "piper");
  return {
    exe: path.join(dir, "piper", "piper.exe"),
    modelEn: path.join(dir, "en_GB-northern_english_male-medium.onnx"),
    modelRu: path.join(dir, "ru_RU-ruslan-medium.onnx"),
  };
}

export function piperAssetState(): { ready: boolean; exe: boolean; models: number } {
  const p = piperPaths();
  const exe = fs.existsSync(p.exe);
  let models = 0;
  if (fs.existsSync(p.modelEn)) models += 1;
  if (fs.existsSync(p.modelRu)) models += 1;
  return { ready: exe && models > 0, exe, models };
}

export function voiceProviderSummary(): { provider: string; detail: string; sttModel: string } {
  const cfg = readVoiceJson();
  const provider = String(cfg.provider || "edge");
  const sttModel = String(cfg.stt?.model || "Xenova/whisper-base");
  const piper = piperAssetState();
  const stt = sttLoadState();

  let detail = provider;
  if (provider === "piper" && !piper.ready) {
    detail = "piper (модели не готовы)";
  } else if (provider === "edge") {
    detail = "Edge neural";
  } else if (provider === "elevenlabs") {
    detail = "ElevenLabs";
  } else if (provider === "piper" && piper.ready) {
    detail = "Piper офлайн";
  }

  if (stt === "loading") detail += " · STT грузится";
  return { provider, detail, sttModel };
}
