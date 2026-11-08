import fs from "fs";
import os from "os";
import path from "path";
import { projectRoot } from "../tools/allowlist";

/** All durable user/PC knowledge stays under data/memory — never uploaded by this module. */

export type UserProfile = {
  preferredName: string;
  addressAs: string;
  languages: string[];
  timezone: string;
  notes: string[];
  updatedAt: string;
};

export type SystemFacts = {
  hostname: string;
  os: string;
  projectsRoot: string;
  browser: string;
  ide: string;
  steamLibrary: string;
  notes: string[];
  updatedAt: string;
};

export type Interests = {
  topics: string[];
  creators: string[];
  games: string[];
  projects: string[];
  updatedAt: string;
};

export type Habits = {
  /** hour(0-23) -> count of interactions */
  hourHistogram: Record<string, number>;
  frequentApps: Record<string, number>;
  frequentIntents: Record<string, number>;
  lastSeenAt: string;
  notes: string[];
  updatedAt: string;
};

export type MemoryNote = {
  at: string;
  kind: "fact" | "preference" | "interest" | "habit" | "episode" | "system";
  text: string;
  tags?: string[];
};

type MemoryBundle = {
  profile: UserProfile;
  system: SystemFacts;
  interests: Interests;
  habits: Habits;
};

function nowIso(): string {
  return new Date().toISOString();
}

function memoryDir(): string {
  const dir = path.join(projectRoot(), "data", "memory");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath(name: string): string {
  return path.join(memoryDir(), name);
}

function readJson<T>(name: string, fallback: T): T {
  const p = filePath(name);
  if (!fs.existsSync(p)) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(fs.readFileSync(p, "utf8")) as T) };
  } catch {
    return fallback;
  }
}

function writeJson(name: string, data: unknown): void {
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), "utf8");
}

function defaultProfile(): UserProfile {
  return {
    preferredName: "codein",
    addressAs: "сэр",
    languages: ["ru", "en"],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow",
    notes: ["Предпочитает кодить и итерировать прямо в коде."],
    updatedAt: nowIso(),
  };
}

function defaultSystem(): SystemFacts {
  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    projectsRoot: "D:\\Projects",
    browser: "Zen",
    ide: "Cursor (D:\\cursor\\Cursor.exe)",
    steamLibrary: "D:\\SteamLibrary",
    notes: ["Stark OS / JARVIS живёт в D:\\Projects\\CursorProjects\\stark-os"],
    updatedAt: nowIso(),
  };
}

function defaultInterests(): Interests {
  return {
    topics: ["программирование", "Marvel/DC новости", "игры"],
    creators: ["Кьюбайт"],
    games: [],
    projects: ["stark-os"],
    updatedAt: nowIso(),
  };
}

function defaultHabits(): Habits {
  return {
    hourHistogram: {},
    frequentApps: {},
    frequentIntents: {},
    lastSeenAt: nowIso(),
    notes: [],
    updatedAt: nowIso(),
  };
}

export function ensureMemorySeeded(): void {
  memoryDir();
  if (!fs.existsSync(filePath("profile.json"))) writeJson("profile.json", defaultProfile());
  if (!fs.existsSync(filePath("system.json"))) writeJson("system.json", defaultSystem());
  if (!fs.existsSync(filePath("interests.json"))) writeJson("interests.json", defaultInterests());
  if (!fs.existsSync(filePath("habits.json"))) writeJson("habits.json", defaultHabits());
  if (!fs.existsSync(filePath("notes.jsonl"))) fs.writeFileSync(filePath("notes.jsonl"), "", "utf8");
  if (!fs.existsSync(filePath("README.txt"))) {
    fs.writeFileSync(
      filePath("README.txt"),
      [
        "JARVIS local memory — only on this PC.",
        "profile.json   — who you are, how to address you",
        "system.json    — this machine & paths",
        "interests.json — topics, creators, games, projects",
        "habits.json    — usage patterns",
        "notes.jsonl    — dated observations (one JSON object per line)",
        "dialog-current.jsonl — full messages of the current dialog",
        "dialog-summary.txt   — rolled summaries of previous dialogs",
        "",
        "Nothing here is synced by Stark OS. Delete files to forget.",
      ].join("\n"),
      "utf8"
    );
  }
}

export function loadMemory(): MemoryBundle {
  ensureMemorySeeded();
  return {
    profile: readJson("profile.json", defaultProfile()),
    system: readJson("system.json", defaultSystem()),
    interests: readJson("interests.json", defaultInterests()),
    habits: readJson("habits.json", defaultHabits()),
  };
}

export function appendNote(note: Omit<MemoryNote, "at"> & { at?: string }): MemoryNote {
  ensureMemorySeeded();
  const full: MemoryNote = {
    at: note.at || nowIso(),
    kind: note.kind,
    text: String(note.text || "").trim(),
    tags: note.tags,
  };
  if (!full.text) return full;
  fs.appendFileSync(filePath("notes.jsonl"), JSON.stringify(full) + "\n", "utf8");
  return full;
}

export function recentNotes(limit = 12): MemoryNote[] {
  ensureMemorySeeded();
  const raw = fs.readFileSync(filePath("notes.jsonl"), "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out: MemoryNote[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]!) as MemoryNote);
    } catch {
      /* skip bad line */
    }
  }
  return out.reverse();
}

export function updateProfile(patch: Partial<UserProfile>): UserProfile {
  const cur = loadMemory().profile;
  const next: UserProfile = {
    ...cur,
    ...patch,
    languages: patch.languages ?? cur.languages,
    notes: patch.notes ?? cur.notes,
    updatedAt: nowIso(),
  };
  writeJson("profile.json", next);
  return next;
}

export function updateSystem(patch: Partial<SystemFacts>): SystemFacts {
  const cur = loadMemory().system;
  const next: SystemFacts = {
    ...cur,
    ...patch,
    notes: patch.notes ?? cur.notes,
    updatedAt: nowIso(),
  };
  writeJson("system.json", next);
  return next;
}

export function updateInterests(patch: Partial<Interests>): Interests {
  const cur = loadMemory().interests;
  const merge = (incoming: string[] | undefined, existing: string[]) =>
    incoming
      ? Array.from(new Set([...existing, ...incoming].map((s) => s.trim()).filter(Boolean)))
      : existing;
  const next: Interests = {
    topics: merge(patch.topics, cur.topics),
    creators: merge(patch.creators, cur.creators),
    games: merge(patch.games, cur.games),
    projects: merge(patch.projects, cur.projects),
    updatedAt: nowIso(),
  };
  writeJson("interests.json", next);
  return next;
}

export function bumpHabit(opts: {
  intent?: string;
  app?: string;
}): Habits {
  const cur = loadMemory().habits;
  const hour = String(new Date().getHours());
  cur.hourHistogram[hour] = (cur.hourHistogram[hour] || 0) + 1;
  if (opts.intent) {
    const k = opts.intent.toLowerCase().slice(0, 80);
    cur.frequentIntents[k] = (cur.frequentIntents[k] || 0) + 1;
  }
  if (opts.app) {
    const k = opts.app.toLowerCase();
    cur.frequentApps[k] = (cur.frequentApps[k] || 0) + 1;
  }
  cur.lastSeenAt = nowIso();
  cur.updatedAt = nowIso();
  writeJson("habits.json", cur);
  return cur;
}

function topEntries(map: Record<string, number>, n: number): string[] {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} (${v})`);
}

/** Compact dossier injected into each user turn — local only. */
export function memoryDossier(maxChars = 2200): string {
  const m = loadMemory();
  const notes = recentNotes(8);
  const peakHours = topEntries(m.habits.hourHistogram, 3).join(", ") || "пока мало данных";
  const apps = topEntries(m.habits.frequentApps, 5).join(", ") || "—";
  const intents = topEntries(m.habits.frequentIntents, 5).join(", ") || "—";

  const lines = [
    "## Local memory (private, this PC only — use it; update via tools when you learn something)",
    `User: ${m.profile.preferredName}; address as «${m.profile.addressAs}»; languages: ${m.profile.languages.join(", ")}`,
    m.profile.notes.length ? `Profile notes: ${m.profile.notes.join(" · ")}` : "",
    `System: ${m.system.hostname} | ${m.system.os}`,
    `Paths: projects=${m.system.projectsRoot}; browser=${m.system.browser}; IDE=${m.system.ide}; Steam=${m.system.steamLibrary}`,
    m.system.notes.length ? `System notes: ${m.system.notes.join(" · ")}` : "",
    `Interests: topics=[${m.interests.topics.join(", ")}]; creators=[${m.interests.creators.join(", ")}]; games=[${m.interests.games.join(", ")}]; projects=[${m.interests.projects.join(", ")}]`,
    `Habits: peak hours ${peakHours}; apps ${apps}; intents ${intents}`,
    m.habits.notes.length ? `Habit notes: ${m.habits.notes.join(" · ")}` : "",
    notes.length
      ? "Recent notes:\n" + notes.map((n) => `- [${n.kind}] ${n.text}`).join("\n")
      : "Recent notes: (none yet)",
  ].filter(Boolean);

  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars - 20) + "\n…(truncated)";
  return out;
}

export function mergeListField(
  section: "profile" | "system" | "habits",
  field: "notes",
  items: string[]
): string {
  const m = loadMemory();
  if (section === "profile") {
    const notes = Array.from(new Set([...m.profile.notes, ...items.map((s) => s.trim()).filter(Boolean)]));
    updateProfile({ notes });
    return `profile.notes now has ${notes.length} items`;
  }
  if (section === "system") {
    const notes = Array.from(new Set([...m.system.notes, ...items.map((s) => s.trim()).filter(Boolean)]));
    updateSystem({ notes });
    return `system.notes now has ${notes.length} items`;
  }
  const notes = Array.from(new Set([...m.habits.notes, ...items.map((s) => s.trim()).filter(Boolean)]));
  const habits = { ...m.habits, notes, updatedAt: nowIso() };
  writeJson("habits.json", habits);
  return `habits.notes now has ${notes.length} items`;
}

export function searchNotes(query: string, limit = 20): MemoryNote[] {
  const q = query.toLowerCase().trim();
  if (!q) return recentNotes(limit);
  ensureMemorySeeded();
  const raw = fs.readFileSync(filePath("notes.jsonl"), "utf8");
  const hits: MemoryNote[] = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean).reverse()) {
    try {
      const n = JSON.parse(line) as MemoryNote;
      const blob = `${n.kind} ${n.text} ${(n.tags || []).join(" ")}`.toLowerCase();
      if (blob.includes(q)) {
        hits.push(n);
        if (hits.length >= limit) break;
      }
    } catch {
      /* skip */
    }
  }
  return hits;
}

export function memoryPathForUser(): string {
  return memoryDir();
}
