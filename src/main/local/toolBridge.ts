import type { SDKCustomTool } from "@cursor/sdk";
import { buildCustomTools } from "../tools/customTools";
import type { OllamaToolDef } from "./ollama";

function schemaOf(tool: SDKCustomTool): Record<string, unknown> {
  const s = (tool.inputSchema || { type: "object", properties: {} }) as Record<string, unknown>;
  if (!s.type) s.type = "object";
  return s;
}

export function ollamaToolDefs(): OllamaToolDef[] {
  const tools = buildCustomTools();
  // Local mode: skip rebuild-heavy / optional — keep rebuild for self-heal offline ability
  return Object.entries(tools).map(([name, tool]) => ({
    type: "function" as const,
    function: {
      name,
      description: tool.description || name,
      parameters: schemaOf(tool),
    },
  }));
}

export async function runLocalTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tools = buildCustomTools();
  const tool = tools[name];
  if (!tool?.execute) return `Unknown tool: ${name}`;
  try {
    const ctx = {
      toolCallId: `local-${Date.now()}`,
    } as Parameters<SDKCustomTool["execute"]>[1];
    const result = await tool.execute((args || {}) as Parameters<SDKCustomTool["execute"]>[0], ctx);
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && "content" in result) {
      return JSON.stringify(result);
    }
    return JSON.stringify(result);
  } catch (e) {
    return `Tool error: ${(e as Error).message || String(e)}`;
  }
}

export function parseToolArgs(raw: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { value: raw };
    }
  }
  return raw || {};
}
