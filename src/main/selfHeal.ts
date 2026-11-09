import { logError, logInfo } from "./logger";

type SpeakFn = (text: string) => Promise<void>;
type AskFn = (text: string) => Promise<string>;
type EmitFn = (ev: { type: "status" | "tool"; status?: string; detail?: string; name?: string }) => void;

let speakFn: SpeakFn | null = null;
let askFn: AskFn | null = null;
let mutedFn: (() => boolean) | null = null;
let emitFn: EmitFn | null = null;

let healing = false;
let lastHealAt = 0;
let autoConfirmRebuild = false;

const COOLDOWN_MS = 90_000;

export function configureSelfHeal(opts: {
  speak: SpeakFn;
  ask: AskFn;
  isMuted: () => boolean;
  emit: EmitFn;
}): void {
  speakFn = opts.speak;
  askFn = opts.ask;
  mutedFn = opts.isMuted;
  emitFn = opts.emit;
}

/** During auto self-heal, rebuild/restart confirms are approved without blocking the HUD. */
export function shouldAutoConfirmRebuild(): boolean {
  return autoConfirmRebuild;
}

export function isSelfHealing(): boolean {
  return healing;
}

/** Short spoken line — no stack traces, no giant paths. */
export function summarizeFault(raw: string): string {
  let t = String(raw || "")
    .replace(/^Systems error:\s*/i, "")
    .replace(/^STT_ERROR:\s*/i, "")
    .replace(/^Error invoking remote method[^:]*:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/ES Module|dynamic import|@xenova\/transformers/i.test(t)) {
    return "сбой загрузки голосовой модели Whisper";
  }
  if (/sharp/i.test(t) && /install|module/i.test(t)) {
    return "сбой модуля sharp для распознавания";
  }
  if (/transcribe|whisper|stt/i.test(t)) {
    return "ошибка распознавания речи";
  }
  if (/timeout|brain timeout/i.test(t)) {
    return "мозг не ответил вовремя";
  }
  if (/CURSOR_API_KEY|auth|login|unauthorized/i.test(t)) {
    return "нужна авторизация Cursor";
  }
  if (/ECONN|network|ENOTFOUND|fetch failed/i.test(t)) {
    return "сетевой сбой";
  }
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(t)) {
    return "не хватает модуля в коде";
  }

  // Drop file paths for speech
  t = t.replace(/[A-Za-z]:\\[^\s]+/g, "…").replace(/\s+/g, " ").trim();
  if (t.length > 140) t = t.slice(0, 137) + "…";
  return t || "неизвестная ошибка";
}

function isBenign(raw: string): boolean {
  const t = raw.toLowerCase();
  if (!t.trim()) return true;
  if (/тишина|silence|empty|не разобрал речь|cancelled|отмен/i.test(t)) return true;
  if (/still processing|previous request|занят/i.test(t)) return true;
  if (/нет доступа к микрофону|notallowederror|permission/i.test(t)) return true;
  if (/hud ready|первый запуск голоса|качаю whisper/i.test(t)) return true;
  return false;
}

/**
 * Speak a brief fault and autonomously start fixing Stark OS / JARVIS code.
 * Cooldown + single-flight to avoid repair loops.
 */
export async function reportJarvisFault(opts: {
  source: string;
  error: string;
  /** If false, only speak — no auto code repair (default true). */
  autoFix?: boolean;
}): Promise<void> {
  const raw = String(opts.error || "").trim();
  if (!raw || isBenign(raw)) return;
  if (healing) {
    logInfo("selfHeal", `skip nested fault from ${opts.source}`);
    return;
  }

  const brief = summarizeFault(raw);
  emitFn?.({ type: "status", status: "error", detail: brief });
  emitFn?.({ type: "tool", name: `Сбой: ${brief}`, status: "running" });

  if (!(mutedFn?.() ?? true) && speakFn) {
    void speakFn(`Сбой: ${brief}. Исправляю себя.`).catch(() => undefined);
  }

  const autoFix = opts.autoFix !== false;
  if (!autoFix || !askFn) return;
  if (Date.now() - lastHealAt < COOLDOWN_MS) {
    logInfo("selfHeal", "cooldown — skip auto fix");
    if (!(mutedFn?.() ?? true) && speakFn) {
      void speakFn("Недавно уже чинился — минуту подожди.").catch(() => undefined);
    }
    return;
  }

  healing = true;
  autoConfirmRebuild = true;
  lastHealAt = Date.now();
  emitFn?.({ type: "status", status: "thinking", detail: "Чиню себя…" });
  emitFn?.({ type: "tool", name: "Самолечение: правлю код…", status: "running" });

  const mission = [
    "SELF-HEAL MISSION (autonomous — user did not ask; a fault was detected).",
    `Source: ${opts.source}`,
    `Brief: ${brief}`,
    `Raw error: ${raw.slice(0, 1200)}`,
    "",
    "You MUST fix this yourself inside D:\\Projects\\CursorProjects\\stark-os:",
    "1) Locate the failing code (src/main, src/renderer, config, voice/stt, etc.).",
    "2) Apply a minimal correct patch (follow existing patterns).",
    "3) Call rebuild_jarvis with restart=true so changes load (auto-confirmed during heal).",
    "4) Reply in Russian, 1–2 short natural sentences: what broke and what you fixed. No filler.",
    "Do not ask the user what to do. Do not disable safety gates for Defender/UAC.",
  ].join("\n");

  try {
    logInfo("selfHeal", `start from ${opts.source}: ${brief}`);
    const answer = await askFn(mission);
    logInfo("selfHeal", `done: ${(answer || "").slice(0, 160)}`);
    if (!(mutedFn?.() ?? true) && speakFn && answer && !answer.startsWith("Systems error:")) {
      void speakFn(answer).catch(() => undefined);
    } else if (answer?.startsWith("Systems error:") && speakFn && !(mutedFn?.() ?? true)) {
      void speakFn(`Не смог починить сразу: ${summarizeFault(answer)}.`).catch(() => undefined);
    }
  } catch (e) {
    logError("selfHeal", e);
    if (!(mutedFn?.() ?? true) && speakFn) {
      void speakFn(`Самолечение не удалось: ${summarizeFault(String(e))}.`).catch(() => undefined);
    }
  } finally {
    healing = false;
    autoConfirmRebuild = false;
    emitFn?.({ type: "status", status: "idle", detail: "JARVIS online" });
  }
}
