/** Cross-brain cancel flag for the in-flight user ask (Cursor worker + local Ollama). */

let cancelled = false;
let generation = 0;

export function beginTask(): number {
  cancelled = false;
  generation += 1;
  return generation;
}

export function requestCancel(): void {
  cancelled = true;
}

export function clearCancel(): void {
  cancelled = false;
}

export function isCancelled(): boolean {
  return cancelled;
}

export function throwIfCancelled(): void {
  if (cancelled) {
    const err = new Error("CANCELLED_BY_USER");
    err.name = "CancelledError";
    throw err;
  }
}

export function isCancelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /CANCELLED_BY_USER|cancelled/i.test(msg);
}

export function taskGeneration(): number {
  return generation;
}
