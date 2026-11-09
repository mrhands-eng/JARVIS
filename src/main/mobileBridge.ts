import http from "http";
import fs from "fs";
import path from "path";
import { askJarvis } from "./brain";
import { getBrainMode } from "./brainMode";
import { projectRoot } from "./tools/allowlist";
import { logError, logInfo } from "./logger";

export type MobileBridgeConfig = {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
};

let server: http.Server | null = null;

function loadConfig(): MobileBridgeConfig {
  const file = path.join(projectRoot(), "config", "mobile.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MobileBridgeConfig>;
    return {
      enabled: raw.enabled !== false,
      host: String(raw.host ?? "0.0.0.0"),
      port: Number(raw.port ?? 8765),
      token: String(raw.token ?? "stark-jarvis-mobile"),
    };
  } catch {
    return { enabled: true, host: "0.0.0.0", port: 8765, token: "stark-jarvis-mobile" };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

export function startMobileBridge(): void {
  const cfg = loadConfig();
  if (!cfg.enabled || server) return;

  server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          });
          res.end();
          return;
        }

        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

        if (req.method === "GET" && url.pathname === "/v1/health") {
          json(res, 200, {
            ok: true,
            brain: getBrainMode(),
            version: "stark-os-mobile-bridge-1",
          });
          return;
        }

        if (req.method === "POST" && url.pathname === "/v1/chat") {
          const raw = await readBody(req);
          let payload: { text?: string; token?: string };
          try {
            payload = JSON.parse(raw) as { text?: string; token?: string };
          } catch {
            json(res, 400, { error: "invalid_json" });
            return;
          }
          if (payload.token !== cfg.token) {
            json(res, 401, { error: "invalid_token" });
            return;
          }
          const text = String(payload.text ?? "").trim();
          if (!text) {
            json(res, 400, { error: "empty_text" });
            return;
          }
          const answer = await askJarvis(text);
          json(res, 200, { answer });
          return;
        }

        json(res, 404, { error: "not_found" });
      } catch (e) {
        logError("mobileBridge.request", e);
        json(res, 500, { error: "server_error" });
      }
    })();
  });

  server.listen(cfg.port, cfg.host, () => {
    logInfo("mobileBridge", `listening on ${cfg.host}:${cfg.port}`);
  });
  server.on("error", (e) => logError("mobileBridge.listen", e));
}

export function stopMobileBridge(): void {
  if (!server) return;
  server.close();
  server = null;
}
