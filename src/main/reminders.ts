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

type DeliverOpts = {
  sendHud: (text: string) => void;
  hudVisible: () => boolean;
  hudFocused: () => boolean;
  speak?: (text: string) => Promise<void>;
  isMuted?: () => boolean;
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
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
}

export function scheduleReminder(
  message: string,
  opts: { inMinutes?: number; inSeconds?: number }
): string {
  const text = String(message ?? "").trim();
  if (!text) return "Need reminder message.";

  let delayMs = 0;
  if (opts.inSeconds !== undefined && Number.isFinite(opts.inSeconds)) {
    delayMs = Math.max(3, opts.inSeconds) * 1000;
  } else if (opts.inMinutes !== undefined && Number.isFinite(opts.inMinutes)) {
    delayMs = Math.max(0.05, opts.inMinutes) * 60 * 1000;
  } else {
    return "Set in_minutes or in_seconds.";
  }

  const cap = 30 * 24 * 60 * 60 * 1000;
  if (delayMs > cap) delayMs = cap;

  pruneInactiveReminders();
  const fireAt = Date.now() + delayMs;
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
