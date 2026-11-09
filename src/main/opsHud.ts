import fs from "fs";
import os from "os";
import path from "path";
import { getBrainMode } from "./brainMode";
import { isSelfHealing } from "./selfHeal";
import { projectRoot } from "./tools/allowlist";
import { isSttReady, sttLoadState } from "./voice/stt";
import { piperAssetState, voiceProviderSummary } from "./voice/voiceOps";

export type OpsJob = {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
  startedAt: number;
  progress?: number;
  progressLabel?: string;
};

export type OpsAsset = {
  id: string;
  label: string;
  bytes: number;
  expectedBytes: number;
  ready: boolean;
  active: boolean;
};

export type OpsSnapshot = {
  at: number;
  host: string;
  ramUsedPct: number;
  ramFreeGb: number;
  uptimeMin: number;
  brainMode: "cursor" | "local";
  selfHealing: boolean;
  voice: { provider: string; piperReady: boolean; detail: string };
  stt: { state: "idle" | "loading" | "ready"; model: string };
  jobs: OpsJob[];
  assets: OpsAsset[];
  setupScript?: { label: string; pct: number; detail: string; at: string } | null;
};

let notify: (() => void) | null = null;
const jobs = new Map<string, OpsJob>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastFingerprint = "";

const MODEL_TARGETS: { id: string; label: string; file: string; expected: number }[] = [
  {
    id: "piper-exe",
    label: "Piper (движок)",
    file: "piper/piper.exe",
    expected: 400_000,
  },
  {
    id: "piper-en",
    label: "Голос EN (британский)",
    file: "en_GB-northern_english_male-medium.onnx",
    expected: 63_200_000,
  },
  {
    id: "piper-ru",
    label: "Голос RU (Ruslan)",
    file: "ru_RU-ruslan-medium.onnx",
    expected: 63_200_000,
  },
];

function fileSizeSafe(p: string): number {
  try {
    if (!fs.existsSync(p)) return 0;
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function readSetupProgress(): OpsSnapshot["setupScript"] {
  const p = path.join(projectRoot(), "data", "voice", "piper", "setup-progress.json");
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      label?: string;
      pct?: number;
      detail?: string;
      at?: string;
    };
    const ageMs = Date.now() - new Date(String(raw.at || 0)).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 30 * 60_000) return null;
    return {
      label: String(raw.label || "Установка Piper"),
      pct: Math.max(0, Math.min(100, Number(raw.pct) || 0)),
      detail: String(raw.detail || ""),
      at: String(raw.at || ""),
    };
  } catch {
    return null;
  }
}

function probeAssets(prev?: OpsAsset[]): OpsAsset[] {
  const base = path.join(projectRoot(), "data", "voice", "piper");
  const prevMap = new Map((prev || []).map((a) => [a.id, a]));
  return MODEL_TARGETS.map((m) => {
    const full = path.join(base, m.file);
    const bytes = fileSizeSafe(full);
    const ready = bytes >= m.expected * 0.92;
    const was = prevMap.get(m.id)?.bytes ?? 0;
    const active = !ready && bytes > 0 && bytes < m.expected && bytes >= was;
    return {
      id: m.id,
      label: m.label,
      bytes,
      expectedBytes: m.expected,
      ready,
      active: active || (!ready && bytes > was),
    };
  });
}

function fingerprint(s: OpsSnapshot): string {
  return JSON.stringify({
    jobs: s.jobs.map((j) => `${j.id}:${j.status}:${j.progress ?? ""}`),
    assets: s.assets.map((a) => `${a.id}:${a.bytes}:${a.active}`),
    setup: s.setupScript?.pct,
    stt: s.stt.state,
    heal: s.selfHealing,
    voice: s.voice.detail,
    ram: Math.floor(s.ramUsedPct),
  });
}

export function configureOpsHud(opts: { onChange: () => void }): void {
  notify = opts.onChange;
}

export function startOpsHudPolling(intervalMs = 1800): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    const snap = getOpsSnapshot();
    const fp = fingerprint(snap);
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      notify?.();
    }
  }, intervalMs);
}

export function stopOpsHudPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

export function opsBegin(id: string, label: string, detail = ""): void {
  jobs.set(id, {
    id,
    label,
    detail,
    status: "running",
    startedAt: Date.now(),
  });
  notify?.();
}

export function opsProgress(id: string, pct: number, progressLabel?: string): void {
  const j = jobs.get(id);
  if (!j || j.status !== "running") return;
  j.progress = Math.max(0, Math.min(100, pct));
  if (progressLabel) j.progressLabel = progressLabel;
  notify?.();
}

export function opsEnd(id: string, ok = true, detail?: string): void {
  const j = jobs.get(id);
  if (!j) return;
  j.status = ok ? "done" : "error";
  if (detail) j.detail = detail;
  j.progress = ok ? 100 : j.progress;
  notify?.();
  setTimeout(() => {
    const cur = jobs.get(id);
    if (cur?.status === "done") jobs.delete(id);
    notify?.();
  }, 12_000);
}

let lastAssets: OpsAsset[] = [];

export function getOpsSnapshot(): OpsSnapshot {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = ((total - free) / total) * 100;
  const voice = voiceProviderSummary();
  const piper = piperAssetState();
  lastAssets = probeAssets(lastAssets);

  const activeJobs = [...jobs.values()].filter((j) => j.status === "running");
  const recentDone = [...jobs.values()]
    .filter((j) => j.status !== "running")
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 2);

  const sttState = sttLoadState();

  return {
    at: Date.now(),
    host: os.hostname(),
    ramUsedPct: Math.round(usedPct * 10) / 10,
    ramFreeGb: Math.round((free / 1e9) * 10) / 10,
    uptimeMin: Math.floor(os.uptime() / 60),
    brainMode: getBrainMode(),
    selfHealing: isSelfHealing(),
    voice: {
      provider: voice.provider,
      piperReady: piper.ready,
      detail: voice.detail,
    },
    stt: {
      state: isSttReady() ? "ready" : sttState === "loading" ? "loading" : "idle",
      model: voice.sttModel || "Xenova/whisper-base",
    },
    jobs: [...activeJobs, ...recentDone],
    assets: lastAssets,
    setupScript: readSetupProgress(),
  };
}

export function touchOpsHud(): void {
  lastFingerprint = "";
  notify?.();
}
