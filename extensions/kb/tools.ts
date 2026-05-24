/**
 * tools.ts — LLM-callable tools for the KB extension.
 *
 * Registers: kb_read_index, kb_list_concepts, kb_read_concept,
 *            kb_read_summary, kb_write_summary, kb_write_concept,
 *            kb_update_index, kb_delete_concept, kb_delete_summary
 *
 * Every tool accepts an optional `workspace` parameter. The LLM receives
 * the workspace name in the prompt and passes it through.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { KnowledgeBaseStore } from "./ports/types";
import { isoNow } from "./utils";

export function registerTools(
  pi: ExtensionAPI,
  store: KnowledgeBaseStore,
) {
  // ── kb_read_index ────────────────────────────────────────
  pi.registerTool({
    name: "kb_read_index",
    label: "Read KB Index",
    description:
      "Read the knowledge base index.md file. Shows all documents and concepts with brief descriptions.",
    parameters: Type.Object({
      workspace: Type.Optional(
        Type.String({ description: "Workspace name (omit for default)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const content =
        store.readIndex(params.workspace) ||
        "(index is empty — no documents or concepts yet)";
      return {
        content: [{ type: "text" as const, text: content }],
        details: {},
      };
    },
  });

  // ── kb_list_concepts ─────────────────────────────────────
  pi.registerTool({
    name: "kb_list_concepts",
    label: "List KB Concepts",
    description: "List all concept slugs in the knowledge base.",
    parameters: Type.Object({
      workspace: Type.Optional(
        Type.String({ description: "Workspace name (omit for default)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const slugs = store.listConcepts(params.workspace);
      const text =
        slugs.length > 0
          ? slugs.map((s) => `- ${s}`).join("\n")
          : "(no concepts yet)";
      return {
        content: [{ type: "text" as const, text }],
        details: {},
      };
    },
  });

  // ── kb_read_concept ──────────────────────────────────────
  pi.registerTool({
    name: "kb_read_concept",
    label: "Read KB Concept",
    description: "Read the full content of a concept page by its slug.",
    parameters: Type.Object({
      slug: Type.String({
        description: "Concept slug (e.g. 'caching-strategy')",
      }),
      workspace: Type.Optional(
        Type.String({ description: "Workspace name (omit for default)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const info = store.readConcept(params.slug, params.workspace);
      if (!info) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Concept "${params.slug}" not found.`,
            },
          ],
          details: {},
        };
      }
      const header = `## ${params.slug}\nSources: ${info.sources.join(", ")}\n\n`;
      return {
        content: [{ type: "text" as const, text: header + info.body }],
        details: {},
      };
    },
  });

  // ── kb_read_summary ──────────────────────────────────────
  pi.registerTool({
    name: "kb_read_summary",
    label: "Read KB Summary",
    description: "Read the full content of a summary page by docName.",
    parameters: Type.Object({
      docName: Type.String({
        description: "Document name slug (e.g. 'architecture')",
      }),
      workspace: Type.Optional(
        Type.String({ description: "Workspace name (omit for default)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const text = store.readSummary(params.docName, params.workspace);
      if (!text) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Summary "${params.docName}" not found.`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `## Summary: ${params.docName}\n\n${text}`,
          },
        ],
        details: {},
      };
    },
  });

  // ── kb_write_summary ─────────────────────────────────────
  pi.registerTool({
    name: "kb_write_summary",
    label: "Write KB Summary",
    description:
      "Create or overwrite a summary page for a document. Use the docName passed to you in the compile instructions.",
    parameters: Type.Object({
      docName: Type.String({
        description: "Document name slug (e.g. 'architecture')",
      }),
      content: Type.String({
        description: "Full markdown summary (200-400 words)",
      }),
      workspace: Type.Optional(
        Type.String({ description: "Workspace name (omit for default)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const reg = store.readRegistry(params.workspace);
      const entry = Object.values(reg).find(
        (e) => e.docName === params.docName,
      );
      const originalName = entry?.name ?? `${params.docName}.md`;
      const addedAt = entry?.addedAt ?? isoNow();

      store.writeSummary(
        params.docName,
        params.content,
        originalName,
        addedAt,
        params.workspace,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Summary written: summaries/${params.docName}.md`,
          },
        ],
        details: {},
      };
    },
  });

  // ── kb_write_concept ─────────────────────────────────────
  pi.registerTool({
    name: "kb_write_concept",
    label: "Write KB Concept",
    description:
      "Create or update a concept page. Pass ALL sources that contributed to this concept (old + new).",
    parameters: Type.Object({
      slug: Type.String({
        description: "Concept slug (lowercase, hyphens, e.g. 'caching-strategy')",
      }),
      content: Type.String({
        description: "Full markdown concept page body",
      }),
      sources: Type.Array(Type.String(), {
        description:
          "List of source filenames (e.g. ['architecture.md', 'design.md'])",
      }),
      workspace: Type.Optional(
        Type.String({ description: "Workspace name (omit for default)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const existed = store.listConcepts(params.workspace).includes(params.slug);
      store.writeConcept(
        params.slug,
        params.content,
        params.sources,
        params.workspace,
      );
      const action = existed ? "updated" : "created";
      return {
        content: [
          {
            type: "text" as const,
            text: `Concept ${action}: concepts/${params.slug}.md (sources: ${params.sources.join(", ")})`,
          },
        ],
        details: {},
      };
    },
  });

  // ── kb_update_index ──────────────────────────────────────
  pi.registerTool({
    name: "kb_update_index",
    label: "Update KB Index",
    description:
      "Rebuild the knowledge base index.md from a COMPLETE list of all pages. Include every existing page, not just new ones.",
    parameters: Type.Object({
      entries: Type.Array(
        Type.Object({
          type: StringEnum(["summary", "concept"] as const),
          slug: Type.String({
            description: "Summary docName or concept slug",
          }),
          brief: Type.String({
            description: "One-liner description (under 120 chars)",
          }),
        }),
        { description: "Complete list of ALL pages in the wiki" },
      ),
      workspace: Type.Optional(
        Type.String({ description: "Workspace name (omit for default)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const docLines: string[] = [];
      const conceptLines: string[] = [];

      for (const entry of params.entries) {
        const line = `- [[${entry.type}/${entry.slug}]] — ${entry.brief}`;
        if (entry.type === "summary") {
          docLines.push(line);
        } else {
          conceptLines.push(line);
        }
      }

      const index = [
        "# Knowledge Base Index",
        "",
        "## Documents",
        ...(docLines.length > 0 ? docLines : ["(none)"]),
        "",
        "## Concepts",
        ...(conceptLines.length > 0 ? conceptLines : ["(none)"]),
        "",
      ].join("\n");

      store.writeIndex(index, params.workspace);

      // Mark all referenced summary docs as fully compiled
      const reg = store.readRegistry(params.workspace);
      let markedCount = 0;
      const now = isoNow();
      for (const entry of params.entries) {
        if (entry.type === "summary") {
          const docName = entry.slug;
          for (const [hash, regEntry] of Object.entries(reg)) {
            if (
              regEntry.docName === docName &&
              !store.isEntryCompiled(regEntry)
            ) {
              regEntry.compiled = true;
              regEntry.lastCompiledAt = now;
              markedCount++;
            }
          }
        }
      }
      if (markedCount > 0) {
        store.writeRegistry(reg, params.workspace);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Index updated: ${docLines.length} documents, ${conceptLines.length} concepts.`,
          },
        ],
        details: {},
      };
    },
  });

  // ── kb_delete_concept ────────────────────────────────────
  pi.registerTool({
    name: "kb_delete_concept",
    label: "Delete KB Concept",
    description:
      "Delete a concept page from the knowledge base. Use during /kb-remove when the concept had only the removed document as its source.",
    parameters: Type.Object({
      slug: Type.String({ description: "Concept slug to delete" }),
      workspace: Type.Optional(
        Type.String({ description: "Workspace name (omit for default)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const existed = store.deleteConcept(params.slug, params.workspace);
      if (existed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Concept deleted: concepts/${params.slug}.md`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Concept "${params.slug}" not found (already deleted or never existed).`,
          },
        ],
        details: {},
      };
    },
  });

  // ── kb_delete_summary ────────────────────────────────────
  pi.registerTool({
    name: "kb_delete_summary",
    label: "Delete KB Summary",
    description:
      "Delete a summary page from the knowledge base. Use during /kb-remove.",
    parameters: Type.Object({
      docName: Type.String({
        description: "Document name slug to delete",
      }),
      workspace: Type.Optional(
        Type.String({ description: "Workspace name (omit for default)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const existed = store.deleteSummary(params.docName, params.workspace);
      if (existed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Summary deleted: summaries/${params.docName}.md`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Summary "${params.docName}" not found.`,
          },
        ],
        details: {},
      };
    },
  });
}
