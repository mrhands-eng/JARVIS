import fs from "fs";
import path from "path";
import { logInfo } from "./logger";
import { projectRoot } from "./tools/allowlist";

export type IdleConfig = {
  startHidden: boolean;
  idleSleepMs: number;
  hideHudOnIdle: boolean;
  disposeBrainOnIdle: boolean;
  stopOllamaOnIdle: boolean;
};

const DEFAULTS: IdleConfig = {
  startHidden: true,
  idleSleepMs: 180_000,
  hideHudOnIdle: true,
  disposeBrainOnIdle: true,
  stopOllamaOnIdle: true,
};

type SleepHooks = {
  hideHud?: () => void;
  disposeBrain?: () => Promise<void> | void;
  stopOllama?: () => Promise<void> | void;
};

let hooks: SleepHooks = {};
let timer: NodeJS.Timeout | null = null;
let sleeping = false;

export function loadIdleConfig(): IdleConfig {
  const file = path.join(projectRoot(), "config", "idle.json");
  try {
    return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<IdleConfig>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function configureIdle(next: SleepHooks): void {
  hooks = next;
}

/** Call on any real user interaction so heavy services stay alive. */
export function noteActivity(reason = "activity"): void {
  sleeping = false;
  const cfg = loadIdleConfig();
  if (timer) clearTimeout(timer);
  timer = null;
  if (cfg.idleSleepMs <= 0) return;
  timer = setTimeout(() => {
    void enterSleep(reason);
  }, cfg.idleSleepMs);
}

async function enterSleep(_from: string): Promise<void> {
  if (sleeping) return;
  sleeping = true;
  const cfg = loadIdleConfig();
  logInfo("idle", `sleep — releasing resources (after ${_from})`);
  if (cfg.hideHudOnIdle) {
    try {
      hooks.hideHud?.();
    } catch {
      /* ignore */
    }
  }
  if (cfg.disposeBrainOnIdle) {
    try {
      await hooks.disposeBrain?.();
    } catch {
      /* ignore */
    }
  }
  if (cfg.stopOllamaOnIdle) {
    try {
      await hooks.stopOllama?.();
    } catch {
      /* ignore */
    }
  }
}

export function isIdleSleeping(): boolean {
  return sleeping;
}
