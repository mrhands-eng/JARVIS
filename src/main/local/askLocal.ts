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
  if (!prompt) return "Слушаю.";

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
      "You still have PC tools (open_app, open_url, create_folder, memory_*, see_screen, system_status, run_command, …).",
      "File-edit/self-heal via Cursor agent tools is limited — prefer PC tools + memory.",
      "Never claim a PC action without a successful tool result.",
      "Infer intent; pick tools/args yourself.",
      "VOICE: brief, natural, human — one short sentence by default. No filler, no closers, no tour-guide tips.",
      "User's language. Be JARVIS.",
      casual
        ? "CASUAL: one natural short line. No tools."
        : "see_screen if you need the monitor.",
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
              "Continue this dialog. Infer intent; call tools with the right args. Context is in the system message.",
            ].join("\n"),
      },
    ];

    let finalText = "";
    let usedTool = false;
    const maxSteps = casual ? 1 : 8;
    let fakeActionNudge = 0;

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
      // Qwen often claims PC actions without tools — force one retry with create_folder etc.
      if (
        finalText &&
        !usedTool &&
        !casual &&
        fakeActionNudge < 1 &&
        /(создал|создана|папк[ауеи]|folder|mkdir|удалил|открыл|запустил|сохранил)/i.test(finalText)
      ) {
        fakeActionNudge += 1;
        logInfo("localBrain", "fake-action reply without tools — nudging");
        emit({ type: "tool", name: "Нужен реальный инструмент…", status: "running" });
        messages.push({
          role: "user",
          content:
            "STOP. You claimed a PC action but called no tools. " +
            "Call create_folder / open_app / open_url / run_command / see_screen now. " +
            "Do not answer in prose until a tool returns success.",
        });
        finalText = "";
        continue;
      }
      if (finalText) {
        emit({ type: "delta", text: finalText });
        break;
      }
    }

    if (!finalText) {
      finalText = usedTool ? "Готово." : "Не понял — скажи иначе.";
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
      const nice = "Остановил.";
      emit({ type: "final", text: nice });
      emit({ type: "status", status: "idle", detail: "stopped" });
      return nice;
    }
    throw e;
  }
}
