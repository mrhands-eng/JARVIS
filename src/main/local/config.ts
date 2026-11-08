import fs from "fs";
import path from "path";
import { projectRoot } from "../tools/allowlist";

export type LocalConfig = {
  enabled: boolean;
  endpoint: string;
  /** Relative to project root — JARVIS-only Ollama store */
  modelsDir: string;
  model: string;
  fallbackModel: string;
  timeoutMs: number;
  preferLocalWhenOffline: boolean;
  preferLocalWhenCursorFails: boolean;
  /** Online: send simple PC chores to local Ollama to save Cursor tokens */
  routeSimpleToLocal: boolean;
  routeShortChars: number;
  routeLongChars: number;
  /** Stop JARVIS Ollama (port 11435) after idle; 0 = never auto-stop */
  ollamaIdleStopMs: number;
};

const DEFAULTS: LocalConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:11435",
  modelsDir: "data/ollama",
  model: "qwen2.5:7b",
  fallbackModel: "qwen2.5:14b",
  timeoutMs: 180_000,
  preferLocalWhenOffline: true,
  preferLocalWhenCursorFails: true,
  routeSimpleToLocal: true,
  routeShortChars: 72,
  routeLongChars: 320,
  ollamaIdleStopMs: 5 * 60_000,
};

export function loadLocalConfig(): LocalConfig {
  const file = path.join(projectRoot(), "config", "local.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LocalConfig>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}
