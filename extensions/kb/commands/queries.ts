/**
 * commands/queries.ts — Query and inspection commands.
 *
 * Registers: /kb-query, /kb-list, /kb-status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KnowledgeBaseStore } from "../ports/types";
import { parseWorkspaceArgs } from "../utils";
import { buildQueryPrompt } from "../prompts";

export function registerQueryCommands(
  pi: ExtensionAPI,
  store: KnowledgeBaseStore,
) {
  // ── /kb-query <question> [-w <workspace>] ────────────────
  pi.registerCommand("kb-query", {
    description:
      "Ask a question against the knowledge base. Use -w <name> for a named workspace.",
    handler: async (args, ctx) => {
      const { workspace, rest } = parseWorkspaceArgs(args);

      if (!store.kbExists(workspace)) {
        const label = workspace
          ? `Workspace "${workspace}"`
          : "No knowledge base";
        ctx.ui.notify(
          `${label} found. Use /kb-init${workspace ? ` ${workspace}` : ""} first, or /kb-add to populate.`,
          "warning",
        );
        return;
      }

      if (!rest) {
        ctx.ui.notify(
          "Usage: /kb-query <question> [-w <workspace>]",
          "warning",
        );
        return;
      }

      pi.sendUserMessage(buildQueryPrompt(rest.trim(), workspace));
    },
  });

  // ── /kb-list [-w <workspace>] ────────────────────────────
  pi.registerCommand("kb-list", {
    description:
      "List all documents and concepts in the knowledge base. Use -w <name> for a named workspace.",
    handler: async (args, ctx) => {
      const { workspace } = parseWorkspaceArgs(args);

      if (!store.kbExists(workspace)) {
        const label = workspace
          ? `Workspace "${workspace}"`
          : "No knowledge base";
        ctx.ui.notify(`${label} found.`, "info");
        return;
      }

      const summaries = store.listSummaries(workspace);
      const concepts = store.listConcepts(workspace);
      const reg = store.readRegistry(workspace);
      const wsLabel = workspace ? ` [${workspace}]` : "";

      const lines: string[] = [];

      if (summaries.length === 0 && concepts.length === 0) {
        lines.push(`KB${wsLabel} is empty. Use /kb-add to add documents.`);
      } else {
        lines.push(`## Knowledge Base${wsLabel}`);
        lines.push("");

        if (summaries.length > 0) {
          lines.push(`**Documents (${summaries.length}):**`);
          for (const name of summaries) {
            const entry = Object.values(reg).find((e) => e.docName === name);
            const source = entry ? entry.name : "?";
            const added = entry ? entry.addedAt.slice(0, 10) : "?";
            const pending =
              entry && !store.isEntryCompiled(entry) ? " ⚠[pending]" : "";
            lines.push(
              `  - [[summary/${name}]] (source: ${source}, added: ${added})${pending}`,
            );
          }
          lines.push("");
        }

        if (concepts.length > 0) {
          lines.push(`**Concepts (${concepts.length}):**`);
          for (const slug of concepts) {
            const c = store.readConcept(slug, workspace);
            const srcs = c ? c.sources.join(", ") : "?";
            lines.push(`  - [[concept/${slug}]] (sources: ${srcs})`);
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /kb-status [-w <workspace>] ──────────────────────────
  pi.registerCommand("kb-status", {
    description:
      "Show knowledge base statistics. Use -w <name> for a named workspace.",
    handler: async (args, ctx) => {
      const { workspace } = parseWorkspaceArgs(args);

      if (!store.kbExists(workspace)) {
        const label = workspace
          ? `Workspace "${workspace}"`
          : "No knowledge base";
        ctx.ui.notify(`${label} found.`, "info");
        return;
      }

      const summaryCount = store.listSummaries(workspace).length;
      const conceptCount = store.listConcepts(workspace).length;
      const reg = store.readRegistry(workspace);
      const regCount = Object.keys(reg).length;
      const wsLabel = workspace ? ` [${workspace}]` : "";

      const lastEntry = Object.values(reg).sort(
        (a, b) =>
          new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
      )[0];

      const rootPath = workspace
        ? store.getWorkspaceRoot(workspace).root
        : store.getWorkspaceRoot().root;

      const pendingCount = store.countPendingCompilations(workspace);
      const pendingLine =
        pendingCount > 0
          ? `  ⚠ Pending compilation: ${pendingCount} (use /kb-repair to finish)`
          : null;

      const lines = [
        `## KB Status${wsLabel}`,
        "",
        `  Root: \`${rootPath}\``,
        `  Sources: ${regCount}`,
        `  Summaries: ${summaryCount}`,
        `  Concepts: ${conceptCount}`,
        `  Last add: ${lastEntry ? `${lastEntry.name} (${lastEntry.addedAt.slice(0, 10)})` : "never"}`,
        ...(pendingLine ? [pendingLine] : []),
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
