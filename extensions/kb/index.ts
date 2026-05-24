/**
 * index.ts — Entry point for the pi-native KB extension.
 *
 * Composes the ports & adapters architecture:
 *   - adapters/  → infrastructure (filesystem, HTTP)
 *   - ports/     → domain interfaces
 *   - commands/  → application orchestration (command handlers)
 *   - tools.ts   → application orchestration (LLM tools)
 *   - prompts.ts → prompt templates
 *   - utils.ts   → pure helpers
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { FilesystemStore } from "./adapters/filesystem-store";
import { HttpFetcher } from "./adapters/http-fetcher";

import { registerWorkspaceCommands } from "./commands/workspaces";
import { registerDocumentCommands } from "./commands/documents";
import { registerQueryCommands } from "./commands/queries";
import { registerTools } from "./tools";

export default function (pi: ExtensionAPI) {
  // ── Infrastructure ───────────────────────────────────────
  const store = new FilesystemStore();
  const fetcher = new HttpFetcher();

  // ── Application ──────────────────────────────────────────
  registerWorkspaceCommands(pi, store);
  registerDocumentCommands(pi, { store, fetcher });
  registerQueryCommands(pi, store);
  registerTools(pi, store);
}
