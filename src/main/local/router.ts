import type { LocalConfig } from "./config";

export type RouteDecision = {
  brain: "local" | "cursor";
  reason: string;
};

/**
 * When both Cursor and local Ollama are available, pick the cheaper brain
 * for simple PC chores; keep Cursor for coding / deep work.
 */
export function routeRequest(text: string, cfg: LocalConfig): RouteDecision {
  if (!cfg.routeSimpleToLocal) {
    return { brain: "cursor", reason: "routing-disabled" };
  }

  const t = text.trim();
  if (!t) return { brain: "local", reason: "empty" };

  // Explicit overrides
  if (
    /через\s*cursor|use\s*cursor|на\s*cursor|облачн(ый|ая|ом)|composer|gpt|claude/i.test(t)
  ) {
    return { brain: "cursor", reason: "user-force-cursor" };
  }
  if (/локальн|на\s*ollama|без\s*cursor|офф?лайн\s*модел|qwen/i.test(t)) {
    return { brain: "local", reason: "user-force-local" };
  }

  // Heavy / coding / self-heal → Cursor (agent file tools)
  if (
    /self-heal|пересобери|rebuild_jarvis|rebuild|исправь\s*(себя|свой\s*код|код|джарвис)|доработай|улучши\s*себя|запрограмм|напиши\s*код|отрефактор|pull\s*request|\bpr\b|typescript|electron|src\/main|патч|коммит|git\s/i.test(
      t
    )
  ) {
    return { brain: "cursor", reason: "coding-self" };
  }

  if (t.length > (cfg.routeLongChars || 320)) {
    return { brain: "cursor", reason: "long-query" };
  }

  // Simple PC / HUD chores → local (save Cursor tokens)
  if (
    /^(привет|здравств|хай|hello|hi|йоу)\b/i.test(t) ||
    /\b(открой|запусти|дай|включи|выключи|громкость|громче|тише|статус|систем(а|ы|ный)|покажи\s+окн|фокус|сверни|steam|стим|discord|дискорд|браузер|зен|telegram|телег|youtube|ютуб|видео|ролик|ссылк|запомни|что\s+ты\s+помнишь|который\s+час|сколько\s+времени|mute|размут)\b/i.test(
      t
    )
  ) {
    return { brain: "local", reason: "simple-pc" };
  }

  // Short casual lines without code fences → local
  const shortLimit = cfg.routeShortChars || 72;
  if (t.length <= shortLimit && !/[`{}]|```|function\s|import\s|export\s/.test(t)) {
    return { brain: "local", reason: "short-casual" };
  }

  return { brain: "cursor", reason: "complex-default" };
}
