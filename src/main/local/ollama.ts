import { ChildProcess, execFile, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { logError, logInfo } from "../logger";
import { projectRoot } from "../tools/allowlist";
import { loadLocalConfig } from "./config";

const execFileAsync = promisify(execFile);

let serveChild: ChildProcess | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let lastUsedAt = 0;

/** JARVIS-only model store + dedicated port — not the global ~/.ollama library. */
export function jarvisOllamaEnv(): NodeJS.ProcessEnv {
  const cfg = loadLocalConfig();
  const models = path.isAbsolute(cfg.modelsDir)
    ? cfg.modelsDir
    : path.join(projectRoot(), cfg.modelsDir);
  fs.mkdirSync(models, { recursive: true });
  return {
    ...process.env,
    OLLAMA_MODELS: models,
    OLLAMA_HOST: "127.0.0.1:11435",
  };
}

export type OllamaToolCall = {
  function: { name: string; arguments: Record<string, unknown> | string };
};

export type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
};

export type OllamaToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

function ollamaBin(): string | null {
  const candidates = [
    process.env.OLLAMA_PATH,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
    "C:\\Program Files\\Ollama\\ollama.exe",
    "ollama",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === "ollama") return c;
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function jarvisPort(): number {
  try {
    const u = new URL(loadLocalConfig().endpoint);
    return Number(u.port) || 11435;
  } catch {
    return 11435;
  }
}

function scheduleIdleStop(): void {
  const ms = loadLocalConfig().ollamaIdleStopMs ?? 0;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (ms <= 0) return;
  idleTimer = setTimeout(() => {
    void stopJarvisOllama("idle");
  }, ms);
}

function markUsed(): void {
  lastUsedAt = Date.now();
  scheduleIdleStop();
}

export async function isOllamaReachable(): Promise<boolean> {
  const cfg = loadLocalConfig();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${cfg.endpoint}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Start JARVIS Ollama only when needed (on-demand). */
export async function ensureOllamaRunning(): Promise<boolean> {
  if (await isOllamaReachable()) {
    markUsed();
    return true;
  }
  const bin = ollamaBin();
  if (!bin) {
    logError("ollama", "Ollama binary not found");
    return false;
  }
  const env = jarvisOllamaEnv();
  logInfo("ollama", `serve on-demand store=${env.OLLAMA_MODELS} host=${env.OLLAMA_HOST}`);
  try {
    serveChild = spawn(bin, ["serve"], {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
      env,
    });
    serveChild.on("exit", () => {
      serveChild = null;
    });
  } catch (e) {
    logError("ollama.serve", e);
    return false;
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isOllamaReachable()) {
      markUsed();
      return true;
    }
  }
  return false;
}

async function unloadModels(): Promise<void> {
  const cfg = loadLocalConfig();
  try {
    const names = await listLocalModels();
    for (const model of names.slice(0, 4)) {
      await fetch(`${cfg.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0, prompt: "" }),
      }).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}

async function killPidListeningOnPort(port: number): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($c) { Stop-Process -Id $c -Force -ErrorAction SilentlyContinue; \"killed $c\" } else { \"none\" }`,
      ],
      { windowsHide: true, timeout: 10000 }
    );
    logInfo("ollama.stop", String(stdout).trim());
  } catch (e) {
    logError("ollama.killPort", e);
  }
}

/** Stop only the JARVIS Ollama instance (11435), not necessarily the tray app. */
export async function stopJarvisOllama(reason = "manual"): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  logInfo("ollama", `stopping JARVIS serve (${reason})`);
  if (await isOllamaReachable()) {
    await unloadModels();
  }
  if (serveChild && !serveChild.killed) {
    try {
      serveChild.kill();
    } catch {
      /* ignore */
    }
    serveChild = null;
  }
  await killPidListeningOnPort(jarvisPort());
}

export async function listLocalModels(): Promise<string[]> {
  const cfg = loadLocalConfig();
  const res = await fetch(`${cfg.endpoint}/api/tags`);
  if (!res.ok) return [];
  const data = (await res.json()) as { models?: Array<{ name: string }> };
  return (data.models || []).map((m) => m.name);
}

export async function ensureModel(model: string): Promise<string> {
  const cfg = loadLocalConfig();
  await ensureOllamaRunning();
  const have = await listLocalModels();
  const match = have.find((n) => n === model || n.startsWith(model + ":") || n.startsWith(model));
  if (match) return match.includes(":") ? match : model;

  logInfo("ollama", `pulling ${model}…`);
  const bin = ollamaBin();
  if (!bin) throw new Error("Ollama not installed");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["pull", model], {
      windowsHide: true,
      env: jarvisOllamaEnv(),
    });
    let err = "";
    child.stderr?.on("data", (b) => {
      err += String(b);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ollama pull failed (${code}): ${err.slice(-400)}`));
    });
  });
  markUsed();
  return model;
}

export async function pickAvailableModel(): Promise<string> {
  const cfg = loadLocalConfig();
  await ensureOllamaRunning();
  const have = await listLocalModels();
  const prefer = [cfg.model, cfg.fallbackModel, "qwen2.5:7b", "qwen2.5:14b", "llama3.1:8b"];
  for (const m of prefer) {
    if (have.some((n) => n === m || n.startsWith(m))) return m;
  }
  try {
    return await ensureModel(cfg.model);
  } catch (e) {
    logError("ollama.pull.primary", e);
    return ensureModel(cfg.fallbackModel);
  }
}

export async function ollamaChat(opts: {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaToolDef[];
  timeoutMs?: number;
}): Promise<OllamaMessage> {
  const cfg = loadLocalConfig();
  markUsed();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools,
        stream: false,
        options: {
          temperature: 0.4,
          num_ctx: 8192,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama chat ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { message?: OllamaMessage };
    if (!data.message) throw new Error("Ollama returned empty message");
    markUsed();
    return data.message;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Soft connectivity probe. Prefer Cursor when unsure — flaky IPv6/CDN
 * must not force local mode and break the primary brain.
 */
export async function isInternetUp(): Promise<boolean> {
  const probes = [
    "https://www.msftconnecttest.com/connecttest.txt",
    "https://dns.google/resolve?name=example.com&type=A",
  ];
  let fails = 0;
  for (const url of probes) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { method: "GET", signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok || res.status === 204) return true;
      fails++;
    } catch {
      fails++;
    }
  }
  return fails < probes.length;
}

export function ollamaLastUsedAt(): number {
  return lastUsedAt;
}
