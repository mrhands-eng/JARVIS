import { ChildProcess, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { logError, logInfo } from "../logger";
import { projectRoot } from "../tools/allowlist";

type VoiceConfig = {
  provider: "edge" | "elevenlabs";
  edge: {
    voiceEn: string;
    voiceRu: string;
    lockVoice?: string;
    rate: string;
    pitch: string;
    volume: string;
  };
  elevenlabs: {
    voiceId: string;
    modelId: string;
  };
  maxChars: number;
  chunkSize?: number;
};

type PlayFn = (payload: { mime: string; base64: string; queue?: boolean; seq?: number }) => void;
type StopFn = (seq: number) => void;

let playFn: PlayFn | null = null;
let stopFn: StopFn | null = null;
let speakSeq = 0;
let psChild: ChildProcess | null = null;

export function currentSpeakSeq(): number {
  return speakSeq;
}

function killPsChild(): void {
  if (!psChild) return;
  try {
    psChild.kill();
  } catch {
    /* ignore */
  }
  psChild = null;
}

export function setAudioHandlers(play: PlayFn, stop: StopFn): void {
  playFn = play;
  stopFn = stop;
}

/** Interrupt any in-flight or queued TTS immediately. */
export function stopSpeaking(): void {
  speakSeq += 1;
  killPsChild();
  stopFn?.(speakSeq);
}

function loadConfig(): VoiceConfig {
  const file = path.join(projectRoot(), "config", "voice.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as VoiceConfig;
}

/** Keep one timbre: normalize mixed RU/EN so Edge doesn't "switch character". */
function prepareForSpeech(text: string, maxChars: number): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/[`*_#>]+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\bsir\b/gi, "сэр")
    .replace(/\bSteam\b/g, "Стим")
    .replace(/\bDeadlock\b/gi, "Дедлок")
    .replace(/\bCyberpunk\b/gi, "Киберпанк")
    .replace(/\bThe Witcher\b/gi, "Ведьмак")
    .replace(/\bNo Man'?s Sky\b/gi, "No Mans Sky")
    .replace(/\bDota\b/gi, "Дота")
    .replace(/\bCS2\b/g, "Си Эс два")
    .replace(/\btModLoader\b/gi, "ти мод лоадер")
    .replace(/\bEverlasting Summer\b/gi, "Бесконечное лето")
    .replace(/\bThe Outlast Trials\b/gi, "Аутласт Трайалс")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function pickVoice(cfg: VoiceConfig, text: string): string {
  if (cfg.edge.lockVoice) return cfg.edge.lockVoice;
  const letters = text.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, "");
  if (!letters) return cfg.edge.voiceEn;
  const cyr = (letters.match(/[а-яА-ЯёЁ]/g) || []).length;
  return cyr / letters.length >= 0.35 ? cfg.edge.voiceRu : cfg.edge.voiceEn;
}

function splitChunks(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) return [text];
  const parts: string[] = [];
  const sentences = text.split(/(?<=[.!?…])\s+/);
  let buf = "";
  for (const sentence of sentences) {
    if ((buf + " " + sentence).trim().length <= chunkSize) {
      buf = (buf + " " + sentence).trim();
      continue;
    }
    if (buf) parts.push(buf);
    if (sentence.length <= chunkSize) {
      buf = sentence;
    } else {
      for (let i = 0; i < sentence.length; i += chunkSize) {
        parts.push(sentence.slice(i, i + chunkSize));
      }
      buf = "";
    }
  }
  if (buf) parts.push(buf);
  return parts.filter(Boolean);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      // Edge sometimes closes before turn.end after audio already arrived — use what we have
      if (err && buf.length < 256) reject(err);
      else resolve(buf);
    };
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err: Error) => finish(err));
    stream.on("end", () => finish());
  });
}

/**
 * Only `rate` is reliable with current Edge read-aloud SSML.
 * pitch/volume (+0%, -2Hz, …) often make the server drop the stream with 0 audio bytes.
 */
function edgeProsody(cfg: VoiceConfig): { rate?: string } {
  const rate = String(cfg.edge.rate || "").trim();
  if (rate && rate !== "+0%" && rate !== "0%" && rate !== "default") {
    return { rate };
  }
  return {};
}

async function synthesizeEdgeChunk(text: string, voice: string, cfg: VoiceConfig): Promise<Buffer> {
  let lastError: unknown;
  const prosody = edgeProsody(cfg);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const tts = new MsEdgeTTS({
      enableLogger: false,
      connectionTimeoutMs: 20000,
      synthesisTimeoutMs: 120000,
    });
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } =
        Object.keys(prosody).length > 0 ? tts.toStream(text, prosody) : tts.toStream(text);
      const buf = await streamToBuffer(audioStream as Readable);
      try {
        tts.close();
      } catch {
        /* ignore */
      }
      if (buf.length < 256) throw new Error("TTS returned empty audio");
      return buf;
    } catch (err) {
      lastError = err;
      try {
        tts.close();
      } catch {
        /* ignore */
      }
      logInfo("tts.edge", `attempt ${attempt} failed: ${(err as Error).message || err}`);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function synthesizeElevenLabs(text: string, cfg: VoiceConfig): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || cfg.elevenlabs.voiceId;
  if (!key || !voiceId) throw new Error("ElevenLabs requires ELEVENLABS_API_KEY and voice id");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": key,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: cfg.elevenlabs.modelId || "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.55,
        similarity_boost: 0.75,
        style: 0.2,
        use_speaker_boost: true,
      },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function runPsScript(script: string, mySeq: number): Promise<void> {
  if (mySeq !== speakSeq) return;
  killPsChild();
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
  });
  psChild = child;
  await new Promise<void>((resolve) => {
    const done = () => {
      if (psChild === child) psChild = null;
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
}

/** Offline fallback — Windows SAPI (robotic, but never silent). */
async function speakViaWindowsSapi(text: string, mySeq: number): Promise<void> {
  if (mySeq !== speakSeq) return;
  const safe = text.replace(/'/g, "''").slice(0, 800);
  const script = `
Add-Type -AssemblyName System.Speech
\$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  \$ru = \$s.GetInstalledVoices() | Where-Object { \$_.VoiceInfo.Culture.Name -like 'ru*' } | Select-Object -First 1
  if (\$ru) { \$s.SelectVoice(\$ru.VoiceInfo.Name) }
} catch {}
\$s.Rate = -1
\$s.Volume = 100
\$s.Speak([string]'${safe}')
\$s.Dispose()
`;
  await runPsScript(script, mySeq);
}

async function playMp3(audio: Buffer, queue: boolean, mySeq: number): Promise<void> {
  if (mySeq !== speakSeq) return;
  if (!playFn) {
    await playViaWindows(audio, mySeq);
    return;
  }
  playFn({ mime: "audio/mpeg", base64: audio.toString("base64"), queue, seq: mySeq });
}

/** Neural JARVIS TTS — one locked voice for the whole reply (no mid-message timbre swap). */
export async function speak(text: string): Promise<void> {
  const cfg = loadConfig();
  const cleaned = prepareForSpeech(text, cfg.maxChars || 1600);
  if (!cleaned) return;

  const mySeq = ++speakSeq;
  killPsChild();
  stopFn?.(speakSeq);

  const preferEleven =
    (cfg.provider === "elevenlabs" || !!process.env.ELEVENLABS_API_KEY) &&
    !!(process.env.ELEVENLABS_VOICE_ID || cfg.elevenlabs.voiceId) &&
    !!process.env.ELEVENLABS_API_KEY;

  const voice = pickVoice(cfg, cleaned);
  const chunks = splitChunks(cleaned, cfg.chunkSize || 320);

  try {
    let first = true;
    let played = false;
    for (const chunk of chunks) {
      if (mySeq !== speakSeq) return;
      let audio: Buffer;
      if (preferEleven) {
        try {
          audio = await synthesizeElevenLabs(chunk, cfg);
        } catch {
          audio = await synthesizeEdgeChunk(chunk, voice, cfg);
        }
      } else {
        audio = await synthesizeEdgeChunk(chunk, voice, cfg);
      }
      if (mySeq !== speakSeq) return;
      await playMp3(audio, !first, mySeq);
      if (mySeq !== speakSeq) return;
      first = false;
      played = true;
    }
    if (played) logInfo("tts", `ok voice=${voice} chunks=${chunks.length}`);
  } catch (err) {
    if (mySeq !== speakSeq) return;
    logError("tts.synthesize", err);
    // Last resort: local Windows voice so greetings are never silent
    try {
      logInfo("tts", "falling back to Windows SAPI");
      await speakViaWindowsSapi(cleaned, mySeq);
    } catch (e2) {
      logError("tts.sapi", e2);
    }
  }
}

async function playViaWindows(mp3: Buffer, mySeq: number): Promise<void> {
  if (mySeq !== speakSeq) return;
  const file = path.join(os.tmpdir(), `stark-tts-${Date.now()}.mp3`);
  fs.writeFileSync(file, mp3);
  const uri = "file:///" + file.replace(/\\/g, "/");
  const script = `
Add-Type -AssemblyName PresentationCore
$m = New-Object System.Windows.Media.MediaPlayer
$m.Open([Uri]'${uri.replace(/'/g, "''")}')
$m.Volume = 1
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not $m.NaturalDuration.HasTimeSpan) {
  Start-Sleep -Milliseconds 50
  if ($sw.Elapsed.TotalSeconds -gt 8) { break }
}
$m.Play()
if ($m.NaturalDuration.HasTimeSpan) {
  Start-Sleep -Milliseconds ([int]$m.NaturalDuration.TimeSpan.TotalMilliseconds + 200)
}
$m.Close()
Remove-Item -LiteralPath '${file.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue
`;
  await runPsScript(script, mySeq);
}
