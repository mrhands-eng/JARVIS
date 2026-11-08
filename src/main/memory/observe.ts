import { execFile } from "child_process";
import { promisify } from "util";
import { appendNote, bumpHabit } from "./store";

const execFileAsync = promisify(execFile);

/** Snapshot of what is happening on the PC right now — stored locally via caller. */
export async function observePc(): Promise<string> {
  const parts: string[] = [];
  const now = new Date();
  parts.push(`Local time: ${now.toLocaleString("ru-RU")}`);

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 15 ProcessName,MainWindowTitle | ForEach-Object { \"$($_.ProcessName) | $($_.MainWindowTitle)\" }",
      ],
      { windowsHide: true, timeout: 15000 }
    );
    const wins = stdout.trim() || "(no titled windows)";
    parts.push("Open windows:\n" + wins);
    for (const line of wins.split(/\r?\n/).slice(0, 8)) {
      const name = line.split("|")[0]?.trim();
      if (name) bumpHabit({ app: name });
    }
  } catch {
    parts.push("Open windows: unavailable");
  }

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 8 Name,@{N='MB';E={[math]::Round($_.WorkingSet64/1MB)}} | ForEach-Object { \"$($_.Name) $($_.MB)MB\" }",
      ],
      { windowsHide: true, timeout: 15000 }
    );
    parts.push("Top RAM:\n" + (stdout.trim() || "(n/a)"));
  } catch {
    parts.push("Top RAM: unavailable");
  }

  appendNote({
    kind: "episode",
    text: `PC observe @ ${now.toLocaleString("ru-RU")}: windows sampled`,
    tags: ["observe"],
  });

  return parts.join("\n\n");
}
