/**
 * Runs outside Electron (plain Node). @cursor/sdk crashes inside Electron main
 * with "Cannot access 'n' before initialization".
 */
import {
  askJarvis,
  cancelActiveRun,
  disposeBrain,
  ensureBrain,
  onBrainEvent,
  setConfirmBridge,
} from "./brain-core";
import { logError, logInfo } from "./logger";
import { requestCancel } from "./taskControl";
import { setRestartRequest } from "./tools/actions";

type InMsg =
  | { type: "ping"; id: string }
  | { type: "warm"; id: string }
  | { type: "ask"; id: string; text: string }
  | { type: "cancel"; id: string }
  | { type: "dispose"; id: string }
  | { type: "confirm-result"; id: string; ok: boolean };

type OutMsg =
  | { type: "pong"; id: string }
  | { type: "ok"; id: string }
  | { type: "answer"; id: string; text: string }
  | { type: "event"; event: unknown }
  | { type: "confirm"; id: string; message: string }
  | { type: "restart-self" }
  | { type: "error"; id: string; message: string };

const pendingConfirm = new Map<string, (ok: boolean) => void>();
let confirmSeq = 0;

function send(msg: OutMsg): void {
  if (typeof process.send === "function") {
    process.send(msg);
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(msg));
  }
}

setConfirmBridge(
  (message) =>
    new Promise<boolean>((resolve) => {
      const id = `c-${++confirmSeq}`;
      pendingConfirm.set(id, resolve);
      send({ type: "confirm", id, message });
      setTimeout(() => {
        if (pendingConfirm.has(id)) {
          pendingConfirm.delete(id);
          resolve(false);
        }
      }, 120000);
    })
);

setRestartRequest(() => {
  send({ type: "restart-self" });
});

onBrainEvent((event) => {
  send({ type: "event", event });
});

async function handle(msg: InMsg): Promise<void> {
  switch (msg.type) {
    case "ping":
      send({ type: "pong", id: msg.id });
      return;
    case "warm":
      await ensureBrain();
      send({ type: "ok", id: msg.id });
      return;
    case "ask": {
      const text = await askJarvis(msg.text);
      send({ type: "answer", id: msg.id, text });
      return;
    }
    case "cancel": {
      requestCancel();
      await cancelActiveRun();
      // Resolve any open HUD confirms as "no"
      for (const [cid, resolve] of pendingConfirm) {
        pendingConfirm.delete(cid);
        resolve(false);
      }
      send({ type: "ok", id: msg.id });
      return;
    }
    case "dispose":
      await disposeBrain();
      send({ type: "ok", id: msg.id });
      return;
    case "confirm-result": {
      const resolve = pendingConfirm.get(msg.id);
      pendingConfirm.delete(msg.id);
      resolve?.(!!msg.ok);
      return;
    }
    default:
      return;
  }
}

process.on("message", (raw: InMsg) => {
  void handle(raw).catch((err) => {
    logError("brain-worker", err);
    const id = (raw as { id?: string }).id || "unknown";
    send({ type: "error", id, message: (err as Error).message || String(err) });
  });
});

process.on("disconnect", () => {
  void disposeBrain().finally(() => process.exit(0));
});

logInfo("brain-worker", `online pid=${process.pid}`);
send({ type: "ok", id: "boot" });
