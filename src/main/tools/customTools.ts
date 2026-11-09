import type { SDKCustomTool } from "@cursor/sdk";
import {
  focusWindow,
  gameMode,
  getSystemStatus,
  listProjects,
  minimizeOthersKeep,
  createFolder,
  openApp,
  openPath,
  openUrl,
  rebuildJarvis,
  setVolume,
} from "./actions";
import { loadAllowlist } from "./allowlist";
import { observePc } from "../memory/observe";
import { seeScreen } from "../vision/screen";
import {
  appendNote,
  loadMemory,
  memoryDossier,
  memoryPathForUser,
  mergeListField,
  searchNotes,
  updateInterests,
  updateProfile,
  updateSystem,
} from "../memory/store";
import { runUserCommand } from "./shellSafe";
import { cancelReminder, listReminders, scheduleReminder } from "../reminders";

function safe(
  fn: (args: Record<string, unknown>) => Promise<string> | string
): SDKCustomTool["execute"] {
  return async (args) => {
    try {
      return await fn(args as Record<string, unknown>);
    } catch (err) {
      return `Tool error: ${(err as Error).message || String(err)}`;
    }
  };
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

export function buildCustomTools(): Record<string, SDKCustomTool> {
  const appKeys = Object.keys(loadAllowlist().apps);
  return {
    system_status: {
      description: "Read-only CPU/RAM/disk and top processes on this PC.",
      annotations: { readOnlyHint: true, title: "System status" },
      inputSchema: { type: "object", properties: {} },
      execute: safe(async () => getSystemStatus()),
    },
    observe_pc: {
      description:
        "Look at what the user is doing now: open windows, heavy processes, local time. " +
        "Updates local habit memory. Use when context about the desktop helps.",
      annotations: { readOnlyHint: true, title: "Observe PC" },
      inputSchema: { type: "object", properties: {} },
      execute: safe(async () => observePc()),
    },
    see_screen: {
      description:
        "Capture the primary monitor right now: screenshot file + window titles + OCR of visible text. " +
        "Use when the user asks what is on screen, to read UI text, or when seeing the display would help. " +
        "After calling, you may Read the returned image path to inspect pixels.",
      annotations: { readOnlyHint: true, title: "See screen" },
      inputSchema: {
        type: "object",
        properties: {
          ocr: {
            type: "boolean",
            description: "Run Windows OCR on the capture (default true)",
          },
        },
      },
      execute: safe(async (args) => {
        const ocr = args.ocr === undefined ? true : !!args.ocr;
        const sight = await seeScreen({ ocr });
        return sight.summary;
      }),
    },
    memory_recall: {
      description:
        "Read local private memory about the user/system/interests/habits, or search notes. " +
        "All data stays in data/memory on this PC.",
      annotations: { readOnlyHint: true, title: "Memory recall" },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional search in notes; empty = full dossier summary",
          },
        },
      },
      execute: safe(async (args) => {
        const q = String(args.query ?? "").trim();
        if (!q) {
          return memoryDossier(4000) + `\n\nMemory folder: ${memoryPathForUser()}`;
        }
        const hits = searchNotes(q, 25);
        if (!hits.length) return `No notes matching «${q}».`;
        return hits.map((n) => `[${n.at}] (${n.kind}) ${n.text}`).join("\n");
      }),
    },
    memory_note: {
      description:
        "Save a lasting local note about the user, a preference, interest, habit, or episode. " +
        "Call this whenever you learn something worth remembering.",
      annotations: { title: "Memory note" },
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description: "fact | preference | interest | habit | episode | system",
          },
          text: { type: "string", description: "What to remember" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["text"],
      },
      execute: safe(async (args) => {
        const kindRaw = String(args.kind || "fact").toLowerCase();
        const allowed = ["fact", "preference", "interest", "habit", "episode", "system"] as const;
        const kind = (allowed as readonly string[]).includes(kindRaw)
          ? (kindRaw as (typeof allowed)[number])
          : "fact";
        const note = appendNote({
          kind,
          text: String(args.text ?? ""),
          tags: asStringList(args.tags),
        });
        return `Saved local note (${note.kind}): ${note.text}`;
      }),
    },
    memory_update: {
      description:
        "Update structured local memory: profile (name, addressAs, languages, notes), " +
        "system facts, or interests (topics/creators/games/projects). Merges lists.",
      annotations: { title: "Memory update" },
      inputSchema: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description: "profile | system | interests | habit_notes",
          },
          preferredName: { type: "string" },
          addressAs: { type: "string" },
          languages: { type: "array", items: { type: "string" } },
          browser: { type: "string" },
          ide: { type: "string" },
          steamLibrary: { type: "string" },
          projectsRoot: { type: "string" },
          topics: { type: "array", items: { type: "string" } },
          creators: { type: "array", items: { type: "string" } },
          games: { type: "array", items: { type: "string" } },
          projects: { type: "array", items: { type: "string" } },
          notes: {
            type: "array",
            items: { type: "string" },
            description: "Extra notes to append for profile/system/habits",
          },
        },
        required: ["section"],
      },
      execute: safe(async (args) => {
        const section = String(args.section || "").toLowerCase();
        if (section === "profile") {
          const patch: Parameters<typeof updateProfile>[0] = {};
          if (args.preferredName) patch.preferredName = String(args.preferredName);
          if (args.addressAs) patch.addressAs = String(args.addressAs);
          if (args.languages) patch.languages = asStringList(args.languages);
          const p = updateProfile(patch);
          if (args.notes) mergeListField("profile", "notes", asStringList(args.notes));
          return `Profile updated: ${p.preferredName} / «${p.addressAs}»`;
        }
        if (section === "system") {
          const patch: Parameters<typeof updateSystem>[0] = {};
          if (args.browser) patch.browser = String(args.browser);
          if (args.ide) patch.ide = String(args.ide);
          if (args.steamLibrary) patch.steamLibrary = String(args.steamLibrary);
          if (args.projectsRoot) patch.projectsRoot = String(args.projectsRoot);
          updateSystem(patch);
          if (args.notes) mergeListField("system", "notes", asStringList(args.notes));
          return "System memory updated.";
        }
        if (section === "interests") {
          updateInterests({
            topics: asStringList(args.topics),
            creators: asStringList(args.creators),
            games: asStringList(args.games),
            projects: asStringList(args.projects),
          });
          return "Interests updated.";
        }
        if (section === "habit_notes") {
          return mergeListField("habits", "notes", asStringList(args.notes));
        }
        const snap = loadMemory();
        return `Unknown section. Have profile=${snap.profile.preferredName}, interests topics=${snap.interests.topics.length}`;
      }),
    },
    open_app: {
      description:
        `Launch an allowlisted desktop app on this PC. Use whenever the user asks to open/start/give/launch an app in any language. ` +
        `Keys: ${appKeys.join(", ")}. Map slang freely (стим→steam, курсор→cursor, дискорд→discord, зен/браузер→zen, телега→telegram).`,
      annotations: { title: "Open app" },
      inputSchema: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: `Exact key: ${appKeys.join(" | ")}`,
          },
        },
        required: ["app"],
      },
      execute: safe(async (args) => openApp(String(args.app ?? "").toLowerCase().trim())),
    },
    open_url: {
      description:
        "Open an https URL in Zen browser (YouTube, sites, searches). Prefer this for videos/channels/web instead of searching the local disk. " +
        "Examples: https://www.youtube.com/results?search_query=Кьюбайт , a direct watch URL, or a channel URL.",
      annotations: { title: "Open URL", openWorldHint: true },
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full http(s) URL to open" },
        },
        required: ["url"],
      },
      execute: safe(async (args) => openUrl(String(args.url ?? ""))),
    },
    open_project_path: {
      description: "Open a folder under D:\\Projects in Explorer.",
      annotations: { title: "Open project path" },
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path under D:\\Projects" },
        },
        required: ["path"],
      },
      execute: safe(async (args) => openPath(String(args.path ?? ""))),
    },
    create_folder: {
      description:
        "Create a real folder. Infer name + parent from the user's request (any phrasing). " +
        "where shortcuts: desktop, documents, downloads, projects (=D:\\\\Projects), " +
        "cursor_projects (=D:\\\\Projects\\\\CursorProjects — Cursor/IDE repos). " +
        "Or pass an absolute path/drive (D:\\\\, D:\\\\Games). " +
        "If they mean Cursor project folders, use cursor_projects — not projects. Never invent success.",
      annotations: { title: "Create folder" },
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Folder name only (not full path) — inferred from the request",
          },
          where: {
            type: "string",
            description:
              "Parent shortcut or path: desktop|documents|downloads|projects|cursor_projects|D:\\\\|D:\\\\Subdir",
          },
          open: {
            type: "boolean",
            description: "Open in Explorer after create (default true)",
          },
        },
        required: ["name", "where"],
      },
      execute: safe(async (args) => {
        const where = String(args.where ?? "").trim();
        if (!where) {
          return "Refused: where is required. Infer parent path/drive from the user request, then retry.";
        }
        return createFolder({
          name: String(args.name ?? ""),
          where,
          open: args.open === undefined ? true : !!args.open,
        });
      }),
    },
    list_projects: {
      description: "List project folders under D:\\Projects.",
      annotations: { readOnlyHint: true, title: "List projects" },
      inputSchema: { type: "object", properties: {} },
      execute: safe(async () => listProjects()),
    },
    set_volume: {
      description: "Set master volume 0-100.",
      annotations: { title: "Set volume" },
      inputSchema: {
        type: "object",
        properties: {
          percent: { type: "number", description: "0-100" },
        },
        required: ["percent"],
      },
      execute: safe(async (args) => setVolume(Number(args.percent))),
    },
    focus_window: {
      description: "Focus a window whose title matches a substring.",
      annotations: { title: "Focus window" },
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
      },
      execute: safe(async (args) => focusWindow(String(args.title ?? ""))),
    },
    run_command: {
      description:
        "Confirm-gated: run a non-elevated PowerShell command on this PC for the user. " +
        "Blocked: Defender/UAC/format/shutdown/recursive deletes/admin elevation. " +
        "Use for real PC control when other tools are not enough.",
      annotations: { destructiveHint: true, title: "Run command" },
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "PowerShell command (no RunAs)" },
          reason: { type: "string", description: "Short why — shown in confirm dialog" },
        },
        required: ["command"],
      },
      execute: safe(async (args) => {
        const command = String(args.command ?? "");
        const reason = String(args.reason ?? "выполнить команду на ПК");
        return runCommandConfirmed(command, reason);
      }),
    },
    game_mode: {
      description: "Confirm-gated: close Discord/browser/Telegram for gaming. Never touches Defender.",
      annotations: { destructiveHint: true, title: "Game mode" },
      inputSchema: { type: "object", properties: {} },
      execute: safe(async () => gameMode()),
    },
    focus_workspace: {
      description: "Confirm-gated: minimize other windows, keep matching title (e.g. Cursor).",
      annotations: { destructiveHint: true, title: "Focus workspace" },
      inputSchema: {
        type: "object",
        properties: {
          keepTitle: { type: "string", description: "Substring of window title to keep" },
        },
        required: ["keepTitle"],
      },
      execute: safe(async (args) => minimizeOthersKeep(String(args.keepTitle ?? "Cursor"))),
    },
    list_reminders: {
      description:
        "List pending reminders after pruning missed/expired ones from disk. " +
        "Always call this (not memory) when the user asks what reminders are set, «какие напоминания», delete/cancel context, etc.",
      annotations: { title: "List reminders" },
      inputSchema: { type: "object", properties: {} },
      execute: safe(async () => listReminders()),
    },
    cancel_reminder: {
      description:
        "Remove a pending reminder by id or message substring. Prunes inactive rows first. " +
        "Use when the user asks to delete/cancel a reminder.",
      annotations: { title: "Cancel reminder" },
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Reminder id from list_reminders" },
          message_contains: {
            type: "string",
            description: "Case-insensitive substring of the reminder text",
          },
        },
      },
      execute: safe(async (args) =>
        cancelReminder({
          id: args.id !== undefined ? String(args.id) : undefined,
          message_contains:
            args.message_contains !== undefined ? String(args.message_contains) : undefined,
        })
      ),
    },
    schedule_reminder: {
      description:
        "Schedule a one-shot reminder while JARVIS is running (tray counts). " +
        "When it fires: posts to HUD chat and shows a Windows notification if HUD is hidden or unfocused. " +
        "Stale/missed rows are pruned on schedule, list, and fire. " +
        "For «на 21:41» / clock time use at_time (and on_date for explicit calendar day). " +
        "If only at_time and that clock today is past, fires next calendar day. " +
        "Prefer this over run_command/schtasks for «напомни через …».",
      annotations: { title: "Schedule reminder" },
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "What to remind the user about" },
          at_time: {
            type: "string",
            description: "Local clock HH:MM or HH:MM:SS (e.g. 22:16). Pair with on_date when user names a day.",
          },
          on_date: {
            type: "string",
            description:
              "Calendar day: YYYY-MM-DD, DD.MM.YYYY, «сегодня», «завтра». Omit with at_time to mean today or roll to tomorrow if past.",
          },
          fire_at_iso: {
            type: "string",
            description: "Full ISO 8601 local/offset datetime when you already computed an absolute instant",
          },
          in_minutes: { type: "number", description: "Relative delay in minutes (e.g. 60)" },
          in_seconds: { type: "number", description: "Relative delay in seconds (quick tests)" },
        },
        required: ["message"],
      },
      execute: safe(async (args) => {
        const msg = String(args.message ?? "");
        const inMinutes =
          args.in_minutes !== undefined ? Number(args.in_minutes) : undefined;
        const inSeconds =
          args.in_seconds !== undefined ? Number(args.in_seconds) : undefined;
        const atTime = args.at_time !== undefined ? String(args.at_time) : undefined;
        const onDate = args.on_date !== undefined ? String(args.on_date) : undefined;
        const fireAtIso =
          args.fire_at_iso !== undefined ? String(args.fire_at_iso) : undefined;
        return scheduleReminder(msg, {
          inMinutes,
          inSeconds,
          atTime,
          onDate,
          fireAtIso,
        });
      }),
    },
    rebuild_jarvis: {
      description:
        "After editing Stark OS / JARVIS source under this repo, compile TypeScript and copy static assets. " +
        "Set restart=true to relaunch the HUD so main-process changes load (asks user to confirm). " +
        "Use when the user asks you to improve/fix/program yourself.",
      annotations: { destructiveHint: true, title: "Rebuild JARVIS" },
      inputSchema: {
        type: "object",
        properties: {
          restart: {
            type: "boolean",
            description: "If true (default), confirm and relaunch Electron after build",
          },
        },
      },
      execute: safe(async (args) => {
        const restart = args.restart === undefined ? true : Boolean(args.restart);
        return rebuildJarvis(restart);
      }),
    },
  };
}

async function runCommandConfirmed(command: string, reason: string): Promise<string> {
  const { requestConfirm } = await import("./actions");
  const ok = await requestConfirm(
    `Выполнить команду на ПК?\n${reason}\n\n${command.slice(0, 500)}`
  );
  if (!ok) return "Command cancelled by user.";
  const result = await runUserCommand(command);
  try {
    const { bumpHabit, appendNote } = await import("../memory/store");
    bumpHabit({ intent: "run_command" });
    appendNote({
      kind: "episode",
      text: `ran command: ${command.slice(0, 160)}`,
      tags: ["shell"],
    });
  } catch {
    /* ignore */
  }
  return result;
}
