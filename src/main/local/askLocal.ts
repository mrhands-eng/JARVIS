import fs from "fs";
import path from "path";
import { humanActivity, isCasualTurn, isNotableTool } from "../activity";
import { logError, logInfo } from "../logger";
import { absorbTurn, glanceDesktop } from "../memory/autonomy";
import { dialogContext } from "../memory/dialog";
import { bumpHabit, ensureMemorySeeded, memoryDossier } from "../memory/store";
import { beginTask, isCancelError, throwIfCancelled } from "../taskControl";
import { projectRoot } from "../tools/allowlist";
import { screenContextForPrompt, wantsScreenSight } from "../vision/screen";
import { loadLocalConfig } from "./config";
import {
  ensureOllamaRunning,
  ollamaChat,
  pickAvailableModel,
  type OllamaMessage,
} from "./ollama";
import { ollamaToolDefs, parseToolArgs, runLocalTool } from "./toolBridge";

export type LocalBrainEvent =
  | { type: "status"; status: "idle" | "thinking" | "error"; detail?: string }
  | { type: "delta"; text: string }
  | { type: "final"; text: string }
  | { type: "tool"; name: string; status: string };

type Emit = (ev: LocalBrainEvent) => void;

function standingOrders(): string {
  try {
    return fs.readFileSync(path.join(projectRoot(), "config", "jarvis.system.md"), "utf8");
  } catch {
    return "You are JARVIS.";
  }
}

function normalizeUserText(text: string): string {
  return text
    .trim()
    .replace(/^\s*(джарвис|jarvis)\s*[,:!?\-—–]+\s*/i, "")
    .trim();
}

/**
 * Fully local JARVIS turn via Ollama (Qwen) + the same PC custom tools.
 * No Cursor SDK — works offline.
 */
export async function askLocalJarvis(userText: string, emit: Emit): Promise<string> {
  const prompt = normalizeUserText(userText);
  if (!prompt) return "Слушаю, сэр.";

  beginTask();
  ensureMemorySeeded();
  const cfg = loadLocalConfig();
  if (!cfg.enabled) throw new Error("Local brain disabled in config/local.json");

  try {
    emit({ type: "status", status: "thinking", detail: "Локальный режим…" });
    const up = await ensureOllamaRunning();
    throwIfCancelled();
    if (!up) throw new Error("Ollama не запущена. Установите Ollama и повторите.");

    emit({ type: "status", status: "thinking", detail: "Готовлю локальную модель…" });
    const model = await pickAvailableModel();
    throwIfCancelled();
    logInfo("localBrain", `model=${model}`);
    emit({ type: "tool", name: `Локально: ${model}`, status: "running" });

    bumpHabit({ intent: `local:${prompt.slice(0, 50)}` });
    const casual = isCasualTurn(prompt);
    const desktop = casual ? "" : await glanceDesktop();
    throwIfCancelled();
    let screen = "";
    if (!casual && wantsScreenSight(prompt)) {
      emit({ type: "status", status: "thinking", detail: "Смотрю на экран…" });
      emit({ type: "tool", name: "Смотрю на экран…", status: "running" });
      screen = await screenContextForPrompt(2000);
      throwIfCancelled();
    }
    const system = [
      standingOrders(),
      "",
      "LOCAL MODE: Cursor cloud is unavailable or offline. You run on Ollama on this PC.",
      "You still have PC tools (open_app, open_url, memory_*, see_screen, system_status, …).",
      "File-edit/self-heal via Cursor agent tools is limited — prefer PC tools + memory.",
      "Answer in the user's language. Be JARVIS.",
      casual
        ? "CASUAL TURN: one short natural sentence. No capability pitch. No tools."
        : "Call see_screen when you need to know what is on the monitor (OCR + windows).",
      "",
      casual ? "" : memoryDossier(900),
      "",
      dialogContext(casual ? 1200 : 2200),
      "",
      desktop,
      screen,
    ]
      .filter(Boolean)
      .join("\n");

    const tools = casual ? undefined : ollamaToolDefs();
    const messages: OllamaMessage[] = [
      { role: "system", content: system },
      {
        role: "user",
        content: casual
          ? `User said:\n${prompt}\n\nGreet back briefly.`
          : [
              "User said:",
              prompt,
              "",
              "Continue this dialog. Current + previous dialog context is in the system message.",
            ].join("\n"),
      },
    ];

    let finalText = "";
    let usedTool = false;
    const maxSteps = casual ? 1 : 8;

    for (let step = 0; step < maxSteps; step++) {
      throwIfCancelled();
      emit({
        type: "status",
        status: "thinking",
        detail: step === 0 ? `Думаю (${model})…` : "Следующий шаг…",
      });
      const msg = await ollamaChat({
        model,
        messages,
        tools,
        timeoutMs: cfg.timeoutMs,
      });
      throwIfCancelled();

      messages.push(msg);

      const calls = msg.tool_calls || [];
      if (calls.length) {
        usedTool = true;
        for (const call of calls) {
          throwIfCancelled();
          const name = call.function?.name || "tool";
          const args = parseToolArgs(call.function?.arguments ?? {});
          const activity = humanActivity(name, "running");
          emit({ type: "status", status: "thinking", detail: activity });
          if (isNotableTool(name)) emit({ type: "tool", name: activity, status: "running" });

          const result = await runLocalTool(name, args);
          throwIfCancelled();
          const done = humanActivity(name, "completed");
          if (isNotableTool(name)) emit({ type: "tool", name: done, status: "completed" });

          messages.push({
            role: "tool",
            tool_name: name,
            content: result.slice(0, 6000),
          });
        }
        continue;
      }

      finalText = (msg.content || "").trim();
      if (finalText) {
        emit({ type: "delta", text: finalText });
        break;
      }
    }

    if (!finalText) {
      finalText = usedTool ? "Готово, сэр. (локальный режим)" : "Не разобрал запрос в локальном режиме.";
    }

    if (!/\(local ·/i.test(finalText)) {
      finalText = `${finalText}\n\n(local · ${model})`;
    }

    try {
      absorbTurn(prompt, finalText);
    } catch (e) {
      logError("local.absorb", e);
    }

    emit({ type: "final", text: finalText });
    emit({ type: "status", status: "idle", detail: "JARVIS local" });
    return finalText;
  } catch (e) {
    if (isCancelError(e)) {
      const nice = "Остановлено, сэр.";
      emit({ type: "final", text: nice });
      emit({ type: "status", status: "idle", detail: "stopped" });
      return nice;
    }
    throw e;
  }
}
