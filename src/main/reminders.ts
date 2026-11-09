import fs from "fs";
import path from "path";
import { Notification } from "electron";
import { appendNote } from "./memory/store";
import { logError, logInfo } from "./logger";
import { projectRoot } from "./tools/allowlist";

export type ReminderRecord = {
  id: string;
  message: string;
  fireAt: number;
};

export type ReminderHudItem = {
  id: string;
  message: string;
  fireAt: number;
};

type DeliverOpts = {
  sendHud: (text: string) => void;
  hudVisible: () => boolean;
  hudFocused: () => boolean;
  speak?: (text: string) => Promise<void>;
  isMuted?: () => boolean;
  onRemindersChanged?: () => void;
};

const MAX_DELAY_MS = 2 ** 31 - 1;
/** While running, drop pending rows that are overdue beyond this (timer misfire safety). */
const STALE_PENDING_MS = 5 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

const timers = new Map<string, NodeJS.Timeout>();
let deliverOpts: DeliverOpts | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let watchBusy = false;

/** Only Electron main (HUD) arms timers and delivers; brain-worker only writes disk. */
function isDeliveryHost(): boolean {
  return deliverOpts !== null;
}

function remindersFile(): string {
  const dir = path.join(projectRoot(), "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "reminders.json");
}

function loadRecords(): ReminderRecord[] {
  const file = remindersFile();
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as ReminderRecord[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveRecords(list: ReminderRecord[]): void {
  fs.writeFileSync(remindersFile(), JSON.stringify(list, null, 2), "utf8");
  deliverOpts?.onRemindersChanged?.();
}

export function getRemindersSnapshot(): ReminderHudItem[] {
  return loadRecords()
    .filter((r) => r.fireAt > Date.now())
    .sort((a, b) => a.fireAt - b.fireAt)
    .map(({ id, message, fireAt }) => ({ id, message, fireAt }));
}

function disarmAll(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

function disarm(id: string): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

function formatWhen(fireAt: number): string {
  return new Date(fireAt).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;

type ScheduleWhenOpts = {
  inMinutes?: number;
  inSeconds?: number;
  fireAtIso?: string;
  atTime?: string;
  onDate?: string;
};

function parseClock(text: string): { h: number; m: number; s: number } | null {
  const t = text.trim();
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  if (h > 23 || min > 59 || s > 59) return null;
  return { h, m: min, s };
}

function calendarParts(
  onDate: string | undefined,
  now: Date
): { y: number; mo: number; d: number } | string {
  const raw = onDate?.trim() ?? "";
  const lower = raw.toLowerCase();
  const y0 = now.getFullYear();
  const mo0 = now.getMonth();
  const d0 = now.getDate();

  if (!raw || lower === "today" || lower === "сегодня") {
    return { y: y0, mo: mo0, d: d0 };
  }
  if (lower === "tomorrow" || lower === "завтра") {
    const next = new Date(y0, mo0, d0 + 1);
    return { y: next.getFullYear(), mo: next.getMonth(), d: next.getDate() };
  }

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return "Некорректная дата on_date.";
    return { y, mo, d };
  }

  m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/.exec(raw);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]) - 1;
    let y = m[3] ? Number(m[3]) : y0;
    if (m[3] && m[3].length === 2) y = 2000 + y;
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return "Некорректная дата on_date.";
    return { y, mo, d };
  }

  return "on_date: YYYY-MM-DD, DD.MM.YYYY, «сегодня»/«завтра».";
}

function resolveFireAt(opts: ScheduleWhenOpts): number | string {
  const now = Date.now();
  const nowDate = new Date();

  const iso = opts.fireAtIso?.trim();
  if (iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "fire_at_iso: невалидная дата.";
    if (ms <= now) return "Указанное время уже прошло.";
    if (ms - now > MAX_FUTURE_MS) return "Слишком далёкая дата (лимит ~1 год).";
    return ms;
  }

  const atTime = opts.atTime?.trim();
  if (atTime) {
    const clock = parseClock(atTime);
    if (!clock) return "at_time: ожидается HH:MM или HH:MM:SS (локальное время).";

    const parts = calendarParts(opts.onDate, nowDate);
    if (typeof parts === "string") return parts;

    let fire = new Date(parts.y, parts.mo, parts.d, clock.h, clock.m, clock.s, 0);
    const explicitDate = Boolean(opts.onDate?.trim());

    if (!explicitDate && fire.getTime() <= now) {
      fire = new Date(parts.y, parts.mo, parts.d + 1, clock.h, clock.m, clock.s, 0);
    }

    const ms = fire.getTime();
    if (ms <= now) return "Указанная дата и время уже прошли.";
    if (ms - now > MAX_FUTURE_MS) return "Слишком далёкая дата (лимит ~1 год).";
    return ms;
  }

  let delayMs = 0;
  if (opts.inSeconds !== undefined && Number.isFinite(opts.inSeconds)) {
    delayMs = Math.max(3, opts.inSeconds) * 1000;
  } else if (opts.inMinutes !== undefined && Number.isFinite(opts.inMinutes)) {
    delayMs = Math.max(0.05, opts.inMinutes) * 60 * 1000;
  } else {
    return "Укажите at_time (+ on_date), fire_at_iso, in_minutes или in_seconds.";
  }

  const relCap = 30 * 24 * 60 * 60 * 1000;
  if (delayMs > relCap) delayMs = relCap;

  const ms = now + delayMs;
  if (ms - now > MAX_FUTURE_MS) return "Слишком далёкая дата (лимит ~1 год).";
  return ms;
}

/** On the HUD host: fire or drop very stale rows. Else: no-op (do not delete from worker/MCP). */
export function pruneInactiveReminders(): number {
  if (!isDeliveryHost()) return 0;

  const cutoff = Date.now() - STALE_PENDING_MS;
  const list = loadRecords();
  const keep: ReminderRecord[] = [];
  let pruned = 0;
  for (const r of list) {
    if (r.fireAt < cutoff) {
      disarm(r.id);
      if (r.fireAt <= Date.now()) {
        void fireReminder(r.id);
      } else {
        pruned++;
      }
      continue;
    }
    if (r.fireAt <= Date.now()) {
      disarm(r.id);
      void fireReminder(r.id);
      continue;
    }
    keep.push(r);
  }
  if (pruned > 0) {
    saveRecords(keep);
    logInfo("reminder.prune", `removed ${pruned} inactive`);
  }
  return pruned;
}

/** @deprecated use pruneInactiveReminders */
export function pruneExpiredReminders(): number {
  return pruneInactiveReminders();
}

function armOne(record: ReminderRecord): void {
  if (!isDeliveryHost()) return;

  const existing = timers.get(record.id);
  if (existing) clearTimeout(existing);

  const delay = record.fireAt - Date.now();
  if (delay < -STALE_PENDING_MS) {
    disarm(record.id);
    if (loadRecords().some((r) => r.id === record.id)) {
      void fireReminder(record.id);
    }
    return;
  }
  if (delay <= 0) {
    void fireReminder(record.id);
    return;
  }

  const wait = Math.min(delay, MAX_DELAY_MS);
  const timer = setTimeout(() => {
    if (delay > MAX_DELAY_MS) {
      armOne(record);
      return;
    }
    void fireReminder(record.id);
  }, wait);
  timers.set(record.id, timer);
}

function armAllPending(): void {
  disarmAll();
  pruneExpiredReminders();
  for (const r of loadRecords()) armOne(r);
}

async function fireReminder(id: string): Promise<void> {
  if (!isDeliveryHost()) return;

  timers.delete(id);
  const list = loadRecords();
  const idx = list.findIndex((r) => r.id === id);
  if (idx < 0) return;
  const [record] = list.splice(idx, 1);
  saveRecords(list);

  const hudLine = `⏰ Напоминание: ${record.message}`;
  logInfo("reminder.fire", hudLine);
  deliverOpts?.sendHud(hudLine);

  try {
    if (Notification.isSupported()) {
      new Notification({
        title: "JARVIS",
        body: record.message,
      }).show();
    }
  } catch (e) {
    logError("reminder.notify", e);
  }

  if (!deliverOpts?.isMuted?.() && deliverOpts?.speak) {
    void deliverOpts.speak(record.message).catch((e) => logError("reminder.tts", e));
  }

  try {
    appendNote({
      kind: "episode",
      text: `reminder: ${record.message.slice(0, 200)}`,
      tags: ["reminder"],
    });
  } catch {
    /* ignore */
  }

  pruneInactiveReminders();
}

export function listReminders(): string {
  const pruned = pruneInactiveReminders();
  const list = loadRecords()
    .filter((r) => r.fireAt > Date.now())
    .sort((a, b) => a.fireAt - b.fireAt);
  if (!list.length) {
    return pruned > 0
      ? `Активных напоминаний нет (снято неактуальных: ${pruned}).`
      : "Активных напоминаний нет.";
  }
  const lines = list.map((r, i) => `${i + 1}. «${r.message}» — ${formatWhen(r.fireAt)}`);
  const head = pruned > 0 ? `Снято неактуальных: ${pruned}. ` : "";
  return `${head}Активные:\n${lines.join("\n")}`;
}

export function cancelReminder(opts: {
  id?: string;
  message_contains?: string;
}): string {
  pruneInactiveReminders();
  const id = opts.id?.trim();
  const needle = opts.message_contains?.trim().toLowerCase();
  if (!id && !needle) return "Need id or message_contains.";

  const list = loadRecords();
  const before = list.length;
  const keep = list.filter((r) => {
    if (id && r.id === id) {
      disarm(r.id);
      return false;
    }
    if (needle && r.message.toLowerCase().includes(needle)) {
      disarm(r.id);
      return false;
    }
    return true;
  });
  const removed = before - keep.length;
  if (!removed) return "Совпадений не найдено.";
  saveRecords(keep);
  return `Удалено напоминаний: ${removed}.`;
}

function watchRemindersFile(): void {
  const file = remindersFile();
  try {
    fs.watch(file, () => {
      if (watchBusy) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        if (!isDeliveryHost()) return;
        watchBusy = true;
        try {
          armAllPending();
          deliverOpts?.onRemindersChanged?.();
        } finally {
          watchBusy = false;
        }
      }, 80);
    });
  } catch (e) {
    logError("reminder.watch", e);
  }
}

export function configureReminders(opts: DeliverOpts): void {
  deliverOpts = opts;
  armAllPending();
  watchRemindersFile();
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = setInterval(() => pruneExpiredReminders(), PRUNE_INTERVAL_MS);
  opts.onRemindersChanged?.();
}

export function scheduleReminder(message: string, opts: ScheduleWhenOpts): string {
  const text = String(message ?? "").trim();
  if (!text) return "Need reminder message.";

  const resolved = resolveFireAt(opts);
  if (typeof resolved === "string") return resolved;

  pruneInactiveReminders();
  const fireAt = resolved;
  const id = `r-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const record: ReminderRecord = { id, message: text, fireAt };
  const list = loadRecords();
  list.push(record);
  saveRecords(list);
  if (isDeliveryHost()) {
    armOne(record);
  }

  const when = formatWhen(fireAt);
  return (
    `Напоминание на ${when}: «${text}». ` +
    "В HUD появится сообщение; если окно скрыто или не в фокусе — всплывёт уведомление Windows."
  );
}
