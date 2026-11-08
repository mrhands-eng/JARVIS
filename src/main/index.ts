import { spawn } from "child_process";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  session,
  Tray,
  screen,
} from "electron";
import fs from "fs";
import path from "path";
import { isCasualTurn, randomAck, startupGreeting } from "./activity";
import {
  askJarvis,
  disposeBrain,
  ensureBrain,
  onBrainEvent,
  setBrainConfirmHandler,
  setBrainRestartHandler,
  stopJarvis,
} from "./brain";
import { getBrainMode, setBrainMode, type BrainMode } from "./brainMode";
import { configureIdle, loadIdleConfig, noteActivity } from "./idle";
import { projectRoot } from "./tools/allowlist";
import { setConfirmHandler } from "./tools/actions";
import {
  configureSelfHeal,
  isSelfHealing,
  reportJarvisFault,
} from "./selfHeal";
import { beginDialogSession, rollCurrentIntoSummary } from "./memory/dialog";
import { isSttReady, transcribeWavBuffer, type SttResult } from "./voice/stt";
import { setAudioHandlers, speak, stopSpeaking } from "./voice/tts";
import { logError, logInfo } from "./logger";
import { configureReminders } from "./reminders";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let muted = false;
let confirmResolver: ((ok: boolean) => void) | null = null;

function hotkeys(): {
  pushToTalk: string;
  toggleHud: string;
  confirmYes: string;
  confirmNo: string;
  stopTask?: string;
} {
  const file = path.join(projectRoot(), "config", "hotkeys.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay().workAreaSize;
  const idle = loadIdleConfig();
  win = new BrowserWindow({
    width: 420,
    height: 520,
    x: display.width - 440,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    show: !idle.startHidden,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.on("context-menu", (_e, params) => {
    Menu.buildFromTemplate([
      { role: "copy", enabled: !!params.selectionText },
      { role: "selectAll" },
      { type: "separator" },
      { role: "paste" },
    ]).popup();
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.on("show", () => noteActivity("hud-show"));
  win.on("closed", () => {
    win = null;
  });
}

function createTray(): void {
  const iconPath = path.join(projectRoot(), "assets", "icon.png");
  const image = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  tray = new Tray(image.isEmpty() ? nativeImage.createFromDataURL(trayPngDataUrl()) : image);
  tray.setToolTip("JARVIS — Stark OS");
  const menu = Menu.buildFromTemplate([
    {
      label: "Show HUD",
      click: () => win?.show(),
    },
    {
      label: "Hide HUD",
      click: () => win?.hide(),
    },
    {
      label: muted ? "Unmute TTS" : "Mute TTS",
      click: () => {
        muted = !muted;
        win?.webContents.send("mute-changed", muted);
        createTray();
      },
    },
    {
      label: "Warm up brain",
      click: () => {
        ensureBrain().catch((e) => win?.webContents.send("brain-event", { type: "status", status: "error", detail: String(e) }));
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      noteActivity("tray");
      win.show();
    }
  });
}

function trayPngDataUrl(): string {
  // Tiny cyan 16x16 PNG
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVQ4T2NkYGD4z0ABYBzVMKoBBg0cNYwGgwYAAAD//wMABf4C/q6zqY0AAAAASUVORK5CYII=";
}

function registerIpc(): void {
  configureIdle({
    hideHud: () => win?.hide(),
    disposeBrain: () => disposeBrain(),
    stopOllama: async () => {
      const { stopJarvisOllama } = await import("./local/ollama");
      await stopJarvisOllama("idle-sleep");
    },
  });

  setAudioHandlers(
    (payload) => win?.webContents.send("play-audio", payload),
    (seq) => win?.webContents.send("stop-audio", { seq })
  );

  configureReminders({
    sendHud: (text) => win?.webContents.send("reminder", { text }),
    hudVisible: () => !!win?.isVisible(),
    hudFocused: () => !!win?.isFocused(),
    speak,
    isMuted: () => muted,
  });

  configureSelfHeal({
    speak,
    ask: (text) => askJarvis(text),
    isMuted: () => muted,
    emit: (ev) => {
      if (ev.type === "status") {
        win?.webContents.send("brain-event", {
          type: "status",
          status: ev.status || "thinking",
          detail: ev.detail,
        });
      } else if (ev.type === "tool") {
        win?.webContents.send("brain-event", {
          type: "tool",
          name: ev.name || "Самолечение…",
          status: ev.status || "running",
        });
      }
    },
  });

  const askConfirm = (message: string) =>
    new Promise<boolean>((resolve) => {
      confirmResolver = resolve;
      win?.show();
      win?.webContents.send("confirm-request", message);
    });

  // Worker (Cursor) + main-process local Ollama tools share the same HUD confirm.
  setBrainConfirmHandler(askConfirm);
  setConfirmHandler(askConfirm);

  setBrainRestartHandler(() => {
    const root = projectRoot();
    const script = path.join(root, "scripts", "restart-jarvis.ps1");
    spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-WaitPid",
        String(process.pid),
        "-Root",
        root,
      ],
      { detached: true, stdio: "ignore", windowsHide: true }
    ).unref();
    setTimeout(() => {
      void disposeBrain().finally(() => app.quit());
    }, 400);
  });

  ipcMain.handle("confirm-response", (_e, ok: boolean) => {
    confirmResolver?.(!!ok);
    confirmResolver = null;
    return true;
  });

  ipcMain.handle("ask-text", async (_e, text: string) => {
    noteActivity("ask");
    const raw = String(text ?? "");
    const casual = isCasualTurn(raw);
    if (casual) {
      // No “Уже занимаюсь” theatre for hellos — only a quiet HUD pulse
      win?.webContents.send("brain-event", {
        type: "status",
        status: "thinking",
        detail: "…",
      });
    } else {
      const ack = randomAck();
      win?.webContents.send("brain-event", {
        type: "status",
        status: "thinking",
        detail: ack,
      });
      // Spoken ack only for real tasks (and not logged as a fake “tool”)
      if (!muted) {
        void speak(ack).catch((e) => logError("tts.ack", e));
      }
    }
    let working = true;
    const keepAlive = setTimeout(() => {
      if (!working || muted || casual) return;
      win?.webContents.send("brain-event", {
        type: "status",
        status: "thinking",
        detail: "Ещё работаю…",
      });
      void speak("Ещё работаю, сэр.").catch((e) => logError("tts.keepalive", e));
    }, 12000);
    try {
      const answer = await askJarvis(raw);
      working = false;
      clearTimeout(keepAlive);
      if (answer?.startsWith("Systems error:")) {
        if (!isSelfHealing()) {
          void reportJarvisFault({ source: "brain", error: answer });
        }
        return answer;
      }
      if (!muted && answer) {
        // HUD gets the text immediately; TTS runs in parallel (speakSeq still preempts stale ack audio).
        void speak(answer).catch((e) => logError("tts.answer", e));
      }
      return answer;
    } catch (e) {
      working = false;
      clearTimeout(keepAlive);
      const msg = (e as Error).message || String(e);
      if (!isSelfHealing()) {
        void reportJarvisFault({ source: "ask-throw", error: msg });
      }
      return `Systems error: ${msg}`;
    }
  });

  ipcMain.handle("set-mute", (_e, value: boolean) => {
    muted = !!value;
    return muted;
  });

  ipcMain.handle("stop-tts", () => {
    stopSpeaking();
    return true;
  });

  ipcMain.handle("stop-task", async () => {
    stopSpeaking();
    confirmResolver?.(false);
    confirmResolver = null;
    win?.webContents.send("confirm-resolved", false);
    const msg = await stopJarvis();
    win?.webContents.send("brain-event", {
      type: "tool",
      name: "Остановлено",
      status: "completed",
    });
    if (!muted) {
      void speak(msg).catch((e) => logError("tts.stop", e));
    }
    return msg;
  });

  ipcMain.handle("transcribe-wav", async (_e, base64: string): Promise<SttResult | { text: string }> => {
    try {
      noteActivity("voice");
      const raw = String(base64 || "");
      if (!raw) return { text: "", peak: 0, rms: 0, mean: 0, durationSec: 0, sampleRate: 0, language: "", model: "" };
      const buf = Buffer.from(raw, "base64");
      if (buf.length < 44) {
        return { text: "", peak: 0, rms: 0, mean: 0, durationSec: 0, sampleRate: 0, language: "", model: "" };
      }
      if (!isSttReady()) {
        win?.webContents.send("brain-event", {
          type: "status",
          status: "thinking",
          detail: "Загружаю голосовую модель…",
        });
      }
      const result = await transcribeWavBuffer(buf);
      logInfo(
        "stt.ipc",
        result.text
          ? `ok ${result.durationSec.toFixed(2)}s «${result.text.slice(0, 80)}»`
          : `empty ${result.durationSec.toFixed(2)}s peak=${result.peak.toFixed(3)} rms=${result.rms.toFixed(3)}`
      );
      return result;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (!isSelfHealing()) {
        void reportJarvisFault({ source: "stt", error: msg });
      }
      return { text: `STT_ERROR:${msg}` };
    }
  });

  ipcMain.handle("stt-ready", () => isSttReady());

  ipcMain.handle(
    "report-fault",
    (_e, payload: { source?: string; error?: string; autoFix?: boolean }) => {
      const error = String(payload?.error || "").trim();
      if (!error) return false;
      void reportJarvisFault({
        source: String(payload?.source || "hud"),
        error,
        autoFix: payload?.autoFix !== false,
      });
      return true;
    }
  );

  ipcMain.handle("get-config", () => {
    const palette = JSON.parse(fs.readFileSync(path.join(projectRoot(), "config", "palette.json"), "utf8"));
    return { palette, hotkeys: hotkeys(), muted, brainMode: getBrainMode() };
  });

  ipcMain.handle("get-brain-mode", () => getBrainMode());

  ipcMain.handle("set-brain-mode", (_e, mode: BrainMode) => {
    noteActivity("brain-mode");
    const next = setBrainMode(mode === "local" ? "local" : "cursor");
    win?.webContents.send("brain-mode-changed", next);
    win?.webContents.send("brain-event", {
      type: "tool",
      name: next === "local" ? "Мозг: локальный (Qwen)" : "Мозг: Cursor",
      status: "completed",
    });
    return next;
  });

  onBrainEvent((ev) => {
    win?.webContents.send("brain-event", ev);
  });
}

function playStartupGreeting(): void {
  if (muted || !win) return;
  const line = startupGreeting();
  win.webContents.send("brain-event", { type: "status", status: "idle", detail: line });
  void speak(line).catch(() => undefined);
}

function scheduleStartupGreeting(): void {
  if (!win) return;
  const run = () => setTimeout(() => playStartupGreeting(), 250);
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", run);
  } else {
    run();
  }
}

function registerShortcuts(): void {
  const hk = hotkeys();
  globalShortcut.register(hk.pushToTalk, () => {
    noteActivity("ptt");
    win?.show();
    win?.webContents.send("ptt");
  });
  globalShortcut.register(hk.toggleHud, () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      noteActivity("toggle-hud");
      win.show();
    }
  });
  globalShortcut.register(hk.confirmYes, () => {
    noteActivity("confirm");
    confirmResolver?.(true);
    confirmResolver = null;
    win?.webContents.send("confirm-resolved", true);
  });
  globalShortcut.register(hk.confirmNo, () => {
    noteActivity("confirm");
    confirmResolver?.(false);
    confirmResolver = null;
    win?.webContents.send("confirm-resolved", false);
  });
  const stopKey = hk.stopTask || "CommandOrControl+Shift+X";
  globalShortcut.register(stopKey, () => {
    noteActivity("stop-hotkey");
    win?.show();
    // Renderer owns the stop IPC so HUD busy/STOP state stays in sync
    win?.webContents.send("stop-task-hotkey");
  });
}

app.setAppUserModelId("com.starkos.jarvis");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });

  app.whenReady().then(() => {
    // Local mic capture (no cloud speech API)
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (permission !== "media") {
        callback(false);
        return;
      }
      const types = "mediaTypes" in details ? details.mediaTypes : undefined;
      if (types && types.length && !types.includes("audio")) {
        callback(false);
        return;
      }
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
      if (permission !== "media") return false;
      const t = details?.mediaType;
      return !t || t === "audio" || t === "unknown";
    });

    if (process.platform === "win32") {
      app.setAppUserModelId("stark-os.jarvis");
    }

    // Enables Ctrl+C / Ctrl+A accelerators for selectable HUD text
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Edit",
          submenu: [
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
      ])
    );
    registerIpc();
    beginDialogSession();
    createWindow();
    scheduleStartupGreeting();
    createTray();
    registerShortcuts();
    // Idle by default: no Whisper warm, no Cursor worker, no Ollama until you talk.
    noteActivity("boot");
    if (loadIdleConfig().startHidden) {
      win?.webContents.send("brain-event", {
        type: "status",
        status: "idle",
        detail: "JARVIS standby (tray)",
      });
    }
  });

  app.on("will-quit", () => {
    try {
      rollCurrentIntoSummary("app-quit");
    } catch {
      /* ignore */
    }
    globalShortcut.unregisterAll();
    void disposeBrain();
    void import("./local/ollama")
      .then(({ stopJarvisOllama }) => stopJarvisOllama("app-quit"))
      .catch(() => undefined);
  });

  app.on("window-all-closed", () => {
    // Keep running in tray
  });
}
