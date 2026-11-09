import { execFile, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { cursorProjectsRoot, loadAllowlist, projectRoot, resolveAppPath } from "./allowlist";

const execFileAsync = promisify(execFile);

export type ConfirmFn = (message: string) => Promise<boolean>;

let confirmFn: ConfirmFn = async () => false;
/** Ask Electron parent to relaunch (brain runs in a forked Node worker). */
let restartRequest: (() => void) | null = null;

export function setConfirmHandler(fn: ConfirmFn): void {
  confirmFn = fn;
}

export function setRestartRequest(fn: () => void): void {
  restartRequest = fn;
}

export async function requestConfirm(message: string): Promise<boolean> {
  try {
    const { shouldAutoConfirmRebuild } = await import("../selfHeal");
    if (
      shouldAutoConfirmRebuild() &&
      /перезапустить|пересобрать|rebuild|jarvis/i.test(message)
    ) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return confirmFn(message);
}

export async function getSystemStatus(): Promise<string> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedPct = (((totalMem - freeMem) / totalMem) * 100).toFixed(1);
  const cpus = os.cpus();
  const load = os.loadavg?.() ?? [0, 0, 0];

  let diskC = "n/a";
  let diskD = "n/a";
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-PSDrive C,D | Select-Object Name,@{N='FreeGB';E={[math]::Round($_.Free/1GB,1)}},@{N='UsedGB';E={[math]::Round($_.Used/1GB,1)}} | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, timeout: 15000 }
    );
    diskC = stdout.trim();
    diskD = diskC;
  } catch {
    /* ignore */
  }

  const top = await getTopProcesses(8);

  return [
    `Host: ${os.hostname()} | ${os.release()} | uptime ${Math.floor(os.uptime() / 60)} min`,
    `CPU: ${cpus[0]?.model ?? "unknown"} × ${cpus.length} (load ${load.map((value) => value.toFixed(2)).join(", ")})`,
    `RAM: ${usedPct}% used (${(freeMem / 1e9).toFixed(1)} GB free of ${(totalMem / 1e9).toFixed(1)} GB)`,
    `Disks: ${diskC}`,
    `Top processes:\n${top}`,
  ].join("\n");
}

async function getTopProcesses(limit: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First ${limit} Name,@{N='MB';E={[math]::Round($_.WorkingSet64/1MB)}} | ForEach-Object { \"$($_.Name) $($_.MB)MB\" }`,
      ],
      { windowsHide: true, timeout: 15000 }
    );
    return stdout.trim() || "(none)";
  } catch {
    return "(unavailable)";
  }
}

export async function openApp(appKey: string): Promise<string> {
  const resolved = resolveAppPath(appKey);
  if (!resolved) {
    const keys = Object.keys(loadAllowlist().apps).join(", ");
    return `Unknown or missing app '${appKey}'. Allowlisted: ${keys}`;
  }
  const { entry, exe } = resolved;
  spawn(exe, entry.args ?? [], { detached: true, stdio: "ignore" }).unref();
  try {
    const { bumpHabit } = await import("../memory/store");
    bumpHabit({ app: appKey, intent: `open:${appKey}` });
  } catch {
    /* memory optional at boot */
  }
  return `Launched ${entry.label} (${exe}).`;
}

/** Open http(s) URL in Zen (preferred) or default browser. */
export async function openUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return "Invalid URL.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only http/https URLs are allowed.";
  }
  const url = parsed.toString();
  const zen = resolveAppPath("zen");
  if (zen) {
    spawn(zen.exe, [url], { detached: true, stdio: "ignore" }).unref();
    return `Opened in Zen: ${url}`;
  }
  spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return `Opened in default browser: ${url}`;
}

export async function openPath(target: string): Promise<string> {
  const list = loadAllowlist();
  const root = path.resolve(list.projectsRoot);
  const abs = path.resolve(target);
  if (!abs.toLowerCase().startsWith(root.toLowerCase()) && !abs.toLowerCase().startsWith("d:\\projects\\cursorprojects")) {
    return `Refused: path must be under ${root}`;
  }
  if (!fs.existsSync(abs)) return `Path not found: ${abs}`;
  spawn("explorer.exe", [abs], { detached: true, stdio: "ignore" }).unref();
  return `Opened ${abs}`;
}

function userProfileDir(): string {
  return process.env.USERPROFILE || os.homedir();
}

function isAllowedParentDir(abs: string): boolean {
  const p = path.resolve(abs).toLowerCase();
  const home = path.resolve(userProfileDir()).toLowerCase();
  if (p === home || p.startsWith(home + path.sep)) return true;
  // Any folder on secondary drives D:…Z: (typical data disks on this PC)
  if (/^[d-z]:\\/.test(p) || /^[d-z]:$/.test(p)) return true;
  const projects = path.resolve(loadAllowlist().projectsRoot || "D:\\Projects").toLowerCase();
  if (p === projects || p.startsWith(projects + path.sep)) return true;
  return false;
}

function resolveFolderBase(where: string): { base: string; label: string } | { error: string } {
  const raw = String(where || "desktop").trim();
  const key = raw.toLowerCase();
  const home = userProfileDir();
  const map: Record<string, { base: string; label: string }> = {
    desktop: {
      base: path.join(home, "Desktop"),
      label: "Desktop",
    },
    documents: {
      base: path.join(home, "Documents"),
      label: "Documents",
    },
    downloads: {
      base: path.join(home, "Downloads"),
      label: "Downloads",
    },
    projects: {
      base: loadAllowlist().projectsRoot || "D:\\Projects",
      label: "Projects",
    },
    cursor_projects: {
      base: cursorProjectsRoot(),
      label: "CursorProjects",
    },
    cursorprojects: {
      base: cursorProjectsRoot(),
      label: "CursorProjects",
    },
    cursor: {
      base: cursorProjectsRoot(),
      label: "CursorProjects",
    },
  };
  // OneDrive Desktop redirect common on Windows
  if (key === "desktop") {
    const od = path.join(home, "OneDrive", "Desktop");
    if (fs.existsSync(od)) return { base: od, label: "Desktop (OneDrive)" };
  }
  if (map[key]) return map[key]!;

  // Drive root or path: D: / D:\ / D:\Foo / «диск D»
  const driveOnly = raw.match(/^([a-zA-Z])\s*:?\s*$/);
  const drivePath = raw.match(/^([a-zA-Z])\s*:[\\/]?(.*)$/);
  if (driveOnly || drivePath) {
    const letter = (driveOnly?.[1] || drivePath?.[1] || "D").toUpperCase();
    const rest = (drivePath?.[2] || "").replace(/\//g, "\\").replace(/^\\+/, "");
    const base = rest ? path.resolve(`${letter}:\\${rest}`) : path.resolve(`${letter}:\\`);
    if (!isAllowedParentDir(base)) {
      return { error: `Refused location «${raw}» — only user profile or D:–Z: data drives.` };
    }
    return { base, label: base };
  }

  // Absolute Windows path
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    const base = path.resolve(raw);
    if (!isAllowedParentDir(base)) {
      return { error: `Refused path «${raw}».` };
    }
    return { base, label: base };
  }

  return {
    error:
      `Unknown location «${where}». Use: desktop | documents | downloads | projects | D:\\ | D:\\Folder`,
  };
}

function sanitizeFolderName(name: string): string | null {
  let n = String(name || "").trim();
  n = n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
  n = n.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!n || n === "." || n === "..") return null;
  if (n.length > 80) n = n.slice(0, 80).trim();
  return n;
}

/**
 * Create an empty folder under an allowed parent (profile shortcuts or D:–Z: paths).
 * `where` must be provided by the model from user intent — no silent Desktop default.
 */
export async function createFolder(opts: {
  name: string;
  where?: string;
  open?: boolean;
}): Promise<string> {
  const name = sanitizeFolderName(opts.name);
  if (!name) return "Refused: empty or invalid folder name.";
  const where = String(opts.where || "").trim();
  if (!where) {
    return "Refused: where is required (infer drive/path from the user request).";
  }
  const loc = resolveFolderBase(where);
  if ("error" in loc) return loc.error;
  if (!fs.existsSync(loc.base)) {
    try {
      fs.mkdirSync(loc.base, { recursive: true });
    } catch (e) {
      return `Base folder missing and could not create ${loc.base}: ${(e as Error).message}`;
    }
  }
  const abs = path.join(loc.base, name);
  const resolved = path.resolve(abs);
  const baseResolved = path.resolve(loc.base);
  if (!resolved.toLowerCase().startsWith(baseResolved.toLowerCase() + path.sep) && resolved.toLowerCase() !== baseResolved.toLowerCase()) {
    return "Refused: path escape blocked.";
  }
  try {
    if (fs.existsSync(resolved)) {
      const st = fs.statSync(resolved);
      if (!st.isDirectory()) return `Exists but is not a folder: ${resolved}`;
      if (opts.open !== false) {
        spawn("explorer.exe", [resolved], { detached: true, stdio: "ignore" }).unref();
      }
      return `Already exists: ${resolved}`;
    }
    fs.mkdirSync(resolved, { recursive: false });
  } catch (e) {
    return `Create failed: ${(e as Error).message}`;
  }
  try {
    const { bumpHabit } = await import("../memory/store");
    bumpHabit({ intent: `mkdir:${name}` });
  } catch {
    /* optional */
  }
  if (opts.open !== false) {
    spawn("explorer.exe", [resolved], { detached: true, stdio: "ignore" }).unref();
  }
  return `Created folder on ${loc.label}: ${resolved}`;
}

export async function listProjects(): Promise<string> {
  const root = loadAllowlist().projectsRoot;
  if (!fs.existsSync(root)) return `Projects root missing: ${root}`;
  const lines: string[] = [];
  for (const dir of [root, path.join(root, "CursorProjects")]) {
    if (!fs.existsSync(dir)) continue;
    const kids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
    lines.push(`${dir}:`);
    for (const k of kids.slice(0, 40)) lines.push(`  - ${k.name}`);
  }
  return lines.join("\n") || "No projects found.";
}

export async function setVolume(percent: number): Promise<string> {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  // Uses Windows Audio Session via PowerShell + Win32 (nircmd-free approach)
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF740782BAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int n1(); int n2(); int GetChannelCount(out uint pc);
  int SetMasterVolumeLevel(float a, System.Guid b);
  int SetMasterVolumeLevelScalar(float f, System.Guid g);
  int GetMasterVolumeLevel(out float pf);
  int GetMasterVolumeLevelScalar(out float pf);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int cls, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int n(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
"@
$enum = New-Object MMDeviceEnumeratorCom
[IMMDeviceEnumerator]$i = $enum
[IMMDevice]$dev = $null
$i.GetDefaultAudioEndpoint(0, 0, [ref]$dev) | Out-Null
$iid = [Guid]"5CDF2C82-841E-4546-9722-0CF740782BAF"
$o = $null
$dev.Activate([ref]$iid, 1, [IntPtr]::Zero, [ref]$o) | Out-Null
[IAudioEndpointVolume]$vol = $o
$vol.SetMasterVolumeLevelScalar(($percent / 100.0), [Guid]::Empty) | Out-Null
"OK $percent"
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", script.replace("$percent", String(p))],
      { windowsHide: true, timeout: 20000 }
    );
    return `Volume set to ${p}% (${stdout.trim()})`;
  } catch (e) {
    return `Volume change failed: ${(e as Error).message}`;
  }
}

export async function focusWindow(titleSubstring: string): Promise<string> {
  const safe = titleSubstring.replace(/'/g, "''");
  const script = `
$p = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -match '${safe}' } | Select-Object -First 1
if (-not $p) { 'NO_MATCH'; exit 0 }
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
[void][W]::ShowWindow($p.MainWindowHandle, 9)
[void][W]::SetForegroundWindow($p.MainWindowHandle)
"FOCUSED $($p.MainWindowTitle)"
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { windowsHide: true, timeout: 15000 }
    );
    return stdout.trim();
  } catch (e) {
    return `Focus failed: ${(e as Error).message}`;
  }
}

export async function gameMode(): Promise<string> {
  const ok = await confirmFn(
    "Enable game mode? This will attempt to close allowlisted non-game apps (Discord/browser/Telegram). Confirm?"
  );
  if (!ok) return "Game mode cancelled.";
  const names = loadAllowlist().gameModeClose;
  const closed: string[] = [];
  for (const name of names) {
    try {
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-Command", `Get-Process -Name '${name.replace(/'/g, "")}' -ErrorAction SilentlyContinue | Stop-Process -Force`],
        { windowsHide: true, timeout: 10000 }
      );
      closed.push(name);
    } catch {
      /* ignore */
    }
  }
  return `Game mode: closed ${closed.join(", ") || "nothing running"}. Defender untouched.`;
}

/**
 * Compile TypeScript + copy renderer assets. Optionally relaunch Electron
 * so self-edits take effect. Restart always asks the user to confirm.
 */
export async function rebuildJarvis(restart = true): Promise<string> {
  const root = projectRoot();
  const { opsBegin, opsEnd, opsProgress } = await import("../opsHud");
  opsBegin("rebuild", "Сборка JARVIS", "tsc + static");
  opsProgress("rebuild", 15, "TypeScript…");
  try {
    await execFileAsync("npx", ["tsc"], {
      cwd: root,
      windowsHide: true,
      timeout: 120000,
      shell: true,
    });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    opsEnd("rebuild", false, "tsc failed");
    return `Build failed (tsc): ${err.stderr || err.message || String(e)}`;
  }
  opsProgress("rebuild", 55, "Копирование HUD…");
  try {
    await execFileAsync("node", ["scripts/copy-static.js"], {
      cwd: root,
      windowsHide: true,
      timeout: 30000,
      shell: true,
    });
  } catch (e2) {
    opsEnd("rebuild", false, "copy-static failed");
    return `tsc OK, but copy-static failed: ${(e2 as Error).message}`;
  }

  opsProgress("rebuild", 90, restart ? "Готово — перезапуск…" : "Готово");

  if (!restart) {
    opsEnd("rebuild", true);
    return "Build OK (tsc + static). Restart JARVIS later to load main-process changes.";
  }

  const ok = await confirmFn(
    "Пересобрать JARVIS уже готово. Перезапустить приложение сейчас, чтобы применить изменения?"
  );
  if (!ok) {
    opsEnd("rebuild", true);
    return "Build OK. Restart cancelled — changes apply after you relaunch JARVIS.";
  }

  if (!restartRequest) {
    opsEnd("rebuild", true);
    return "Build OK, but restart bridge missing — relaunch JARVIS manually.";
  }
  opsEnd("rebuild", true);
  restartRequest();
  return "Build OK. Restarting JARVIS now…";
}

export async function minimizeOthersKeep(keepTitle: string): Promise<string> {
  const ok = await confirmFn(
    `Minimize other windows and keep focus on windows matching "${keepTitle}"?`
  );
  if (!ok) return "Cancelled.";
  const safe = keepTitle.replace(/'/g, "''");
  const script = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lp, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$keep = $null
[W]::EnumWindows({
  param($h,$l)
  if (-not [W]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][W]::GetWindowText($h, $sb, $sb.Capacity)
  $t = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($t)) { return $true }
  if ($t -match '${safe}') { $script:keep = $h } else { [void][W]::ShowWindow($h, 6) }
  $true
}, [IntPtr]::Zero) | Out-Null
if ($keep) { [void][W]::ShowWindow($keep, 9); [void][W]::SetForegroundWindow($keep); "OK" } else { "NO_KEEP_WINDOW" }
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { windowsHide: true, timeout: 20000 }
    );
    return stdout.trim();
  } catch (e) {
    return `Failed: ${(e as Error).message}`;
  }
}
