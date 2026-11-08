export {};

type JarvisApi = {
  askText: (text: string) => Promise<string>;
  setMute: (value: boolean) => Promise<boolean>;
  getConfig: () => Promise<{ palette: Record<string, string>; hotkeys: Record<string, string>; muted: boolean }>;
  confirmResponse: (ok: boolean) => Promise<unknown>;
  onPtt: (cb: () => void) => () => void;
  onBrainEvent: (cb: (ev: BrainEv) => void) => () => void;
  onConfirmRequest: (cb: (message: string) => void) => () => void;
  onConfirmResolved: (cb: (ok: boolean) => void) => () => void;
  onMuteChanged: (cb: (muted: boolean) => void) => () => void;
};

type BrainEv =
  | { type: "status"; status: "idle" | "thinking" | "error"; detail?: string }
  | { type: "delta"; text: string }
  | { type: "final"; text: string }
  | { type: "tool"; name: string; status: string };

declare global {
  interface Window {
    jarvis: JarvisApi;
  }
}

const api = window.jarvis;
const logEl = document.getElementById("log")!;
const statusEl = document.getElementById("status")!;
const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("input") as HTMLInputElement;
const btnMic = document.getElementById("btnMic") as HTMLButtonElement;
const btnMute = document.getElementById("btnMute") as HTMLButtonElement;
const confirmBox = document.getElementById("confirm")!;
const confirmText = document.getElementById("confirmText")!;
const hud = document.getElementById("hud")!;

let muted = false;
let recognizing = false;

function append(role: "user" | "jarvis" | "system", text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
  (div.querySelector(".body") as HTMLElement).textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div;
}

function setStatus(text: string, cls?: string): void {
  statusEl.textContent = text.toUpperCase();
  statusEl.className = "status" + (cls ? ` ${cls}` : "");
}

async function submitText(text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  append("user", t);
  setStatus("thinking", "thinking");
  const live = append("jarvis", "…");
  try {
    const answer = await api.askText(t);
    (live.querySelector(".body") as HTMLElement).textContent = answer || "(empty)";
    setStatus("online");
  } catch (e) {
    (live.querySelector(".body") as HTMLElement).textContent = String(e);
    setStatus("error", "error");
  }
}

function startListening(): void {
  const w = window as Window & {
    SpeechRecognition?: new () => any;
    webkitSpeechRecognition?: new () => any;
  };
  const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!SR) {
    append("system", "Speech recognition unavailable in this build.");
    return;
  }
  if (recognizing) return;
  const rec = new SR();
  rec.lang = "ru-RU";
  rec.interimResults = true;
  rec.continuous = false;
  recognizing = true;
  hud.classList.add("listening");
  setStatus("listening");
  rec.onresult = (ev: any) => {
    let transcript = "";
    for (let i = 0; i < ev.results.length; i++) {
      transcript += ev.results[i][0].transcript;
    }
    input.value = transcript;
    if (ev.results[ev.results.length - 1].isFinal) {
      void submitText(transcript);
    }
  };
  rec.onerror = (ev: { error: string }) => {
    append("system", `Mic error: ${ev.error}`);
    setStatus("online");
  };
  rec.onend = () => {
    recognizing = false;
    hud.classList.remove("listening");
    if (statusEl.textContent === "LISTENING") setStatus("online");
  };
  try {
    rec.start();
  } catch (e) {
    recognizing = false;
    append("system", String(e));
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = input.value;
  input.value = "";
  void submitText(v);
});

btnMic.addEventListener("click", () => startListening());
btnMute.addEventListener("click", async () => {
  muted = await api.setMute(!muted);
  btnMute.textContent = muted ? "🔇" : "🔊";
});

document.getElementById("btnYes")!.addEventListener("click", () => {
  void api.confirmResponse(true);
  confirmBox.classList.add("hidden");
});
document.getElementById("btnNo")!.addEventListener("click", () => {
  void api.confirmResponse(false);
  confirmBox.classList.add("hidden");
});

api.onPtt(() => startListening());
api.onBrainEvent((ev: BrainEv) => {
  if (ev.type === "status") {
    if (ev.status === "thinking") setStatus(ev.detail || "thinking", "thinking");
    else if (ev.status === "error") setStatus(ev.detail || "error", "error");
    else setStatus(ev.detail || "online");
  } else if (ev.type === "tool") {
    append("system", `tool ${ev.name}: ${ev.status}`);
  }
});
api.onConfirmRequest((message: string) => {
  confirmText.textContent = message;
  confirmBox.classList.remove("hidden");
  setStatus("awaiting confirm", "thinking");
});
api.onConfirmResolved(() => {
  confirmBox.classList.add("hidden");
});
api.onMuteChanged((m: boolean) => {
  muted = m;
  btnMute.textContent = muted ? "🔇" : "🔊";
});

void (async () => {
  const cfg = await api.getConfig();
  muted = cfg.muted;
  btnMute.textContent = muted ? "🔇" : "🔊";
  if (cfg.palette?.cyan) {
    document.documentElement.style.setProperty("--cyan", cfg.palette.cyan);
  }
  setStatus("online");
  append("system", "JARVIS HUD ready. Ctrl+Shift+J = voice · Ctrl+Shift+H = toggle.");
})();
