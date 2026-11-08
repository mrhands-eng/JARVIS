import { ChildProcess, fork } from "child_process";
import path from "path";
import { getBrainMode } from "./brainMode";
import { noteActivity } from "./idle";
import { askLocalJarvis } from "./local/askLocal";
import { loadLocalConfig } from "./local/config";
import { ensureOllamaRunning, isInternetUp, isOllamaReachable } from "./local/ollama";
import { logError, logInfo } from "./logger";
import { beginTask, isCancelError, requestCancel } from "./taskControl";

export type BrainEvent =
  | { type: "status"; status: "idle" | "thinking" | "error"; detail?: string }
  | { type: "delta"; text: string }
  | { type: "final"; text: string }
  | { type: "tool"; name: string; status: string };

type Listener = (ev: BrainEvent) => void;
type ConfirmHandler = (message: string) => Promise<boolean>;
type RestartHandler = () => void;

let worker: ChildProcess | null = null;
let seq = 0;
const pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
const listeners = new Set<Listener>();
let confirmHandler: ConfirmHandler = async () => false;
let restartHandler: RestartHandler | null = null;
let forceLocalUntil = 0;

export function onBrainEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setBrainConfirmHandler(fn: ConfirmHandler): void {
  confirmHandler = fn;
}

export function setBrainRestartHandler(fn: RestartHandler): void {
  restartHandler = fn;
}

function emit(ev: BrainEvent): void {
  for (const listener of listeners) {
    try {
      listener(ev);
    } catch (err) {
      logError("brain-bridge.emit", err);
    }
  }
}

function workerPath(): string {
  return path.join(__dirname, "brain-worker.js");
}

function ensureWorker(): ChildProcess {
  if (worker && !worker.killed) return worker;

  // Run SDK in plain Node — Electron main triggers a Cursor SDK TDZ crash.
  worker = fork(workerPath(), [], {
    execPath: process.env.STARK_NODE || "node",
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });

  worker.stderr?.on("data", (buf) => {
    logInfo("brain-worker.stderr", String(buf).trim());
  });

  worker.on("message", (msg: {
    type: string;
    id?: string;
    text?: string;
    message?: string;
    event?: BrainEvent;
    ok?: boolean;
  }) => {
    if (msg.type === "event" && msg.event) {
      emit(msg.event);
      return;
    }
    if (msg.type === "confirm" && msg.id && msg.message) {
      void confirmHandler(msg.message).then((ok) => {
        worker?.send({ type: "confirm-result", id: msg.id, ok });
      });
      return;
    }
    if (msg.type === "restart-self") {
      try {
        restartHandler?.();
      } catch (err) {
        logError("brain-bridge.restart", err);
      }
      return;
    }
    if (!msg.id) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    if (msg.type === "answer" || msg.type === "ok" || msg.type === "pong") {
      pending.delete(msg.id);
      slot.resolve(msg.text ?? "ok");
      return;
    }
    if (msg.type === "error") {
      pending.delete(msg.id);
      slot.reject(new Error(msg.message || "worker error"));
    }
  });

  worker.on("exit", (code) => {
    logInfo("brain-worker", `exit code=${code}`);
    worker = null;
    for (const [id, slot] of pending) {
      pending.delete(id);
      slot.reject(new Error("JARVIS brain worker exited"));
    }
  });

  worker.on("error", (err) => {
    logError("brain-worker", err);
  });

  logInfo("brain-bridge", `forked worker pid=${worker.pid}`);
  return worker;
}

function call(type: string, extra: Record<string, unknown> = {}, timeoutMs = 180000): Promise<string> {
  const id = `m-${++seq}`;
  const child = ensureWorker();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("JARVIS brain timeout"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    child.send({ type, id, ...extra });
  });
}

/** True only for real Cursor/SDK outages — NOT for normal replies that mention the word "Cursor". */
function looksLikeCursorFailure(text: string): boolean {
  const t = String(text || "");
  return (
    /^systems error:/i.test(t) ||
    /\b(unauthorized|forbidden|401|403)\b/i.test(t) ||
    /login required|api[_ ]?key (missing|invalid|required)|not logged in/i.test(t) ||
    /\b(econnrefused|econnreset|etimedout|fetch failed|network error)\b/i.test(t) ||
    /agent (run )?failed|brain worker exited|JARVIS brain timeout/i.test(t) ||
    /cursor (sdk|api|auth) (error|failed|unavailable)/i.test(t)
  );
}

async function shouldPreferLocal(): Promise<{ local: boolean; reason: string }> {
  const cfg = loadLocalConfig();
  if (!cfg.enabled) return { local: false, reason: "disabled" };
  if (process.env.STARK_FORCE_LOCAL === "1") return { local: true, reason: "STARK_FORCE_LOCAL" };

  // Manual HUD toggle
  if (getBrainMode() === "local") return { local: true, reason: "manual-local" };

  if (Date.now() < forceLocalUntil) {
    if (await isOllamaReachable()) return { local: true, reason: "cursor-unavailable" };
    return { local: false, reason: "cursor-retry" };
  }

  // Auto local only when offline (Cursor needs net)
  if (cfg.preferLocalWhenOffline) {
    const online = await isInternetUp();
    if (!online) {
      if (await isOllamaReachable() || (await ensureOllamaRunning())) {
        return { local: true, reason: "offline" };
      }
      return { local: false, reason: "offline-no-local" };
    }
  }
  return { local: false, reason: "cursor" };
}

async function runLocal(userText: string, reason: string): Promise<string> {
  const labels: Record<string, string> = {
    "manual-local": "Режим: локальный ИИ",
    offline: "Нет сети → локальный ИИ",
    "cursor-unavailable": "Cursor недоступен → локальный ИИ",
    "cursor-fail": "Cursor сбой → локальный ИИ",
    "cursor-throw": "Cursor сбой → локальный ИИ",
  };
  const detail = labels[reason] || "Локальный ИИ…";
  emit({ type: "status", status: "thinking", detail });
  emit({ type: "tool", name: detail, status: "running" });
  const ok = await ensureOllamaRunning();
  if (!ok && !(await isOllamaReachable())) {
    throw new Error("Ollama недоступна — установите Ollama и модель из config/local.json");
  }
  return askLocalJarvis(userText, emit);
}

async function tryLocalFirst(
  userText: string,
  reason: string
): Promise<{ ok: true; text: string } | { ok: false }> {
  try {
    const text = await runLocal(userText, reason);
    return { ok: true, text };
  } catch (e) {
    logError("brain-bridge.localRoute", e);
    return { ok: false };
  }
}

export async function ensureBrain(): Promise<void> {
  const prefer = await shouldPreferLocal();
  if (prefer.local) {
    // Don't start Ollama until a real local ask — keeps it out of the process list
    logInfo("brain-bridge", `warm skip Cursor (${prefer.reason}); Ollama on-demand`);
    return;
  }
  try {
    await call("warm", {}, 120000);
  } catch (e) {
    logError("brain-bridge.warm", e);
    forceLocalUntil = Date.now() + 5 * 60_000;
  }
}

export async function askJarvis(userText: string): Promise<string> {
  noteActivity("brain-ask");
  beginTask();
  const cfg = loadLocalConfig();

  // Local when: HUD toggle = local, OR offline, OR Cursor recently failed
  const prefer = await shouldPreferLocal();
  if (prefer.local) {
    logInfo("brain-bridge", `local (${prefer.reason})`);
    const local = await tryLocalFirst(userText, prefer.reason);
    if (local.ok) return local.text;
    // Manual local failed — only escalate to Cursor if not forced offline-only
    if (prefer.reason === "manual-local") {
      logInfo("brain-bridge", "manual local failed — trying Cursor");
    } else {
      return `Systems error: локальный ИИ недоступен (${prefer.reason})`;
    }
  }

  try {
    emit({ type: "status", status: "thinking", detail: "Cursor…" });
    const answer = await call("ask", { text: userText }, 180000);
    if (isCancelError(answer) || /^Остановлено/i.test(answer)) return answer;
    if (cfg.preferLocalWhenCursorFails && looksLikeCursorFailure(answer)) {
      logInfo(
        "brain-bridge",
        `Cursor failed — fallback local; answerPreview=${JSON.stringify(answer.slice(0, 160))}`
      );
      forceLocalUntil = Date.now() + 5 * 60_000;
      const local = await tryLocalFirst(userText, "cursor-fail");
      if (local.ok) return local.text;
      return answer;
    }
    return answer;
  } catch (e) {
    if (isCancelError(e)) {
      emit({ type: "status", status: "idle", detail: "stopped" });
      return "Остановлено, сэр.";
    }
    logError("brain-bridge.ask", e);
    forceLocalUntil = Date.now() + 5 * 60_000;
    const local = await tryLocalFirst(userText, "cursor-throw");
    if (local.ok) return local.text;
    return `Systems error: ${(e as Error).message || String(e)}`;
  }
}

/** Hard-stop current Cursor/local turn: cancel flag, abort run, reject pending, kill worker if stuck. */
export async function stopJarvis(): Promise<string> {
  requestCancel();
  noteActivity("stop");
  emit({ type: "status", status: "thinking", detail: "Останавливаю…" });
  emit({ type: "tool", name: "Остановка…", status: "running" });

  for (const [id, slot] of pending) {
    pending.delete(id);
    slot.reject(new Error("CANCELLED_BY_USER"));
  }

  if (worker && !worker.killed) {
    try {
      worker.send({ type: "cancel", id: `stop-${Date.now()}` });
    } catch {
      /* ignore */
    }
    // If worker ignores cancel, force-kill after a short grace
    const child = worker;
    setTimeout(() => {
      if (worker === child && child && !child.killed) {
        logInfo("brain-bridge", "force-killing worker after stop");
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        worker = null;
      }
    }, 2500);
  }

  emit({ type: "status", status: "idle", detail: "stopped" });
  return "Остановлено, сэр.";
}

export async function disposeBrain(): Promise<void> {
  if (!worker) return;
  try {
    await call("dispose", {}, 15000);
  } catch {
    /* ignore */
  }
  try {
    worker.kill();
  } catch {
    /* ignore */
  }
  worker = null;
}
