import fs from "fs";
import path from "path";
import { projectRoot } from "./tools/allowlist";

export type BrainMode = "cursor" | "local";

const FILE = () => path.join(projectRoot(), "data", "brain-mode.json");

export function getBrainMode(): BrainMode {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), "utf8")) as { mode?: string };
    return raw.mode === "local" ? "local" : "cursor";
  } catch {
    return "cursor";
  }
}

export function setBrainMode(mode: BrainMode): BrainMode {
  const next: BrainMode = mode === "local" ? "local" : "cursor";
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify({ mode: next, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  return next;
}

export function toggleBrainMode(): BrainMode {
  return setBrainMode(getBrainMode() === "local" ? "cursor" : "local");
}
