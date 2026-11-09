/** Map raw agent/tool names to short Russian HUD status lines. */

const VISIBLE_TOOLS = new Set([
  "open_app",
  "open_url",
  "open_project_path",
  "create_folder",
  "list_projects",
  "system_status",
  "observe_pc",
  "see_screen",
  "memory_recall",
  "memory_note",
  "memory_update",
  "set_volume",
  "focus_window",
  "run_command",
  "game_mode",
  "focus_workspace",
  "rebuild_jarvis",
  "schedule_reminder",
  "list_reminders",
  "cancel_reminder",
]);

/** Show in HUD log — custom PC tools + code edits (self-programming). */
export function isNotableTool(name: string): boolean {
  const n = name.toLowerCase();
  if (VISIBLE_TOOLS.has(n)) return true;
  if ([...VISIBLE_TOOLS].some((t) => n.includes(t))) return true;
  // Cursor built-ins used when JARVIS edits himself
  if (
    n.includes("write") ||
    n.includes("streplace") ||
    n.includes("strreplace") ||
    n.includes("apply_patch") ||
    n.includes("edit_notebook") ||
    n.includes("delete_file")
  ) {
    return true;
  }
  return false;
}

export function humanActivity(name: string, status: string): string {
  const n = name.toLowerCase();
  const running = status === "running";
  const done = status === "completed" || status === "success";

  const pick = (work: string, ready: string) => (running ? work : done ? ready : `${work} (${status})`);

  if (n.includes("open_url") || n.includes("browser") || n.includes("youtube")) {
    return pick("Открываю ссылку…", "Ссылка открыта");
  }
  if (n.includes("open_app")) return pick("Запускаю приложение…", "Приложение запущено");
  if (n.includes("system_status")) return pick("Снимаю статус системы…", "Статус готов");
  if (n.includes("observe_pc")) return pick("Смотрю, что открыто…", "Обзор готов");
  if (n.includes("see_screen") || n.includes("screen")) {
    return pick("Смотрю на экран…", "Экран считан");
  }
  if (n.includes("memory_note") || n.includes("memory_update")) {
    return pick("Записываю в память…", "Запомнил");
  }
  if (n.includes("memory_recall")) return pick("Сверяюсь с памятью…", "Память под рукой");
  if (n.includes("run_command")) return pick("Выполняю на ПК…", "Команда на ПК готова");
  if (n.includes("list_projects") || n.includes("open_project")) {
    return pick("Смотрю проекты…", "Проекты готовы");
  }
  if (n.includes("create_folder") || n.includes("mkdir")) {
    return pick("Создаю папку…", "Папка создана");
  }
  if (n.includes("set_volume")) return pick("Кручу громкость…", "Громкость изменена");
  if (n.includes("focus_window") || n.includes("focus_workspace")) {
    return pick("Фокусирую окно…", "Окно на месте");
  }
  if (n.includes("game_mode")) return pick("Готовлю игровой режим…", "Игровой режим");
  if (n.includes("rebuild_jarvis") || n.includes("rebuild")) {
    return pick("Пересобираю себя…", "Сборка готова");
  }
  if (n.includes("list_reminders")) {
    return pick("Сверяю напоминания…", "Список напоминаний");
  }
  if (n.includes("cancel_reminder")) {
    return pick("Снимаю напоминание…", "Напоминание снято");
  }
  if (n.includes("schedule_reminder")) {
    return pick("Ставлю напоминание…", "Напоминание поставлено");
  }
  if (n.includes("самолечен") || n.includes("self-heal") || n.includes("сбой:")) {
    return pick("Чиню себя…", "Починка завершена");
  }
  if (n.includes("shell") || n.includes("bash") || n.includes("cmd")) {
    return pick("Выполняю команду…", "Команда выполнена");
  }
  if (n.includes("grep") || n.includes("glob") || n.includes("search") || n.includes("semantic")) {
    return pick("Ищу в коде…", "Поиск завершён");
  }
  if (n.includes("read") || n.includes("cat")) return pick("Читаю…", "Прочитано");
  if (
    n.includes("write") ||
    n.includes("streplace") ||
    n.includes("strreplace") ||
    n.includes("apply_patch") ||
    n.includes("edit")
  ) {
    return pick("Пишу код…", "Код обновлён");
  }
  if (n.includes("delete")) return pick("Удаляю файл…", "Файл удалён");
  if (n === "mcp" || n.includes("mcp")) return pick("Выполняю действие…", "Действие готово");
  return pick("Работаю…", "Шаг выполнен");
}

export const ACK_PHRASES = [
  "Секунду.",
  "Сейчас.",
  "Принял.",
  "Минуту.",
];

export function randomAck(): string {
  return ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)]!;
}

/** Greetings / tiny chitchat — no “working on it” theatre, short reply, skip heavy PC glance. */
export function isCasualTurn(text: string): boolean {
  const t = String(text || "")
    .trim()
    .replace(/^\s*(джарвис|jarvis)\s*[,:!?\-—–]+\s*/i, "")
    .trim()
    .toLowerCase();
  if (!t || t.length > 72) return false;
  if (
    /^(привет|здравствуй(?:те)?|здорово|здарова|добрый\s+(день|вечер|утро)|доброе\s+утро|хай|хелло|hello|hi|hey|yo)([!.…\s]*)$/i.test(
      t
    )
  ) {
    return true;
  }
  if (/^(пока|до\s+связи|спокойной\s+ночи|good\s+night|bye|thanks|thank\s+you|спасибо|благодарю)([!.…\s]*)$/i.test(t)) {
    return true;
  }
  if (/^(ок|окей|хорошо|ладно|угу|ага|да|нет|понял|ясно)([!.…\s]*)$/i.test(t)) {
    return true;
  }
  if (/^(как\s+дела|что\s+нового|ты\s+здесь|на\s+связи)([?!.…\s]*)$/i.test(t)) {
    return true;
  }
  return false;
}

function daypartRu(hour: number): string {
  if (hour >= 5 && hour < 12) return "Доброе утро";
  if (hour >= 12 && hour < 18) return "Добрый день";
  if (hour >= 18 && hour < 23) return "Добрый вечер";
  return "Доброй ночи";
}

/** Short spoken line when the HUD finishes loading (respect mute in main). */
export function startupGreeting(): string {
  const part = daypartRu(new Date().getHours());
  const tails = ["на связи.", "здесь.", "готов."];
  return `${part} — ${tails[Math.floor(Math.random() * tails.length)]!}`;
}
