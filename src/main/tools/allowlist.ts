import fs from "fs";
import path from "path";

export type AppEntry = {
  label: string;
  paths: string[];
  args?: string[];
};

export type Allowlist = {
  apps: Record<string, AppEntry>;
  projectsRoot: string;
  /** Cursor/IDE project repos — usually projectsRoot\\CursorProjects */
  cursorProjectsRoot?: string;
  gameModeClose: string[];
};

export function cursorProjectsRoot(): string {
  const list = loadAllowlist();
  if (list.cursorProjectsRoot) return list.cursorProjectsRoot;
  return path.join(list.projectsRoot || "D:\\Projects", "CursorProjects");
}

let cached: Allowlist | null = null;

export function projectRoot(): string {
  return path.resolve(__dirname, "..", "..", "..");
}

export function loadAllowlist(): Allowlist {
  if (cached) return cached;
  const file = path.join(projectRoot(), "config", "apps.allowlist.json");
  cached = JSON.parse(fs.readFileSync(file, "utf8")) as Allowlist;
  return cached;
}

export function resolveAppPath(key: string): { entry: AppEntry; exe: string } | null {
  const list = loadAllowlist();
  const entry = list.apps[key.toLowerCase()];
  if (!entry) return null;
  for (const p of entry.paths) {
    if (fs.existsSync(p)) return { entry, exe: p };
  }
  return null;
}
