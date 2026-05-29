/**
 * commands/documents.ts — Document lifecycle commands.
 *
 * Registers: /kb-add, /kb-remove, /kb-repair
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KnowledgeBaseStore, ContentFetcher, RegistryEntry } from "../ports/types";
import {
  docNameFromFile,
  docNameFromUrl,
  isUrl,
  parseWorkspaceArgs,
  resolvePath,
  isoNow,
  buildIndexContent,
} from "../utils";
import {
  buildCompilePrompt,
  buildCompilePromptInline,
  buildRemovePrompt,
} from "../prompts";
import * as fs from "node:fs";
import * as path from "node:path";

export function registerDocumentCommands(
  pi: ExtensionAPI,
  deps: {
    store: KnowledgeBaseStore;
    fetcher: ContentFetcher;
  },
) {
  const { store, fetcher } = deps;

  // ── /kb-add <@file | url> [-w <workspace>] ─────────────
  pi.registerCommand("kb-add", {
    description:
      "Add markdown files (via @) or URLs to the knowledge base. Use -w <name> for a named workspace.",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify(
          "Usage: /kb-add @file.md | <url> [-w <workspace>]",
          "warning",
        );
        return;
      }

      const { workspace, force, rest } = parseWorkspaceArgs(args);

      const rawArgs = rest
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (rawArgs.length === 0) {
        ctx.ui.notify("No files or URLs specified.", "warning");
        return;
      }

      const { cwd } = ctx;
      const wsLabel = workspace ? ` [${workspace}]` : "";

      for (const arg of rawArgs) {
        // ── URL branch ───────────────────────────────────
        if (isUrl(arg)) {
          await handleUrlAdd(arg, workspace, force, wsLabel, ctx, pi, store, fetcher);
          continue;
        }

        // ── @file branch ────────────────────────────────
        if (arg.startsWith("@")) {
          const fp = arg.slice(1); // strip @ prefix
          await handleFileAdd(fp, workspace, force, wsLabel, cwd, ctx, pi, store);
          continue;
        }

        // ── Reject plain paths ──────────────────────────
        ctx.ui.notify(
          `Unrecognized argument: "${arg}". Use @filename.md or a URL (https://...).`,
          "error",
        );
      }
    },
  });

  // ── /kb-add-content <text> [-w <workspace>] [-f] ────────
  pi.registerCommand("kb-add-content", {
    description:
      "Add inline text content to the knowledge base. The LLM will choose a docName. Use -w <name> for a named workspace.",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify(
          "Usage: /kb-add-content <markdown text> [-w <workspace>] [-f]",
          "warning",
        );
        return;
      }

      const { workspace, force, rest } = parseWorkspaceArgs(args);

      if (!rest || rest.trim().length === 0) {
        ctx.ui.notify(
          "No content provided. Usage: /kb-add-content <markdown text> [-w <workspace>] [-f]",
          "warning",
        );
        return;
      }

      const content = rest.trim();
      const wsLabel = workspace ? ` [${workspace}]` : "";
      const contentHash = store.hashContent(content);
      const tempDocName = `inline-${contentHash.slice(0, 8)}`;
      const filename = `${tempDocName}.md`;

      // Dedup by hash
      const reg = store.readRegistry(workspace);
      if (Object.keys(reg).includes(contentHash)) {
        const existing = reg[contentHash];
        if (!store.isEntryCompiled(existing)) {
          ctx.ui.notify(
            `Re-compiling${wsLabel}: inline content (previously added ${existing.addedAt.slice(0, 10)} but compilation was interrupted)`,
            "info",
          );
          pi.sendUserMessage(
            buildCompilePromptInline(existing.docName, content, workspace),
          );
          return;
        }
        ctx.ui.notify(
          `Already in KB${wsLabel}: inline content (added ${existing.addedAt.slice(0, 10)} as "${existing.docName}")`,
          "warning",
        );
        return;
      }

      // Guard: only one pending compilation at a time
      if (store.countPendingCompilations(workspace) > 0) {
        const pendingEntry = Object.values(reg).find(
          (e) => !store.isEntryCompiled(e),
        );
        const pendingName = pendingEntry ? pendingEntry.name : "unknown";
        if (!force) {
          const discard = await ctx.ui.confirm(
            "Pending compilation",
            `"${pendingName}" is pending compilation. Discard it to add inline content instead?\n\nUse /kb-repair to finish the pending document without losing it.`,
          );
          if (!discard) {
            ctx.ui.notify(
              `Add blocked${wsLabel}: "${pendingName}" is still pending. Use /kb-repair to finish it.`,
              "warning",
            );
            return;
          }
        }
        discardPendingEntry(workspace, store, ctx);
      }

      store.ensureKbDir(workspace);

      // Resolve doc-name collision (should be rare with inline- prefix but handle it)
      const finalDocName = resolveDocNameCollision(
        tempDocName,
        workspace,
        ctx,
        store,
      );
      const finalFilename = `${finalDocName}.md`;

      // Write source
      let sourceRel: string;
      try {
        const wsc = store.writeSourceContent(finalFilename, content, workspace);
        sourceRel = wsc.destRel;
      } catch (e: any) {
        ctx.ui.notify(`Failed to save source: ${e.message}`, "error");
        return;
      }

      // Register
      const entry: RegistryEntry = {
        name: finalFilename,
        sourcePath: sourceRel,
        originalPath: `inline:${finalDocName}`,
        docName: finalDocName,
        addedAt: isoNow(),
        compiled: false,
      };
      const newReg = store.readRegistry(workspace);
      newReg[contentHash] = entry;
      store.writeRegistry(newReg, workspace);

      ctx.ui.notify(
        `Added${wsLabel}: inline content → ${finalFilename} (temp name — LLM will rename)`,
        "info",
      );
      pi.sendUserMessage(
        buildCompilePromptInline(finalDocName, content, workspace),
      );
    },
  });

  // ── /kb-remove <docName> [-w <workspace>] ────────────────
  pi.registerCommand("kb-remove", {
    description:
      "Remove a document from the knowledge base by docName. Use -w <name> for a named workspace.",
    handler: async (args, ctx) => {
      const { workspace, rest } = parseWorkspaceArgs(args);

      if (!store.kbExists(workspace)) {
        const label = workspace
          ? `Workspace "${workspace}"`
          : "No knowledge base";
        ctx.ui.notify(`${label} found.`, "warning");
        return;
      }

      if (!rest) {
        ctx.ui.notify(
          "Usage: /kb-remove <docName> [-w <workspace>]",
          "warning",
        );
        return;
      }

      const docName = rest.trim();
      const reg = store.readRegistry(workspace);
      const matches = Object.entries(reg).filter(
        ([_, e]) => e.docName === docName,
      );

      if (matches.length === 0) {
        ctx.ui.notify(
          `No document with slug "${docName}" found. Use /kb-list to see available docs.`,
          "error",
        );
        return;
      }

      const [hash, entry] = matches[0];
      const wsLabel = workspace ? ` [${workspace}]` : "";
      ctx.ui.notify(`Removing${wsLabel}: ${entry.name} (${docName})`, "info");

      // ═══════════════════════════════════════════════════════
      // Phase 1 — Deterministic structural cleanup (no LLM)
      // ═══════════════════════════════════════════════════════

      // 1. Delete the summary
      store.deleteSummary(docName, workspace);

      // 2. Clean concepts: remove source from sources list, delete if orphaned.
      //    Set needs_review: true instead of wiping body (Gap 2).
      const affectedConceptSlugs: string[] = [];

      // Match both new format ("summary/docName") and legacy ("filename.md")
      const sourceRefs = [entry.name, `summary/${entry.docName}`];

      for (const slug of store.listConcepts(workspace)) {
        const concept = store.readConcept(slug, workspace);
        if (!concept || !concept.sources.some((s) => sourceRefs.includes(s)))
          continue;

        const remainingSources = concept.sources.filter(
          (s) => !sourceRefs.includes(s),
        );

        if (remainingSources.length === 0) {
          // No sources left — delete the concept entirely
          store.deleteConcept(slug, workspace);
        } else {
          // Keep the body, update sources, set needs_review flag
          store.writeConcept(
            slug,
            concept.body,
            remainingSources,
            workspace,
            true,
          );
          affectedConceptSlugs.push(slug);
        }
      }

      // 3. Rebuild index from disk (deterministic, no LLM involvement)
      const summaries = store.listSummaries(workspace);
      const concepts = store.listConcepts(workspace).map((slug) => {
        const c = store.readConcept(slug, workspace);
        return { slug, sources: c?.sources ?? [] };
      });
      store.writeIndex(buildIndexContent(summaries, concepts), workspace);

      // 4. Delete the source file
      store.deleteSource(entry.sourcePath, workspace);

      // 5. Delete registry entry LAST (registry is always consistent with disk)
      delete reg[hash];
      store.writeRegistry(reg, workspace);

      // ═══════════════════════════════════════════════════════
      // Phase 2 — LLM surgical excision (non-critical, additive)
      // ═══════════════════════════════════════════════════════
      if (affectedConceptSlugs.length > 0) {
        ctx.ui.notify(
          `${affectedConceptSlugs.length} concept(s) need body cleanup${wsLabel}. Sending to LLM...`,
          "info",
        );
        const prompt = buildRemovePrompt(
          docName,
          entry.name,
          affectedConceptSlugs,
          workspace,
        );
        pi.sendUserMessage(prompt);
      } else {
        ctx.ui.notify(
          `Removal complete${wsLabel}: ${entry.name} (no concepts affected)`,
          "info",
        );
      }
    },
  });

  // ── /kb-repair [docName] [-w <workspace>] ────────────────
  pi.registerCommand("kb-repair", {
    description:
      "Detect and re-compile documents whose compilation was interrupted. " +
      "Pass a docName to repair a specific document. Use -w <name> for a named workspace.",
    handler: async (args, ctx) => {
      const { workspace, rest } = parseWorkspaceArgs(args);

      if (!store.kbExists(workspace)) {
        const label = workspace
          ? `Workspace "${workspace}"`
          : "No knowledge base";
        ctx.ui.notify(`${label} found.`, "warning");
        return;
      }

      const reg = store.readRegistry(workspace);
      const wsLabel = workspace ? ` [${workspace}]` : "";

      // Specific docName
      if (rest) {
        const docName = rest.trim();
        const matches = Object.entries(reg).filter(
          ([_, e]) => e.docName === docName,
        );

        if (matches.length === 0) {
          ctx.ui.notify(
            `No document with slug "${docName}" found in registry.`,
            "error",
          );
          return;
        }

        const [_, entry] = matches[0];
        if (store.isEntryCompiled(entry)) {
          ctx.ui.notify(
            `Document "${docName}" is already compiled.`,
            "info",
          );
          return;
        }

        recompileEntry(entry, workspace, wsLabel, ctx, pi, store);
        return;
      }

      // All pending
      const pending = Object.entries(reg).filter(
        ([_, e]) => !store.isEntryCompiled(e),
      );

      if (pending.length === 0) {
        ctx.ui.notify(
          `All documents are compiled${wsLabel}. Nothing to repair.`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        `Found ${pending.length} pending document(s)${wsLabel}. Re-compiling...`,
        "info",
      );

      for (const [_, entry] of pending) {
        recompileEntry(entry, workspace, wsLabel, ctx, pi, store);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function handleUrlAdd(
  fp: string,
  workspace: string | undefined,
  force: boolean,
  wsLabel: string,
  ctx: any,
  pi: ExtensionAPI,
  store: KnowledgeBaseStore,
  fetcher: ContentFetcher,
) {
  // Dedup by URL before fetching
  if (store.isUrlInRegistry(fp, workspace)) {
    const existing = store.findByUrl(fp, workspace)!;
    if (!store.isEntryCompiled(existing)) {
      ctx.ui.notify(
        `Re-compiling${wsLabel}: ${fp} (previously added ${existing.addedAt.slice(0, 10)} but compilation was interrupted)`,
        "info",
      );
      let content2: string;
      try {
        content2 = store.readSource(existing.sourcePath, workspace);
      } catch (e: any) {
        ctx.ui.notify(`Failed to read source: ${e.message}`, "error");
        return;
      }
      const prompt2 = buildCompilePrompt(
        existing.name,
        existing.docName,
        content2,
        workspace,
      );
      pi.sendUserMessage(prompt2);
      return;
    }
    ctx.ui.notify(
      `Already in KB${wsLabel}: ${fp} (added ${existing.addedAt.slice(0, 10)})`,
      "warning",
    );
    return;
  }

  // Guard: only one pending compilation at a time
  if (store.countPendingCompilations(workspace) > 0) {
    const reg = store.readRegistry(workspace);
    const pendingEntry = Object.values(reg).find((e) => !store.isEntryCompiled(e));
    const pendingName = pendingEntry ? pendingEntry.name : "unknown";
    if (!force) {
      const discard = await ctx.ui.confirm(
        "Pending compilation",
        `"${pendingName}" is pending compilation. Discard it to add "${fp}" instead?\n\nUse /kb-repair to finish the pending document without losing it.`,
      );
      if (!discard) {
        ctx.ui.notify(
          `Add blocked${wsLabel}: "${pendingName}" is still pending. Use /kb-repair to finish it.`,
          "warning",
        );
        return;
      }
    }
    discardPendingEntry(workspace, store, ctx);
  }

  store.ensureKbDir(workspace);

  // Fetch & convert
  let converted: { content: string; title: string | null };
  try {
    ctx.ui.notify(`Fetching${wsLabel}: ${fp}`, "info");
    converted = await fetcher.fetchAndConvert(fp);
  } catch (e: any) {
    ctx.ui.notify(`Failed to fetch ${fp}: ${e.message}`, "error");
    return;
  }

  const content = converted.content;
  const docName = docNameFromUrl(fp, converted.title);

  // Resolve doc-name collision
  const finalDocName = resolveDocNameCollision(docName, workspace, ctx, store);
  const filename = `${finalDocName}.md`;

  // Write source
  let sourceRel: string;
  try {
    const wsc = store.writeSourceContent(filename, content, workspace);
    sourceRel = wsc.destRel;
  } catch (e: any) {
    ctx.ui.notify(`Failed to save source: ${e.message}`, "error");
    return;
  }

  // Register
  const normalizedUrl = store.normalizeUrl(fp);
  const entry: RegistryEntry = {
    name: filename,
    sourcePath: sourceRel,
    originalPath: normalizedUrl,
    docName: finalDocName,
    addedAt: isoNow(),
    compiled: false,
  };
  const reg = store.readRegistry(workspace);
  const fileHash = store.hashContent(content);
  reg[fileHash] = entry;
  store.writeRegistry(reg, workspace);

  ctx.ui.notify(`Added${wsLabel}: ${fp} → ${filename}`, "info");
  pi.sendUserMessage(buildCompilePrompt(filename, finalDocName, content, workspace));
}

async function handleFileAdd(
  fp: string,
  workspace: string | undefined,
  force: boolean,
  wsLabel: string,
  cwd: string,
  ctx: any,
  pi: ExtensionAPI,
  store: KnowledgeBaseStore,
) {
  const absPath = resolvePath(fp, cwd);

  if (!fs.existsSync(absPath)) {
    ctx.ui.notify(`File not found: ${fp}`, "error");
    return;
  }
  if (path.extname(absPath).toLowerCase() !== ".md") {
    ctx.ui.notify(`Only .md files are supported: ${fp}`, "error");
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf-8");
  } catch (e: any) {
    ctx.ui.notify(`Failed to read ${fp}: ${e.message}`, "error");
    return;
  }

  if (content.trim().length === 0) {
    ctx.ui.notify(`File is empty: ${fp}`, "warning");
    return;
  }

  const fileHash = store.hashFile(absPath);
  store.ensureKbDir(workspace);

  // Dedup by hash
  if (Object.keys(store.readRegistry(workspace)).includes(fileHash)) {
    const existing = store.readRegistry(workspace)[fileHash];
    if (!store.isEntryCompiled(existing)) {
      ctx.ui.notify(
        `Re-compiling${wsLabel}: ${fp} (previously added ${existing.addedAt.slice(0, 10)} but compilation was interrupted)`,
        "info",
      );
      const content2 = fs.readFileSync(absPath, "utf-8");
      pi.sendUserMessage(
        buildCompilePrompt(existing.name, existing.docName, content2, workspace),
      );
      return;
    }
    ctx.ui.notify(
      `Already in KB${wsLabel}: ${fp} (added ${existing.addedAt.slice(0, 10)})`,
      "warning",
    );
    return;
  }

  // Guard: only one pending compilation at a time
  if (store.countPendingCompilations(workspace) > 0) {
    const reg = store.readRegistry(workspace);
    const pendingEntry = Object.values(reg).find((e) => !store.isEntryCompiled(e));
    const pendingName = pendingEntry ? pendingEntry.name : "unknown";
    if (!force) {
      const discard = await ctx.ui.confirm(
        "Pending compilation",
        `"${pendingName}" is pending compilation. Discard it to add "${path.basename(absPath)}" instead?\n\nUse /kb-repair to finish the pending document without losing it.`,
      );
      if (!discard) {
        ctx.ui.notify(
          `Add blocked${wsLabel}: "${pendingName}" is still pending. Use /kb-repair to finish it.`,
          "warning",
        );
        return;
      }
    }
    discardPendingEntry(workspace, store, ctx);
  }

  const originalName = path.basename(absPath);
  const docName = docNameFromFile(absPath);

  if (store.isDocNameUsed(docName, workspace)) {
    ctx.ui.notify(
      `A document with slug "${docName}" already exists in the KB.\n` +
        `Rename your file to something unique before adding it.`,
      "error",
    );
    return;
  }

  // Copy source
  let sourceRel: string;
  try {
    const copied = store.copySource(absPath, workspace);
    sourceRel = copied.destRel;
  } catch (e: any) {
    ctx.ui.notify(`Failed to copy source: ${e.message}`, "error");
    return;
  }

  const entry: RegistryEntry = {
    name: originalName,
    sourcePath: sourceRel,
    originalPath: absPath,
    docName,
    addedAt: isoNow(),
    compiled: false,
  };
  const reg = store.readRegistry(workspace);
  reg[fileHash] = entry;
  store.writeRegistry(reg, workspace);

  ctx.ui.notify(`Added${wsLabel}: ${originalName}`, "info");
  pi.sendUserMessage(buildCompilePrompt(originalName, docName, content, workspace));
}

/** Re-read source and inject compile prompt for a single pending entry. */
function recompileEntry(
  entry: RegistryEntry,
  workspace: string | undefined,
  wsLabel: string,
  ctx: any,
  pi: ExtensionAPI,
  store: KnowledgeBaseStore,
) {
  let content: string;
  try {
    content = store.readSource(entry.sourcePath, workspace);
  } catch (e: any) {
    ctx.ui.notify(
      `Failed to read source for "${entry.docName}": ${e.message}`,
      "warning",
    );
    return;
  }

  ctx.ui.notify(`Re-compiling${wsLabel}: ${entry.name}`, "info");
  pi.sendUserMessage(
    buildCompilePrompt(entry.name, entry.docName, content, workspace),
  );
}

/** Delete a pending entry from the registry and its source file. Used when the
 *  user chooses to discard a pending compilation to make room for a new add. */
function discardPendingEntry(
  workspace: string | undefined,
  store: KnowledgeBaseStore,
  ctx: any,
) {
  const reg = store.readRegistry(workspace);
  for (const [hash, entry] of Object.entries(reg)) {
    if (!store.isEntryCompiled(entry)) {
      store.deleteSource(entry.sourcePath, workspace);
      delete reg[hash];
      store.writeRegistry(reg, workspace);
      ctx.ui.notify(`Discarded pending: ${entry.name}`, "info");
      return;
    }
  }
}

/** If a docName is already taken, append "-2", "-3", etc. until unique. */
function resolveDocNameCollision(
  docName: string,
  workspace: string | undefined,
  ctx: any,
  store: KnowledgeBaseStore,
): string {
  if (!store.isDocNameUsed(docName, workspace)) return docName;

  const base = docName;
  let suffix = 2;
  let candidate = `${base}-${suffix}`;
  while (store.isDocNameUsed(candidate, workspace)) {
    suffix++;
    candidate = `${base}-${suffix}`;
  }
  ctx.ui.notify(
    `Slug "${base}" already taken; using "${candidate}" instead.`,
    "warning",
  );
  return candidate;
}
