import fs from "fs";
import path from "path";
import { Agent, Cursor, type SDKAgent } from "@cursor/sdk";
import dotenv from "dotenv";
import { humanActivity, isCasualTurn, isNotableTool } from "./activity";
import { logError, logInfo } from "./logger";
import { absorbTurn, glanceDesktop } from "./memory/autonomy";
import { dialogContext } from "./memory/dialog";
import { bumpHabit, ensureMemorySeeded, memoryDossier } from "./memory/store";
import {
  beginTask,
  clearCancel,
  isCancelError,
  isCancelled,
  throwIfCancelled,
} from "./taskControl";
import { setConfirmHandler } from "./tools/actions";
import { projectRoot } from "./tools/allowlist";
import { buildCustomTools } from "./tools/customTools";
import { screenContextForPrompt, wantsScreenSight } from "./vision/screen";

dotenv.config({ path: path.join(projectRoot(), ".env") });

export type BrainEvent =
  | { type: "status"; status: "idle" | "thinking" | "error"; detail?: string }
  | { type: "delta"; text: string }
  | { type: "final"; text: string }
  | { type: "tool"; name: string; status: string };

type Listener = (ev: BrainEvent) => void;
type ConfirmBridge = (message: string) => Promise<boolean>;

let agent: SDKAgent | null = null;
let bootstrapped = false;
let listeners = new Set<Listener>();
let busy = false;
let confirmBridge: ConfirmBridge | null = null;
let activeRun: { cancel: () => Promise<void> } | null = null;

export async function cancelActiveRun(): Promise<boolean> {
  if (!activeRun) return false;
  try {
    await activeRun.cancel();
    return true;
  } catch (e) {
    logError("brain.cancelRun", e);
    return false;
  }
}

export function onBrainEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setConfirmBridge(fn: ConfirmBridge): void {
  confirmBridge = fn;
  setConfirmHandler(async (message) => {
    if (!confirmBridge) return false;
    return confirmBridge(message);
  });
}

function emit(ev: BrainEvent): void {
  for (const listener of listeners) {
    try {
      listener(ev);
    } catch (err) {
      logError("brain.emit", err);
    }
  }
}

function standingOrders(): string {
  return fs.readFileSync(path.join(projectRoot(), "config", "jarvis.system.md"), "utf8");
}

function normalizeUserText(text: string): string {
  return text
    .trim()
    .replace(/^\s*(джарвис|jarvis)\s*[,:!?\-—–]+\s*/i, "")
    .trim();
}

function runErrorMessage(result: {
  status?: string;
  error?: { message?: string } | string;
  result?: unknown;
}): string {
  if (result.error) {
    if (typeof result.error === "string") return result.error;
    if (result.error.message) return result.error.message;
  }
  if (result.result) return String(result.result);
  return "Agent run failed";
}

async function ensureAuth(): Promise<void> {
  if (process.env.CURSOR_API_KEY) return;
  try {
    const status = await Cursor.auth.status();
    if (status.status === "logged-in") return;
  } catch {
    /* no stored login */
  }
  emit({ type: "status", status: "thinking", detail: "Cursor login required…" });
  await Cursor.auth.login({ apiKeyName: "Stark OS JARVIS" });
}

async function createAgent(): Promise<SDKAgent> {
  await ensureAuth();
  const modelId = process.env.STARK_MODEL || "composer-2.5";
  // Do NOT set systemPrompt — not enabled for all accounts.
  return Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: modelId },
    mode: "agent",
    local: {
      cwd: projectRoot(),
      settingSources: [],
      customTools: buildCustomTools(),
    },
  });
}

async function bootstrapAgent(instance: SDKAgent): Promise<void> {
  if (bootstrapped) return;
  ensureMemorySeeded();
  const run = await instance.send(
    [
      "Standing orders for this entire conversation (follow until told otherwise):",
      standingOrders(),
      "",
      memoryDossier(1400),
      "",
      dialogContext(1600),
      "",
      'Acknowledge with exactly one short line, e.g. "JARVIS online." Do not call tools yet.',
    ].join("\n"),
    { mode: "agent" }
  );
  for await (const _event of run.stream()) {
    /* drain */
  }
  const result = await run.wait();
  if (result.status === "error") {
    throw new Error(runErrorMessage(result));
  }
  bootstrapped = true;
  logInfo("brain", "bootstrap ok");
}

export async function ensureBrain(): Promise<void> {
  if (agent && bootstrapped) return;
  if (!agent) {
    agent = await createAgent();
    logInfo("brain", "agent created");
  }
  await bootstrapAgent(agent);
  emit({ type: "status", status: "idle", detail: "JARVIS online" });
}

async function resetBrain(): Promise<void> {
  try {
    await disposeBrain();
  } catch (err) {
    logError("brain.reset.dispose", err);
  }
  bootstrapped = false;
  agent = await createAgent();
  await bootstrapAgent(agent);
  logInfo("brain", "agent recreated");
}

function extractText(event: {
  type: string;
  message?: { content?: Array<{ type: string; text?: string }> };
}): string {
  if (event.type !== "assistant" || !event.message?.content) return "";
  let out = "";
  for (const block of event.message.content) {
    if (block.type === "text" && typeof block.text === "string") out += block.text;
  }
  return out;
}

export async function askJarvis(userText: string): Promise<string> {
  const prompt = normalizeUserText(userText);
  if (!prompt) return "Listening, sir.";
  if (busy) {
    emit({ type: "status", status: "error", detail: "Still processing previous request" });
    return "One moment — still finishing the previous request.";
  }
  busy = true;
  beginTask();
  emit({ type: "status", status: "thinking", detail: "Processing…" });

  const runOnce = async (): Promise<string> => {
    throwIfCancelled();
    await ensureBrain();
    if (!agent) throw new Error("Agent failed to start");

    let finalText = "";
    let usedTool = false;

    bumpHabit({ intent: prompt.slice(0, 60) });
    const casual = isCasualTurn(prompt);
    let desktop = "";
    let screen = "";
    if (!casual) {
      emit({ type: "status", status: "thinking", detail: "Смотрю обстановку…" });
      desktop = await glanceDesktop();
      throwIfCancelled();
      if (wantsScreenSight(prompt)) {
        emit({ type: "status", status: "thinking", detail: "Смотрю на экран…" });
        emit({ type: "tool", name: "Смотрю на экран…", status: "running" });
        screen = await screenContextForPrompt(2400);
        throwIfCancelled();
      }
    }
    const enriched = casual
      ? [
          dialogContext(1200),
          "",
          "User said:",
          prompt,
          "",
          "This is a greeting / tiny chitchat. Reply in ONE short natural sentence in the user's language.",
          "Do not pitch HUD/Cursor/capabilities. Do not call tools.",
        ].join("\n")
      : [
          memoryDossier(1000),
          "",
          dialogContext(2400),
          "",
          desktop,
          screen ? "\n" + screen : "",
          "",
          "User said:",
          prompt,
          "",
          "Decide and act yourself. Keep continuity with the current dialog above. Do not ask how to remember or whether to help — just be useful.",
          "If you need a fresh look at the monitor, call see_screen (then Read the image path if needed).",
        ].join("\n");

    throwIfCancelled();
    const run = await agent.send(enriched, { mode: "agent" });
    activeRun = run;
    try {
      for await (const event of run.stream()) {
        if (isCancelled()) {
          await run.cancel().catch(() => undefined);
          throwIfCancelled();
        }
        if (event.type === "assistant") {
          const chunk = extractText(
            event as { type: string; message?: { content?: Array<{ type: string; text?: string }> } }
          );
          if (chunk) {
            finalText += chunk;
            emit({ type: "delta", text: chunk });
          }
        } else if (event.type === "tool_call") {
          usedTool = true;
          const name = (event as { name: string }).name;
          const status = (event as { status: string }).status;
          const activity = humanActivity(name, status);
          emit({ type: "status", status: "thinking", detail: activity });
          if (isNotableTool(name)) {
            emit({ type: "tool", name: activity, status });
          }
          logInfo("tool", `${name} ${status} :: ${activity}`);
        }
      }

      const result = await run.wait();
      if (result.status === "cancelled" || isCancelled()) {
        throwIfCancelled();
      }
      if (result.status === "error") {
        throw new Error(runErrorMessage(result));
      }
      if (result.status === "finished" && result.result) {
        finalText = String(result.result);
      }
    } finally {
      activeRun = null;
    }

    finalText = finalText.trim();
    if (!finalText || /^done\.?$/i.test(finalText)) {
      finalText = usedTool ? "Готово, сэр." : "Не совсем понял. Сделаю лучшее предположение в следующий раз — уточните цель, если нужно.";
    }

    try {
      absorbTurn(prompt, finalText);
    } catch (err) {
      logError("memory.absorbTurn", err);
    }
    return finalText;
  };

  try {
    const answer = await runOnce();
    emit({ type: "final", text: answer });
    emit({ type: "status", status: "idle" });
    return answer;
  } catch (e) {
    if (isCancelError(e) || isCancelled()) {
      const nice = "Остановлено, сэр.";
      emit({ type: "status", status: "idle", detail: "stopped" });
      emit({ type: "final", text: nice });
      return nice;
    }
    logError("brain.askJarvis", e);
    try {
      throwIfCancelled();
      await resetBrain();
      const answer = await runOnce();
      emit({ type: "final", text: answer });
      emit({ type: "status", status: "idle" });
      return answer;
    } catch (e2) {
      if (isCancelError(e2) || isCancelled()) {
        const nice = "Остановлено, сэр.";
        emit({ type: "status", status: "idle", detail: "stopped" });
        emit({ type: "final", text: nice });
        return nice;
      }
      logError("brain.askJarvis.retry", e2);
      const msg = (e2 as Error).message || String(e2);
      const nice = `Systems error: ${msg}`;
      emit({ type: "status", status: "error", detail: msg });
      emit({ type: "final", text: nice });
      return nice;
    }
  } finally {
    busy = false;
    activeRun = null;
    clearCancel();
  }
}

export async function disposeBrain(): Promise<void> {
  if (agent && typeof (agent as { [Symbol.asyncDispose]?: () => Promise<void> })[Symbol.asyncDispose] === "function") {
    await (agent as unknown as { [Symbol.asyncDispose]: () => Promise<void> })[Symbol.asyncDispose]();
  }
  agent = null;
  bootstrapped = false;
}
