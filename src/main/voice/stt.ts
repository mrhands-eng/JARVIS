import fs from "fs";
import path from "path";
import { logError, logInfo } from "../logger";
import { projectRoot } from "../tools/allowlist";

type AsrPipeline = (
  audio: Float32Array | { raw: Float32Array; sampling_rate: number },
  options?: Record<string, unknown>
) => Promise<{ text?: string } | { text?: string }[]>;

export type SttResult = {
  text: string;
  peak: number;
  rms: number;
  mean: number;
  durationSec: number;
  sampleRate: number;
  language: string;
  model: string;
};

let transcriberPromise: Promise<AsrPipeline> | null = null;
let ready = false;
let loadedModel = "";
/** Serialize Whisper calls — concurrent live+final ticks corrupt / race the first load. */
let sttChain: Promise<unknown> = Promise.resolve();

function withSttLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sttChain.then(fn, fn);
  sttChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

type SttConfig = {
  model: string;
  language: string;
  task: "transcribe" | "translate";
};

function sttConfig(): SttConfig {
  const fallback: SttConfig = {
    model: "Xenova/whisper-base",
    language: "russian",
    task: "transcribe",
  };
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(projectRoot(), "config", "voice.json"), "utf8")
    ) as { stt?: Partial<SttConfig> };
    return {
      model: String(raw.stt?.model || fallback.model),
      language: String(raw.stt?.language || fallback.language),
      task: raw.stt?.task === "translate" ? "translate" : "transcribe",
    };
  } catch {
    return fallback;
  }
}

function modelsDir(): string {
  const dir = path.join(projectRoot(), "data", "models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function debugDir(): string {
  const dir = path.join(projectRoot(), "data", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseWavPcm16Mono(wav: Buffer): { samples: Float32Array; sampleRate: number } {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Invalid WAV");
  }
  let offset = 12;
  let sampleRate = 16000;
  let dataOffset = -1;
  let dataSize = 0;
  let bitsPerSample = 16;
  let channels = 1;

  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const next = offset + 8 + size;
    if (id === "fmt ") {
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
      bitsPerSample = wav.readUInt16LE(offset + 22);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset = next + (size % 2); // word align
  }

  if (dataOffset < 0) throw new Error("WAV has no data chunk");
  if (bitsPerSample !== 16) throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);

  const frameCount = Math.floor(dataSize / (2 * channels));
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      acc += wav.readInt16LE(dataOffset + (i * channels + c) * 2);
    }
    samples[i] = acc / channels / 32768;
  }
  return { samples, sampleRate };
}

function resampleTo16k(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000) return samples;
  const ratio = fromRate / 16000;
  const outLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = (samples[i0] || 0) * (1 - frac) + (samples[i1] || 0) * frac;
  }
  return out;
}

function audioStats(samples: Float32Array): { peak: number; rms: number; mean: number } {
  let peak = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] || 0;
    peak = Math.max(peak, Math.abs(v));
    sum += v;
    sumSq += v * v;
  }
  const n = Math.max(1, samples.length);
  return { peak, rms: Math.sqrt(sumSq / n), mean: sum / n };
}

/** Remove DC and soft-normalize so clipped/AGC mic feeds don't blank Whisper. */
function prepareForWhisper(samples: Float32Array): Float32Array {
  const { mean, peak } = audioStats(samples);
  const out = new Float32Array(samples.length);
  const targetPeak = 0.85;
  const scale = peak > 1e-6 ? Math.min(1, targetPeak / peak) : 1;
  for (let i = 0; i < samples.length; i++) {
    out[i] = ((samples[i] || 0) - mean) * scale;
  }
  return out;
}

function saveDebugWav(wav: Buffer, tag: string): void {
  try {
    const dest = path.join(debugDir(), `stt-last-${tag}.wav`);
    fs.writeFileSync(dest, wav);
    logInfo("stt", `saved ${dest} (${wav.length} bytes)`);
  } catch (e) {
    logError("stt.saveWav", e);
  }
}

/** Real ESM import — tsc CJS rewrites `import()` into `require()`, which breaks @xenova/transformers. */
function importEsm<T = unknown>(specifier: string): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("s", "return import(s)")(specifier) as Promise<T>;
}

async function getTranscriber(): Promise<AsrPipeline> {
  if (!transcriberPromise) {
    const cfg = sttConfig();
    transcriberPromise = (async () => {
      const mod = await importEsm<{
        pipeline: (
          task: string,
          model: string,
          options?: Record<string, unknown>
        ) => Promise<AsrPipeline>;
        env: { cacheDir: string; allowLocalModels: boolean };
      }>("@xenova/transformers");
      mod.env.cacheDir = modelsDir();
      mod.env.allowLocalModels = true;
      logInfo("stt", `loading ${cfg.model} (lang=${cfg.language})…`);
      const pipe = (await mod.pipeline("automatic-speech-recognition", cfg.model, {
        quantized: true,
      })) as unknown as AsrPipeline;
      ready = true;
      loadedModel = cfg.model;
      logInfo("stt", `Whisper ready (${cfg.model})`);
      return pipe;
    })().catch((err) => {
      transcriberPromise = null;
      ready = false;
      loadedModel = "";
      throw err;
    });
  }
  return transcriberPromise;
}

/** Warm model in background after HUD starts. */
export function warmStt(): void {
  void getTranscriber().catch((e) => logError("stt.warm", e));
}

export function isSttReady(): boolean {
  return ready;
}

function emptyResult(
  partial: Partial<SttResult> & Pick<SttResult, "peak" | "rms" | "mean" | "durationSec" | "sampleRate">
): SttResult {
  const cfg = sttConfig();
  return {
    text: "",
    language: cfg.language,
    model: loadedModel || cfg.model,
    ...partial,
  };
}

/**
 * Local STT: Whisper (Xenova) — no Google, works offline after first model download.
 * IMPORTANT: pass a bare Float32Array @16kHz — `{ raw, sampling_rate }` is rejected by WhisperFeatureExtractor.
 */
export async function transcribeWavBuffer(wav: Buffer): Promise<SttResult> {
  return withSttLock(() => transcribeWavBufferUnlocked(wav));
}

async function transcribeWavBufferUnlocked(wav: Buffer): Promise<SttResult> {
  const cfg = sttConfig();
  try {
    const { samples, sampleRate } = parseWavPcm16Mono(wav);
    const resampled = resampleTo16k(samples, sampleRate);
    const statsBefore = audioStats(resampled);
    const durationSec = resampled.length / 16000;

    logInfo(
      "stt",
      `in wav=${wav.length}B sr=${sampleRate} →16k frames=${resampled.length} ` +
        `dur=${durationSec.toFixed(2)}s peak=${statsBefore.peak.toFixed(4)} ` +
        `rms=${statsBefore.rms.toFixed(4)} mean=${statsBefore.mean.toFixed(4)}`
    );

    if (resampled.length < 1600) {
      logInfo("stt", "reject: too short (<0.1s)");
      return emptyResult({
        peak: statsBefore.peak,
        rms: statsBefore.rms,
        mean: statsBefore.mean,
        durationSec,
        sampleRate,
      });
    }

    const audio = prepareForWhisper(resampled);
    const stats = audioStats(audio);
    const pipe = await getTranscriber();
    // Bare Float32Array only — object form crashes / yields empty with Xenova Whisper
    const result = await pipe(audio, {
      language: cfg.language,
      task: cfg.task,
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    });

    const rawText = Array.isArray(result)
      ? result.map((r) => r.text || "").join(" ").trim()
      : String(result?.text || "").trim();

    const cleaned = rawText
      .replace(/^\[.*?\]\s*/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) {
      if (durationSec >= 1.2) saveDebugWav(wav, "empty");
      logInfo(
        "stt",
        `empty raw=${JSON.stringify(rawText)} peak=${stats.peak.toFixed(4)} ` +
          `rms=${stats.rms.toFixed(4)} lang=${cfg.language} model=${loadedModel || cfg.model}`
      );
    } else {
      logInfo(
        "stt",
        `ok «${cleaned.slice(0, 120)}» (${cleaned.length} chars, peak=${stats.peak.toFixed(4)}, ` +
          `rms=${stats.rms.toFixed(4)}, ${durationSec.toFixed(2)}s)`
      );
    }

    return {
      text: cleaned,
      peak: stats.peak,
      rms: stats.rms,
      mean: stats.mean,
      durationSec,
      sampleRate,
      language: cfg.language,
      model: loadedModel || cfg.model,
    };
  } catch (e) {
    logError("stt.whisper", e);
    try {
      saveDebugWav(wav, "error");
    } catch {
      /* ignore */
    }
    const msg = (e as Error).message || String(e);
    throw new Error(
      `Локальный Whisper не распознал речь: ${msg}. ` +
        `Модель: ${cfg.model}. Первый запуск качает веса в data/models, дальше офлайн.`
    );
  }
}
