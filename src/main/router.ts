import {
  getSystemStatus,
  listProjects,
  openApp,
  setVolume,
} from "./tools/actions";

const APP_ALIASES: Record<string, string> = {
  cursor: "cursor",
  курсор: "cursor",
  steam: "steam",
  стим: "steam",
  стима: "steam",
  discord: "discord",
  дискорд: "discord",
  zen: "zen",
  зен: "zen",
  браузер: "zen",
  terminal: "terminal",
  терминал: "terminal",
  telegram: "telegram",
  телеграм: "telegram",
  телегу: "telegram",
};

function matchApp(text: string): string | null {
  for (const [alias, key] of Object.entries(APP_ALIASES)) {
    // ASCII-safe boundaries; Cyrillic aliases matched as whole tokens via spaces/start/end
    const re = new RegExp(`(?:^|[\\s,])${alias}(?:$|[\\s,.!?])`, "i");
    if (re.test(` ${text} `)) return key;
  }
  return null;
}

/** Fast local intents — no Cursor roundtrip. Returns null to fall through to JARVIS brain. */
export async function tryLocalIntent(text: string): Promise<string | null> {
  const t = text.trim().toLowerCase().replace(/[«»"']/g, "");

  if (
    /^(статус|status|system status|состояние системы)(\s|$)/i.test(t) ||
    t === "как дела у системы" ||
    t === "статус системы"
  ) {
    const raw = await getSystemStatus();
    return formatStatus(raw);
  }
  if (/^(проекты|list projects|покажи проекты)(\s|$)/i.test(t)) {
    return listProjects();
  }

  // открыть / запустить / start / launch / run
  if (/(открой|открыть|запусти|запустить|start|launch|run|включи)/i.test(t)) {
    const app = matchApp(t);
    if (app) {
      const result = await openApp(app);
      if (result.startsWith("Launched")) {
        const label = app === "steam" ? "Steam" : app;
        return `Запускаю ${label}, сэр.`;
      }
      return result;
    }
  }

  const vol = t.match(/(?:громкость|volume)\s*(\d{1,3})/);
  if (vol) {
    return setVolume(Number(vol[1]));
  }

  return null;
}

function formatStatus(raw: string): string {
  // Keep data but make it less JSON-ugly for HUD/TTS
  return raw
    .replace(/\s+/g, " ")
    .replace(/Disks:\s*\[/, "Disks: ")
    .replace(/\{"Name":"C","FreeGB":([\d.]+),"UsedGB":([\d.]+)\}/, "C free $1 GB / used $2 GB")
    .replace(/,\{"Name":"D","FreeGB":([\d.]+),"UsedGB":([\d.]+)\}/, "; D free $1 GB / used $2 GB")
    .replace(/\]/g, "")
    .trim();
}
