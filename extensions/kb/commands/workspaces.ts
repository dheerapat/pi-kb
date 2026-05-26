/**
 * commands/workspaces.ts — Workspace management commands.
 *
 * Registers: /kb-init, /kb-workspaces, /kb-clear, /kb-ws-rm
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

  // ── /kb-clear <workspace-name> [-y] ──────────────────
  pi.registerCommand("kb-clear", {
    description:
      "Clear all wiki content (source/, wiki/, registry) from a workspace " +
      "while keeping the workspace directory. Works for both default and named " +
      "workspaces. Pass -y to skip confirmation.",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw) {
        ctx.ui.notify(
          "Usage: /kb-clear [-y] <workspace-name>\n\n" +
            "Clears all wiki content but keeps the workspace directory.\n" +
            "Works for both default and named workspaces.\n" +
            "Examples:\n" +
            "  /kb-clear default\n" +
            "  /kb-clear myproject\n" +
            "  /kb-clear -y default   # skip confirmation",
          "warning",
        );
        return;
      }

      // Parse -y flag
      let skipConfirm = false;
      let outerName = raw;
      const yPrefix = outerName.match(/^-y\s+/);
      const ySuffix = outerName.match(/\s+-y$/);
      if (yPrefix) {
        skipConfirm = true;
        outerName = outerName.slice(yPrefix[0].length).trim();
      } else if (ySuffix) {
        skipConfirm = true;
        outerName = outerName.slice(0, ySuffix.index).trim();
      }

      if (!outerName) {
        ctx.ui.notify(
          "Usage: /kb-clear [-y] <workspace-name>",
          "warning",
        );
        return;
      }

      const wsParam = outerName === "default" ? undefined : outerName;

      if (!store.workspaceExists(outerName)) {
        const label =
          outerName === "default"
            ? "Default workspace"
            : `Workspace "${outerName}"`;
        ctx.ui.notify(
          `${label} does not exist or has not been initialized.`,
          "error",
        );
        return;
      }

      const label =
        outerName === "default"
          ? "the default workspace"
          : `workspace "${outerName}"`;

      if (!skipConfirm) {
        const confirmed = await ctx.ui.confirm(
          "Clear workspace?",
          `Are you sure you want to clear ${label}?\n` +
            "All sources, summaries, concepts, and the index will be permanently removed, " +
            "but the workspace directory will be kept.",
        );
        if (!confirmed) {
          ctx.ui.notify("Clear cancelled.", "info");
          return;
        }
      }

      try {
        const clearedPath = store.clearWorkspace(wsParam);
        ctx.ui.notify(
          `Workspace cleared: ${outerName}\n  Path: ${clearedPath}`,
          "info",
        );
      } catch (e: any) {
        ctx.ui.notify(
          `Failed to clear workspace "${outerName}": ${e.message}`,
          "error",
        );
      }
    },
  });

  // ── /kb-ws-rm <workspace-name> [-y] ────────────────────
  pi.registerCommand("kb-ws-rm", {
    description:
      "Delete a named workspace entirely (its whole folder). " +
      "Does not support the default workspace — use /kb-clear default instead. " +
      "Pass -y to skip confirmation.",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();

      if (!raw) {
        ctx.ui.notify(
          "Usage: /kb-ws-rm [-y] <workspace-name>\n\n" +
            "Deletes the entire named workspace folder.\n" +
            "To clear the default workspace, use /kb-clear default instead.\n" +
            "Examples:\n" +
            "  /kb-ws-rm myproject\n" +
            "  /kb-ws-rm -y myproject   # skip confirmation",
          "warning",
        );
        return;
      }

      // Parse -y flag
      let skipConfirm = false;
      let name = raw;
      const yPrefix = name.match(/^-y\s+/);
      const ySuffix = name.match(/\s+-y$/);
      if (yPrefix) {
        skipConfirm = true;
        name = name.slice(yPrefix[0].length).trim();
      } else if (ySuffix) {
        skipConfirm = true;
        name = name.slice(0, ySuffix.index).trim();
      }

      if (!name) {
        ctx.ui.notify(
          "Usage: /kb-ws-rm [-y] <workspace-name>",
          "warning",
        );
        return;
      }

      if (name === "default") {
        ctx.ui.notify(
          "/kb-ws-rm does not support the default workspace. " +
            "Use /kb-clear default to clear it instead.",
          "error",
        );
        return;
      }

      if (!store.workspaceExists(name)) {
        ctx.ui.notify(
          `Workspace "${name}" does not exist or has not been initialized.`,
          "error",
        );
        return;
      }

      if (!skipConfirm) {
        const confirmed = await ctx.ui.confirm(
          "Delete workspace?",
          `Are you sure you want to delete workspace "${name}"?\n` +
            "The entire workspace folder and all its contents will be permanently removed.",
        );
        if (!confirmed) {
          ctx.ui.notify("Deletion cancelled.", "info");
          return;
        }
      }

      try {
        const removedPath = store.deleteWorkspace(name);
        ctx.ui.notify(
          `Workspace deleted: ${name}\n  Path: ${removedPath}`,
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
