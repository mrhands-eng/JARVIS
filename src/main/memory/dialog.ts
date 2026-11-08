import fs from "fs";
import path from "path";
import { projectRoot } from "../tools/allowlist";
import { logInfo } from "../logger";

export type DialogRole = "user" | "jarvis";

export type DialogMessage = {
  at: string;
  role: DialogRole;
  text: string;
};

const CURRENT = "dialog-current.jsonl";
const SUMMARY = "dialog-summary.txt";
const MAX_SUMMARY_CHARS = 8000;
const MAX_CURRENT_INJECT = 60;

function memoryDir(): string {
  const dir = path.join(projectRoot(), "data", "memory");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath(name: string): string {
  return path.join(memoryDir(), name);
}

function nowIso(): string {
  return new Date().toISOString();
}

function readCurrent(): DialogMessage[] {
  const p = filePath(CURRENT);
  if (!fs.existsSync(p)) return [];
  const out: DialogMessage[] = [];
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      out.push(JSON.parse(line) as DialogMessage);
    } catch {
      /* skip */
    }
  }
  return out;
}

function readSummary(): string {
  const p = filePath(SUMMARY);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8").trim();
}

function writeSummary(text: string): void {
  let body = text.trim();
  if (body.length > MAX_SUMMARY_CHARS) {
    body = "…(older trimmed)\n" + body.slice(body.length - MAX_SUMMARY_CHARS + 40);
  }
  fs.writeFileSync(filePath(SUMMARY), body + (body ? "\n" : ""), "utf8");
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** Fold leftover current-dialog turns into the durable previous-dialog summary. */
export function rollCurrentIntoSummary(reason = "session-end"): void {
  const turns = readCurrent();
  if (!turns.length) return;

  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const lines: string[] = [`### Session ${stamp} (${reason})`];
  for (const m of turns) {
    const who = m.role === "user" ? "User" : "JARVIS";
    lines.push(`- ${who}: ${clip(m.text, 220)}`);
  }
  const block = lines.join("\n");
  const prev = readSummary();
  writeSummary(prev ? `${prev}\n\n${block}` : block);
  fs.writeFileSync(filePath(CURRENT), "", "utf8");
  logInfo("dialog", `rolled ${turns.length} msgs → summary (${reason})`);
}

/** Call once on app boot: previous run becomes summary; this run starts fresh. */
export function beginDialogSession(): void {
  memoryDir();
  if (!fs.existsSync(filePath(SUMMARY))) {
    fs.writeFileSync(filePath(SUMMARY), "", "utf8");
  }
  if (!fs.existsSync(filePath(CURRENT))) {
    fs.writeFileSync(filePath(CURRENT), "", "utf8");
  }
  rollCurrentIntoSummary("app-start");
}

export function appendDialogMessage(role: DialogRole, text: string): void {
  const t = String(text || "").trim();
  if (!t) return;
  memoryDir();
  const msg: DialogMessage = { at: nowIso(), role, text: t };
  fs.appendFileSync(filePath(CURRENT), JSON.stringify(msg) + "\n", "utf8");
}

export function recordDialogTurn(userText: string, assistantText: string): void {
  appendDialogMessage("user", userText);
  appendDialogMessage("jarvis", assistantText);
}

/** Inject into every brain turn: prior-session summary + full current dialog. */
export function dialogContext(maxChars = 4000): string {
  const summary = readSummary();
  const current = readCurrent().slice(-MAX_CURRENT_INJECT);
  const parts: string[] = [
    "## Dialog memory",
    "Remember the current dialog verbatim. Use previous-session summary only as background.",
  ];
  if (summary) {
    parts.push("", "### Previous sessions (summary)", summary);
  } else {
    parts.push("", "### Previous sessions (summary)", "(none yet)");
  }
  if (current.length) {
    parts.push("", "### Current dialog (full)");
    for (const m of current) {
      parts.push(`${m.role === "user" ? "User" : "JARVIS"}: ${m.text}`);
    }
  } else {
    parts.push("", "### Current dialog (full)", "(just started)");
  }
  let out = parts.join("\n");
  if (out.length > maxChars) {
    // Prefer keeping the end of current dialog
    out = out.slice(out.length - maxChars);
    out = "…(dialog truncated)\n" + out;
  }
  return out;
}
