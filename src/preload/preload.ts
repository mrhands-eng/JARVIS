import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvis", {
  askText: (text: string) => ipcRenderer.invoke("ask-text", text) as Promise<string>,
  stopTask: () => ipcRenderer.invoke("stop-task") as Promise<string>,
  setMute: (value: boolean) => ipcRenderer.invoke("set-mute", value) as Promise<boolean>,
  onStopTaskHotkey: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("stop-task-hotkey", handler);
    return () => ipcRenderer.removeListener("stop-task-hotkey", handler);
  },
  /** Local STT: WAV (PCM) as base64 → { text, peak, rms, durationSec, … }. */
  transcribeWav: (base64: string) =>
    ipcRenderer.invoke("transcribe-wav", base64) as Promise<{
      text: string;
      peak?: number;
      rms?: number;
      durationSec?: number;
      language?: string;
      model?: string;
    }>,
  sttReady: () => ipcRenderer.invoke("stt-ready") as Promise<boolean>,
  /** Speak brief fault + optional autonomous self-repair. */
  reportFault: (payload: { source: string; error: string; autoFix?: boolean }) =>
    ipcRenderer.invoke("report-fault", payload) as Promise<boolean>,
  getConfig: () =>
    ipcRenderer.invoke("get-config") as Promise<{
      palette: Record<string, string>;
      hotkeys: Record<string, string>;
      muted: boolean;
      brainMode: "cursor" | "local";
    }>,
  getBrainMode: () => ipcRenderer.invoke("get-brain-mode") as Promise<"cursor" | "local">,
  setBrainMode: (mode: "cursor" | "local") =>
    ipcRenderer.invoke("set-brain-mode", mode) as Promise<"cursor" | "local">,
  onBrainModeChanged: (cb: (mode: "cursor" | "local") => void) => {
    const handler = (_: unknown, mode: "cursor" | "local") => cb(mode);
    ipcRenderer.on("brain-mode-changed", handler);
    return () => ipcRenderer.removeListener("brain-mode-changed", handler);
  },
  confirmResponse: (ok: boolean) => ipcRenderer.invoke("confirm-response", ok),
  onPtt: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("ptt", handler);
    return () => ipcRenderer.removeListener("ptt", handler);
  },
  onBrainEvent: (cb: (ev: unknown) => void) => {
    const handler = (_: unknown, ev: unknown) => cb(ev);
    ipcRenderer.on("brain-event", handler);
    return () => ipcRenderer.removeListener("brain-event", handler);
  },
  onConfirmRequest: (cb: (message: string) => void) => {
    const handler = (_: unknown, message: string) => cb(message);
    ipcRenderer.on("confirm-request", handler);
    return () => ipcRenderer.removeListener("confirm-request", handler);
  },
  onConfirmResolved: (cb: (ok: boolean) => void) => {
    const handler = (_: unknown, ok: boolean) => cb(ok);
    ipcRenderer.on("confirm-resolved", handler);
    return () => ipcRenderer.removeListener("confirm-resolved", handler);
  },
  onMuteChanged: (cb: (muted: boolean) => void) => {
    const handler = (_: unknown, muted: boolean) => cb(muted);
    ipcRenderer.on("mute-changed", handler);
    return () => ipcRenderer.removeListener("mute-changed", handler);
  },
  onPlayAudio: (cb: (payload: { mime: string; base64: string }) => void) => {
    const handler = (_: unknown, payload: { mime: string; base64: string }) => cb(payload);
    ipcRenderer.on("play-audio", handler);
    return () => ipcRenderer.removeListener("play-audio", handler);
  },
  onStopAudio: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("stop-audio", handler);
    return () => ipcRenderer.removeListener("stop-audio", handler);
  },
});
