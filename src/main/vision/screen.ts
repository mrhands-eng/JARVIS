import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { logError, logInfo } from "../logger";
import { projectRoot } from "../tools/allowlist";

const execFileAsync = promisify(execFile);

export type ScreenSight = {
  imagePath: string;
  width: number;
  height: number;
  windows: string[];
  ocrText: string;
  summary: string;
};

function logsDir(): string {
  const dir = path.join(projectRoot(), "data", "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rawCapturePath(): string {
  return path.join(logsDir(), "screen-raw.png");
}

export function lastScreenPath(): string {
  return path.join(logsDir(), "screen-last.jpg");
}

/** Full primary-monitor bitmap via GDI (works without extra native deps). */
async function captureRawPng(dest: string): Promise<{ width: number; height: number }> {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()
$bmp.Save('${dest.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "$($b.Width)x$($b.Height)"
$bmp.Dispose()
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { windowsHide: true, timeout: 20000 }
  );
  const m = String(stdout).trim().match(/(\d+)x(\d+)/);
  if (!m) throw new Error("Screenshot failed: no size");
  return { width: Number(m[1]), height: Number(m[2]) };
}

async function downscaleJpeg(srcPng: string, destJpg: string, maxWidth = 1600): Promise<{ width: number; height: number }> {
  const sharp = (await import("sharp")).default;
  const img = sharp(srcPng).rotate();
  const meta = await img.metadata();
  const w = meta.width || maxWidth;
  const h = meta.height || maxWidth;
  const scale = w > maxWidth ? maxWidth / w : 1;
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  await img
    .resize(outW, outH, { fit: "inside" })
    .jpeg({ quality: 72, mozjpeg: true })
    .toFile(destJpg);
  return { width: outW, height: outH };
}

async function listWindows(limit = 12): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First ${limit} ProcessName,MainWindowTitle | ForEach-Object { "$($_.ProcessName) — $($_.MainWindowTitle)" }`,
      ],
      { windowsHide: true, timeout: 10000 }
    );
    return stdout
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Best-effort OCR via Windows.Media.Ocr (Win10+). Empty string if unavailable. */
async function ocrImage(imagePath: string): Promise<string> {
  const outFile = path.join(logsDir(), "screen-ocr.txt");
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
function Await(\$WinRtTask, \$ResultType) {
  \$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { \$_.Name -eq 'AsTask' -and \$_.GetParameters().Count -eq 1 -and \$_.IsGenericMethod })[0]
  \$netTask = \$asTask.MakeGenericMethod(\$ResultType).Invoke(\$null, @(\$WinRtTask))
  \$netTask.Wait(-1) | Out-Null
  \$netTask.Result
}
\$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${imagePath.replace(/'/g, "''")}')) ([Windows.Storage.StorageFile])
\$stream = Await (\$file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
\$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync(\$stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
\$bitmap = Await (\$decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
\$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not \$engine) { \$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'ru')) }
if (-not \$engine) { \$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en')) }
\$text = ''
if (\$engine) {
  \$result = Await (\$engine.RecognizeAsync(\$bitmap)) ([Windows.Media.Ocr.OcrResult])
  \$text = [string]\$result.Text
}
\$stream.Dispose()
[System.IO.File]::WriteAllText('${outFile.replace(/'/g, "''")}', \$text, [System.Text.UTF8Encoding]::new(\$false))
`;
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true, timeout: 25000 }
    );
    if (!fs.existsSync(outFile)) return "";
    return fs.readFileSync(outFile, "utf8").replace(/\r/g, "").trim().slice(0, 4000);
  } catch (e) {
    logInfo("screen.ocr", `skip: ${(e as Error).message || e}`);
    return "";
  }
}

export function wantsScreenSight(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return /экран|скрин|screen|desktop|рабоч(ий|его)\s+стол|видишь|посмотри|что\s+(там|открыто|сейчас)|what's on|look at (the |my )?(screen|desktop)/i.test(
    t
  );
}

/** Capture primary screen, shrink, OCR, list windows — local-only files under data/logs. */
export async function seeScreen(opts?: { ocr?: boolean }): Promise<ScreenSight> {
  const raw = rawCapturePath();
  const jpg = lastScreenPath();
  const doOcr = opts?.ocr !== false;

  logInfo("screen", "capturing primary monitor…");
  const rawSize = await captureRawPng(raw);
  const scaled = await downscaleJpeg(raw, jpg, 1600);
  try {
    fs.unlinkSync(raw);
  } catch {
    /* keep raw if delete fails */
  }

  const windows = await listWindows(14);
  const ocrText = doOcr ? await ocrImage(jpg) : "";

  const lines = [
    `Screen ${scaled.width}×${scaled.height} (source ${rawSize.width}×${rawSize.height})`,
    `Image file: ${jpg}`,
    windows.length ? "Open windows:\n" + windows.map((w) => `- ${w}`).join("\n") : "Open windows: (none titled)",
    ocrText ? "Visible text (OCR):\n" + ocrText : "Visible text (OCR): (none / unavailable)",
    "If you can read image files, open the Image file path above to see pixels.",
  ];
  const summary = lines.join("\n\n");
  logInfo("screen", `ok ${scaled.width}x${scaled.height} windows=${windows.length} ocrChars=${ocrText.length}`);
  return {
    imagePath: jpg,
    width: scaled.width,
    height: scaled.height,
    windows,
    ocrText,
    summary,
  };
}

/** Compact block for prompt injection (no need to dump huge OCR twice). */
export async function screenContextForPrompt(maxChars = 2200): Promise<string> {
  try {
    const sight = await seeScreen({ ocr: true });
    let body = [
      "## Live screen (this PC, just captured)",
      `Image: ${sight.imagePath}`,
      sight.windows.length
        ? "Windows:\n" + sight.windows.slice(0, 10).map((w) => `- ${w}`).join("\n")
        : "Windows: (none)",
      sight.ocrText ? "OCR:\n" + sight.ocrText.slice(0, 1600) : "OCR: (empty)",
      "Use see_screen again if you need a fresh capture. Prefer acting on what you see.",
    ].join("\n");
    if (body.length > maxChars) body = body.slice(0, maxChars - 20) + "\n…(truncated)";
    return body;
  } catch (e) {
    logError("screen.context", e);
    return "## Live screen\n(capture failed — use see_screen tool / window list only)";
  }
}
