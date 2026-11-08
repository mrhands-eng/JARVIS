import fs from "fs";
import os from "os";
import path from "path";

const logDir = path.join(os.homedir(), "AppData", "Roaming", "stark-os");
const logFile = path.join(logDir, "jarvis.log");

function projectLogFile(): string | null {
  try {
    // dist/main → repo root
    const root = path.resolve(__dirname, "..", "..");
    const dir = path.join(root, "data", "logs");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "jarvis.log");
  } catch {
    return null;
  }
}

function appendBoth(line: string): void {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logFile, line, "utf8");
  const alt = projectLogFile();
  if (alt) {
    try {
      fs.appendFileSync(alt, line, "utf8");
    } catch {
      /* ignore */
    }
  }
}

export function logError(scope: string, err: unknown): void {
  try {
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack || ""}` : String(err);
    appendBoth(`\n[${new Date().toISOString()}] ${scope}\n${msg}\n`);
  } catch {
    /* ignore */
  }
}

export function logInfo(scope: string, detail: string): void {
  try {
    appendBoth(`\n[${new Date().toISOString()}] ${scope}: ${detail}\n`);
  } catch {
    /* ignore */
  }
}

export function getLogPath(): string {
  return logFile;
}
