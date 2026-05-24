/**
 * commands/workspaces.ts — Workspace management commands.
 *
 * Registers: /kb-init, /kb-workspaces, /kb-ws-rm
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KnowledgeBaseStore } from "../ports/types";
import { slugify } from "../utils";

export function registerWorkspaceCommands(
  pi: ExtensionAPI,
  store: KnowledgeBaseStore,
) {
  // ── /kb-init <workspace-name> ──────────────────────────────
  pi.registerCommand("kb-init", {
    description:
      "Create a new named workspace under kb/workspaces/ (e.g. /kb-init myproject)",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify(
          "Usage: /kb-init <workspace-name>\n\n" +
            "Creates a named workspace. Use -w <name> on other commands to target it.\n" +
            "Example: /kb-init myproject",
          "warning",
        );
        return;
      }

      const name = slugify(args.trim());
      if (!name) {
        ctx.ui.notify(
          "Invalid workspace name. Use letters, numbers, hyphens.",
          "error",
        );
        return;
      }

      if (store.workspaceExists(name)) {
        ctx.ui.notify(
          `Workspace "${name}" already exists. Use /kb-add -w ${name} <file> to add documents.`,
          "warning",
        );
        return;
      }

      store.ensureKbDir(name);
      ctx.ui.notify(
        `Workspace created: ${name}\n` +
          `  Path: ${store.getWorkspaceRoot(name).root}\n\n` +
          `Usage:\n` +
          `  /kb-add -w ${name} <file>   Add documents\n` +
          `  /kb-query -w ${name} <q>    Search this workspace\n` +
          `  /kb-workspaces              List all workspaces`,
        "info",
      );
    },
  });

  // ── /kb-workspaces ────────────────────────────────────────
  pi.registerCommand("kb-workspaces", {
    description: "List all workspaces and their stats",
    handler: async (_args, ctx) => {
      const lines: string[] = ["## Workspaces", ""];

      // Default workspace
      const defExists = store.kbExists();
      if (defExists) {
        const defSummaries = store.listSummaries();
        const defConcepts = store.listConcepts();
        const defReg = store.readRegistry();
        const defSrcs = Object.keys(defReg).length;
        const defLabel =
          defSrcs > 0 || defSummaries.length > 0
            ? `${defSrcs} sources, ${defSummaries.length} docs, ${defConcepts.length} concepts`
            : "empty";
        lines.push(`  **default** — ${defLabel}`);
      } else {
        lines.push("  **default** — not initialized");
      }

      const named = store.listWorkspaces();
      if (named.length === 0) {
        lines.push("");
        lines.push(
          "No named workspaces. Use /kb-init <name> to create one.",
        );
      } else {
        lines.push("");
        for (const ws of named) {
          const wSummaries = store.listSummaries(ws);
          const wConcepts = store.listConcepts(ws);
          const wReg = store.readRegistry(ws);
          const wSrcs = Object.keys(wReg).length;
          lines.push(
            `  **${ws}** — ${wSrcs} sources, ${wSummaries.length} docs, ${wConcepts.length} concepts`,
          );
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /kb-ws-rm <workspace-name> ────────────────────────────
  pi.registerCommand("kb-ws-rm", {
    description:
      "Delete a workspace entirely (including all its sources, summaries, and concepts). " +
      "Use '/kb-ws-rm default' to tear down the default workspace.",
    handler: async (args, ctx) => {
      const name = (args ?? "").trim();

      if (!name) {
        ctx.ui.notify(
          "Usage: /kb-ws-rm <workspace-name>\n\n" +
            "Deletes the workspace and all its data.\n" +
            "Examples:\n" +
            "  /kb-ws-rm myproject\n" +
            "  /kb-ws-rm default   # explicit only",
          "warning",
        );
        return;
      }

      if (!store.workspaceExists(name)) {
        const label =
          name === "default" ? "Default workspace" : `Workspace "${name}"`;
        ctx.ui.notify(
          `${label} does not exist or has not been initialized.`,
          "error",
        );
        return;
      }

      const label =
        name === "default" ? "the default workspace" : `workspace "${name}"`;
      const confirmed = await ctx.ui.confirm(
        "Delete workspace?",
        `Are you sure you want to delete ${label}?\n` +
          "All sources, summaries, concepts, and the index will be permanently removed.",
      );

      if (!confirmed) {
        ctx.ui.notify("Deletion cancelled.", "info");
        return;
      }

      try {
        const removedPath = store.deleteWorkspace(
          name === "default" ? undefined : name,
        );
        ctx.ui.notify(
          `Workspace deleted: ${name}\n` + `  Path: ${removedPath}`,
          "info",
        );
      } catch (e: any) {
        ctx.ui.notify(
          `Failed to delete workspace "${name}": ${e.message}`,
          "error",
        );
      }
    },
  });
}
