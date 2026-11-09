import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const BLOCK = [
  /format\s+[a-z]:/i,
  /shutdown/i,
  /restart-computer/i,
  /stop-computer/i,
  /rmdir\s+\/s/i,
  /del\s+\/s/i,
  /Remove-Item\s+.*-Recurse/i,
  /Disable-WindowsOptionalFeature/i,
  /Set-MpPreference/i,
  /TamperProtection/i,
  /defender/i,
  /bcdedit/i,
  /diskpart/i,
  /reg\s+delete/i,
  /net\s+user/i,
  /Start-Process\s+.*-Verb\s+RunAs/i,
  /runas/i,
];

export function isBlockedCommand(cmd: string): string | null {
  for (const re of BLOCK) {
    if (re.test(cmd)) return `Blocked pattern: ${re}`;
  }
  return null;
}

/** Non-elevated PowerShell one-liner with timeout. Caller must confirm. */
export async function runUserCommand(command: string): Promise<string> {
  const cmd = String(command || "").trim();
  if (!cmd) return "Empty command.";
  if (cmd.length > 2000) return "Command too long.";
  const blocked = isBlockedCommand(cmd);
  if (blocked) return `Refused: ${blocked}`;

  const { opsBegin, opsEnd } = await import("../opsHud");
  const short = cmd.length > 48 ? `${cmd.slice(0, 45)}…` : cmd;
  opsBegin("shell", "Команда на ПК", short);

  try {
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", cmd],
      { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 512 }
    );
    const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    opsEnd("shell", true);
    return out.slice(0, 4000) || "(no output)";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    opsEnd("shell", false);
    return `Command failed: ${err.stderr || err.message || String(e)}\n${err.stdout || ""}`.slice(0, 4000);
  }
}
