import { execFile } from "child_process";
import { promisify } from "util";
import { recordDialogTurn } from "./dialog";
import {
  appendNote,
  bumpHabit,
  updateInterests,
  updateProfile,
  mergeListField,
} from "./store";

const execFileAsync = promisify(execFile);

/** Fast desktop glance — no long waits; fed into every turn so JARVIS “sees” without being told. */
export async function glanceDesktop(timeoutMs = 8000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 10 ProcessName,MainWindowTitle | ForEach-Object { \"$($_.ProcessName)::$($_.MainWindowTitle)\" }",
      ],
      { windowsHide: true, timeout: timeoutMs }
    );
    const lines = stdout
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines.slice(0, 6)) {
      const app = line.split("::")[0]?.trim();
      if (app) bumpHabit({ app });
    }
    if (!lines.length) return "Desktop: no titled windows.";
    return "Desktop now:\n" + lines.map((l) => `- ${l.replace("::", " — ")}`).join("\n");
  } catch {
    return "Desktop: glance unavailable.";
  }
}

type ExtractHit = { kind: "interest" | "preference" | "habit" | "fact"; text: string };

/** Infer durable facts from natural speech — user should not need to say «запомни». */
export function extractImplicitMemory(userText: string): ExtractHit[] {
  const t = userText.trim();
  if (!t) return [];
  const hits: ExtractHit[] = [];
  const lower = t.toLowerCase();

  if (/кьюбайт|cubite|qubyte/i.test(t)) {
    updateInterests({ creators: ["Кьюбайт"] });
    hits.push({ kind: "interest", text: "Интерес к каналу: Кьюбайт" });
  }
  if (/марвел|marvel/i.test(t)) {
    updateInterests({ topics: ["Marvel"] });
    hits.push({ kind: "interest", text: "Интерес к теме: Marvel" });
  }
  if (/\bдс\b|dc comics|бэтмен|batman/i.test(t)) {
    updateInterests({ topics: ["DC"] });
    hits.push({ kind: "interest", text: "Интерес к теме: DC" });
  }

  if (/стим|steam/i.test(t)) {
    bumpHabit({ app: "steam", intent: "steam" });
    updateInterests({ topics: ["игры"] });
    hits.push({ kind: "habit", text: "Обращается к Steam / играм" });
  }
  if (/дискорд|discord/i.test(t)) bumpHabit({ app: "discord" });
  if (/телеграм|telegram|телега/i.test(t)) bumpHabit({ app: "telegram" });
  if (/курсор|cursor/i.test(t)) bumpHabit({ app: "cursor" });

  const pref =
    t.match(
      /(?:я\s+)?(?:люблю|нравится|предпочитаю|обычно|всегда|ненавижу|не люблю)\s+(.{3,80}?)(?:\.|,|!|\?|$)/i
    ) ||
    t.match(/(?:мне\s+)?(?:важно|удобнее|лучше)\s+(.{3,80}?)(?:\.|,|!|\?|$)/i);
  if (pref?.[1]) {
    const phrase = pref[0].trim().slice(0, 120);
    hits.push({ kind: "preference", text: phrase });
    mergeListField("profile", "notes", [phrase]);
  }

  if (/зовут|меня\s+зовут|обращайся|называй/i.test(t)) {
    const name =
      t.match(/(?:зовут|меня\s+зовут)\s+([A-Za-zА-Яа-яЁё0-9_\-]+)/i)?.[1] ||
      t.match(/(?:обращайся|называй)\s+(?:ко?\s+мне\s+)?(?:как\s+)?[«"]?([A-Za-zА-Яа-яЁё]+)[»"]?/i)?.[1];
    if (name) {
      updateProfile({ preferredName: name });
      hits.push({ kind: "fact", text: `Имя/обращение: ${name}` });
    }
  }

  if (/видео|ютуб|youtube|ролик|выпуск/i.test(lower)) {
    updateInterests({ topics: ["YouTube"] });
    hits.push({ kind: "interest", text: "Смотрит видео / YouTube" });
  }

  // Dedupe by text
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = h.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Host-side autonomy: log the turn and absorb whatever can be inferred without asking. */
export function absorbTurn(userText: string, assistantText: string): void {
  const hits = extractImplicitMemory(userText);
  for (const h of hits) {
    appendNote({ kind: h.kind, text: h.text, tags: ["auto"] });
  }

  appendNote({
    kind: "episode",
    text: `User: ${userText.slice(0, 180)}${assistantText ? ` → JARVIS: ${assistantText.slice(0, 140)}` : ""}`,
    tags: ["turn", "auto"],
  });

  try {
    recordDialogTurn(userText, assistantText);
  } catch {
    /* dialog memory optional */
  }
}
