/**
 * index.ts — Entry point for the pi-native KB extension.
 *
 * Registers:
 *  - Commands: /kb-add, /kb-query, /kb-list, /kb-status, /kb-remove
 *  - Tools: kb_read_index, kb_list_concepts, kb_read_concept,
 *           kb_read_summary, kb_write_summary, kb_write_concept,
 *           kb_update_index, kb_delete_concept, kb_delete_summary
 *
 * The extension provides file I/O; pi's own LLM does the intelligence.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";

import { convert } from "@kreuzberg/html-to-markdown-node";
import * as https from "node:https";
import * as http from "node:http";

import {
  KB_ROOT,
  ensureKbDir,
  kbExists,
  hashContent,
  hashFile,
  isInRegistry,
  isDocNameUsed,
  isUrlInRegistry,
  findByUrl,
  normalizeUrl,
  copySource,
  writeSourceContent,
  readIndex,
  writeIndex,
  listSummaries,
  readSummary,
  writeSummary,
  listConcepts,
  readConcept,
  writeConcept,
  deleteConcept,
  deleteSummary,
  readRegistry,
  writeRegistry,
  type RegistryEntry,
} from "./store";

import {
  buildCompilePrompt,
  buildQueryPrompt,
  buildRemovePrompt,
} from "./prompts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docNameFromFile(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function isoNow(): string {
  return new Date().toISOString();
}

function resolvePath(input: string, cwd: string): string {
  if (path.isAbsolute(input)) return input;
  return path.resolve(cwd, input);
}

function isUrl(str: string): boolean {
  return /^https?:\/\//i.test(str);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function docNameFromUrl(url: string, metadataTitle?: string | null): string {
  if (metadataTitle) {
    const slug = slugify(metadataTitle);
    if (slug.length > 0) return slug;
  }
  try {
    const { pathname } = new URL(url);
    const lastSegment = pathname.split("/").filter(Boolean).pop();
    if (lastSegment) {
      const withoutExt = lastSegment.replace(/\.[^.]+$/, "");
      const candidate = slugify(withoutExt);
      if (candidate.length > 0) return candidate;
    }
  } catch {}
  try {
    const { hostname } = new URL(url);
    return slugify(hostname.replace(/^www\./, ""));
  } catch {
    return slugify(url).slice(0, 40);
  }
}

/**
 * Fetch a URL and convert HTML → Markdown.
 * Uses node:https directly (not fetch/undici) to avoid version conflicts
 * with the undici npm package pulled in by pi-coding-agent.
 */
async function fetchAndConvert(url: string): Promise<{
  content: string;
  title: string | null;
}> {
  const html = await httpGet(url);

  if (html.trim().length === 0) {
    throw new Error("Fetched content is empty");
  }

  const result = convert(html);
  if (!result.content || result.content.trim().length === 0) {
    throw new Error("HTML to markdown conversion produced empty output");
  }

  return {
    content: result.content,
    title: result.metadata?.document?.title ?? null,
  };
}

/** Simple HTTP GET with redirect-following, IPv4-only, and timeout. */
function httpGet(targetUrl: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = 30_000;

    const doGet = (urlStr: string, redirectsLeft: number) => {
      const parsed = new URL(urlStr);
      const mod = parsed.protocol === "https:" ? https : http;

      const req = mod.get(
        urlStr,
        {
          headers: {
            "User-Agent": "pi-kb/0.1.0",
            Accept: "text/html, text/plain",
          },
          family: 4, // force IPv4 — avoids IPv6 timeouts
          timeout,
        },
        (res) => {
          // Redirect
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (redirectsLeft <= 0) {
              reject(new Error("Too many redirects"));
              return;
            }
            // Consume response
            res.resume();
            doGet(
              new URL(res.headers.location, urlStr).toString(),
              redirectsLeft - 1,
            );
            return;
          }

          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${res.statusMessage || "error"}`,
              ),
            );
            res.resume();
            return;
          }

          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");
            resolve(body);
          });
          res.on("error", reject);
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("Request timed out"));
      });
    };

    doGet(targetUrl, maxRedirects);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  // /kb-add <paths...>
  pi.registerCommand("kb-add", {
    description: "Add markdown files or URLs to the knowledge base",
    handler: async (args, ctx) => {
      if (!args || !args.trim()) {
        ctx.ui.notify("Usage: /kb-add <file.md> [file2.md ...]", "warning");
        return;
      }

      const filePaths = args
        .split(/\s+/)
        .map((s) => s.trim().replace(/^@/, "")) // strip pi's @ prefix
        .filter(Boolean);

      const { cwd } = ctx;

      for (const fp of filePaths) {
        // ── URL branch ───────────────────────────────────────
        if (isUrl(fp)) {
          ensureKbDir();

          // Fetch & convert HTML → Markdown
          let converted: { content: string; title: string | null };
          try {
            ctx.ui.notify(`Fetching: ${fp}`, "info");
            converted = await fetchAndConvert(fp);
          } catch (e: any) {
            ctx.ui.notify(`Failed to fetch ${fp}: ${e.message}`, "error");
            continue;
          }

          const content = converted.content;
          const docName = docNameFromUrl(fp, converted.title);

          // Dedup by URL (content hashing unreliable for dynamic pages)
          const fileHash = hashContent(content);
          if (isUrlInRegistry(fp)) {
            const existing = findByUrl(fp)!;
            ctx.ui.notify(
              `Already in KB: ${fp} (added ${existing.addedAt.slice(0, 10)})`,
              "warning",
            );
            continue;
          }

          // Doc-name collision check
          if (isDocNameUsed(docName)) {
            // Append a suffix to make it unique
            const base = docName;
            let suffix = 2;
            let candidate = `${base}-${suffix}`;
            while (isDocNameUsed(candidate)) {
              suffix++;
              candidate = `${base}-${suffix}`;
            }
            ctx.ui.notify(
              `Slug "${base}" already taken; using "${candidate}" instead.`,
              "warning",
            );
            // Use the unique candidate docName
            const finalDocName = candidate;
            const finalFilename = `${finalDocName}.md`;

            // Write source
            let sourceRel: string;
            try {
              const wsc = writeSourceContent(finalFilename, content);
              sourceRel = wsc.destRel;
            } catch (e: any) {
              ctx.ui.notify(`Failed to save source: ${e.message}`, "error");
              continue;
            }

            const normalizedUrl = normalizeUrl(fp);
            const entry: RegistryEntry = {
              name: finalFilename,
              sourcePath: sourceRel,
              originalPath: normalizedUrl,
              docName: finalDocName,
              addedAt: isoNow(),
            };
            const reg = readRegistry();
            reg[fileHash] = entry;
            writeRegistry(reg);

            ctx.ui.notify(`Added: ${fp} → ${finalFilename}`, "info");
            const prompt = buildCompilePrompt(
              finalFilename,
              finalDocName,
              content,
            );
            pi.sendUserMessage(prompt);
            continue;
          }

          const filename = `${docName}.md`;

          // Write source file
          let sourceRel: string;
          try {
            const wsc = writeSourceContent(filename, content);
            sourceRel = wsc.destRel;
          } catch (e: any) {
            ctx.ui.notify(`Failed to save source: ${e.message}`, "error");
            continue;
          }

          // Add to registry
          const normalizedUrl = normalizeUrl(fp);
          const entry: RegistryEntry = {
            name: filename,
            sourcePath: sourceRel,
            originalPath: normalizedUrl,
            docName,
            addedAt: isoNow(),
          };
          const reg = readRegistry();
          reg[fileHash] = entry;
          writeRegistry(reg);

          ctx.ui.notify(`Added: ${fp} → ${filename}`, "info");

          const prompt = buildCompilePrompt(filename, docName, content);
          pi.sendUserMessage(prompt);
          continue;
        }

        // ── File branch ─────────────────────────────────────
        const absPath = resolvePath(fp, cwd);

        // Validate file
        if (!fs.existsSync(absPath)) {
          ctx.ui.notify(`File not found: ${fp}`, "error");
          continue;
        }
        if (path.extname(absPath).toLowerCase() !== ".md") {
          ctx.ui.notify(`Only .md files are supported: ${fp}`, "error");
          continue;
        }

        // Read and hash
        let content: string;
        try {
          content = fs.readFileSync(absPath, "utf-8");
        } catch (e: any) {
          ctx.ui.notify(`Failed to read ${fp}: ${e.message}`, "error");
          continue;
        }

        if (content.trim().length === 0) {
          ctx.ui.notify(`File is empty: ${fp}`, "warning");
          continue;
        }

        const fileHash = hashFile(absPath);

        // Auto-create KB on first use
        ensureKbDir();

        // Dedup by hash
        if (isInRegistry(fileHash)) {
          const existing = readRegistry()[fileHash];
          ctx.ui.notify(
            `Already in KB: ${fp} (added ${existing.addedAt.slice(0, 10)})`,
            "warning",
          );
          continue;
        }

        // Check filename collision
        const originalName = path.basename(absPath);
        const docName = docNameFromFile(absPath);

        // Check if docName slug is taken
        if (isDocNameUsed(docName)) {
          ctx.ui.notify(
            `A document with slug "${docName}" already exists in the KB.\n` +
              `Rename your file to something unique before adding it.`,
            "error",
          );
          continue;
        }

        // Copy source
        let sourceRel: string;
        try {
          const copied = copySource(absPath);
          sourceRel = copied.destRel;
        } catch (e: any) {
          ctx.ui.notify(`Failed to copy source: ${e.message}`, "error");
          continue;
        }

        // Add to registry
        const entry: RegistryEntry = {
          name: originalName,
          sourcePath: sourceRel,
          originalPath: absPath,
          docName,
          addedAt: isoNow(),
        };
        const reg = readRegistry();
        reg[fileHash] = entry;
        writeRegistry(reg);

        ctx.ui.notify(`Added: ${originalName}`, "info");

        // Inject compile prompt into session
        const prompt = buildCompilePrompt(originalName, docName, content);
        pi.sendUserMessage(prompt);
      }
    },
  });

  // /kb-query <question>
  pi.registerCommand("kb-query", {
    description: "Ask a question against the knowledge base",
    handler: async (args, ctx) => {
      if (!kbExists()) {
        ctx.ui.notify("No knowledge base found. Use /kb-add first.", "warning");
        return;
      }

      if (!args || !args.trim()) {
        ctx.ui.notify("Usage: /kb-query <question>", "warning");
        return;
      }

      const question = args.trim();
      const prompt = buildQueryPrompt(question);
      pi.sendUserMessage(prompt);
    },
  });

  // /kb-list
  pi.registerCommand("kb-list", {
    description: "List all documents and concepts in the knowledge base",
    handler: async (_args, ctx) => {
      if (!kbExists()) {
        ctx.ui.notify("No knowledge base found.", "info");
        return;
      }

      const summaries = listSummaries();
      const concepts = listConcepts();
      const reg = readRegistry();

      // Build a notification message
      const lines: string[] = [];

      if (summaries.length === 0 && concepts.length === 0) {
        lines.push("KB is empty. Use /kb-add to add documents.");
      } else {
        lines.push("## Knowledge Base");
        lines.push("");

        if (summaries.length > 0) {
          lines.push(`**Documents (${summaries.length}):**`);
          for (const name of summaries) {
            const entry = Object.values(reg).find((e) => e.docName === name);
            const source = entry ? entry.name : "?";
            const added = entry ? entry.addedAt.slice(0, 10) : "?";
            lines.push(
              `  - [[summary/${name}]] (source: ${source}, added: ${added})`,
            );
          }
          lines.push("");
        }

        if (concepts.length > 0) {
          lines.push(`**Concepts (${concepts.length}):**`);
          for (const slug of concepts) {
            const c = readConcept(slug);
            const srcs = c ? c.sources.join(", ") : "?";
            lines.push(`  - [[concept/${slug}]] (sources: ${srcs})`);
          }
        }
      }

      // Display as notification without injecting into LLM session
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /kb-status
  pi.registerCommand("kb-status", {
    description: "Show knowledge base statistics",
    handler: async (_args, ctx) => {
      if (!kbExists()) {
        ctx.ui.notify("No knowledge base found.", "info");
        return;
      }

      const summaryCount = listSummaries().length;
      const conceptCount = listConcepts().length;
      const reg = readRegistry();
      const regCount = Object.keys(reg).length;

      const lastEntry = Object.values(reg).sort(
        (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
      )[0];

      const lines = [
        "## KB Status",
        "",
        `  Root: \`${KB_ROOT}\``,
        `  Sources: ${regCount}`,
        `  Summaries: ${summaryCount}`,
        `  Concepts: ${conceptCount}`,
        `  Last add: ${lastEntry ? `${lastEntry.name} (${lastEntry.addedAt.slice(0, 10)})` : "never"}`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /kb-remove <docName>
  pi.registerCommand("kb-remove", {
    description: "Remove a document from the knowledge base by docName",
    handler: async (args, ctx) => {
      if (!kbExists()) {
        ctx.ui.notify("No knowledge base found.", "warning");
        return;
      }

      if (!args || !args.trim()) {
        ctx.ui.notify("Usage: /kb-remove <docName>", "warning");
        return;
      }

      const docName = args.trim();
      const reg = readRegistry();
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
      ctx.ui.notify(`Removing: ${entry.name} (${docName})`, "info");

      // Inject remove prompt into session
      const prompt = buildRemovePrompt(docName, entry.name);
      pi.sendUserMessage(prompt);

      // Clean up registry immediately (the LLM handles wiki cleanup)
      delete reg[hash];
      writeRegistry(reg);
    },
  });

  // -----------------------------------------------------------------------
  // Tools (for LLM to use during compilation/query/removal)
  // -----------------------------------------------------------------------

  // kb_read_index
  pi.registerTool({
    name: "kb_read_index",
    label: "Read KB Index",
    description:
      "Read the knowledge base index.md file. Shows all documents and concepts with brief descriptions.",
    parameters: Type.Object({}),
    async execute() {
      const content =
        readIndex() || "(index is empty — no documents or concepts yet)";
      return {
        content: [{ type: "text" as const, text: content }],
        details: {},
      };
    },
  });

  // kb_list_concepts
  pi.registerTool({
    name: "kb_list_concepts",
    label: "List KB Concepts",
    description: "List all concept slugs in the knowledge base.",
    parameters: Type.Object({}),
    async execute() {
      const slugs = listConcepts();
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

  // kb_read_concept
  pi.registerTool({
    name: "kb_read_concept",
    label: "Read KB Concept",
    description: "Read the full content of a concept page by its slug.",
    parameters: Type.Object({
      slug: Type.String({
        description: "Concept slug (e.g. 'caching-strategy')",
      }),
    }),
    async execute(_toolCallId, params) {
      const info = readConcept(params.slug);
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

  // kb_read_summary
  pi.registerTool({
    name: "kb_read_summary",
    label: "Read KB Summary",
    description: "Read the full content of a summary page by docName.",
    parameters: Type.Object({
      docName: Type.String({
        description: "Document name slug (e.g. 'architecture')",
      }),
    }),
    async execute(_toolCallId, params) {
      const text = readSummary(params.docName);
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

  // kb_write_summary
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
    }),
    async execute(_toolCallId, params) {
      const reg = readRegistry();
      const entry = Object.values(reg).find(
        (e) => e.docName === params.docName,
      );
      const originalName = entry?.name ?? `${params.docName}.md`;
      const addedAt = entry?.addedAt ?? isoNow();

      writeSummary(params.docName, params.content, originalName, addedAt);

      // Update lastCompiledAt
      if (entry) {
        entry.lastCompiledAt = isoNow();
        const hash = Object.keys(reg).find(
          (k) => reg[k].docName === params.docName,
        );
        if (hash) {
          reg[hash] = entry;
          writeRegistry(reg);
        }
      }

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

  // kb_write_concept
  pi.registerTool({
    name: "kb_write_concept",
    label: "Write KB Concept",
    description:
      "Create or update a concept page. Pass ALL sources that contributed to this concept (old + new).",
    parameters: Type.Object({
      slug: Type.String({
        description:
          "Concept slug (lowercase, hyphens, e.g. 'caching-strategy')",
      }),
      content: Type.String({
        description: "Full markdown concept page body",
      }),
      sources: Type.Array(Type.String(), {
        description:
          "List of source filenames (e.g. ['architecture.md', 'design.md'])",
      }),
    }),
    async execute(_toolCallId, params) {
      const existed = listConcepts().includes(params.slug);
      writeConcept(params.slug, params.content, params.sources);
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

  // kb_update_index
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

      writeIndex(index);
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

  // kb_delete_concept
  pi.registerTool({
    name: "kb_delete_concept",
    label: "Delete KB Concept",
    description:
      "Delete a concept page from the knowledge base. Use during /kb-remove when the concept had only the removed document as its source.",
    parameters: Type.Object({
      slug: Type.String({ description: "Concept slug to delete" }),
    }),
    async execute(_toolCallId, params) {
      const existed = deleteConcept(params.slug);
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

  // kb_delete_summary
  pi.registerTool({
    name: "kb_delete_summary",
    label: "Delete KB Summary",
    description:
      "Delete a summary page from the knowledge base. Use during /kb-remove.",
    parameters: Type.Object({
      docName: Type.String({
        description: "Document name slug to delete",
      }),
    }),
    async execute(_toolCallId, params) {
      const existed = deleteSummary(params.docName);
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

  // -----------------------------------------------------------------------
  // session_start hook
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, _ctx) => {
    if (kbExists()) {
      const summaryCount = listSummaries().length;
      const conceptCount = listConcepts().length;
      if (summaryCount > 0 || conceptCount > 0) {
        // Log to console for visibility — notify might be too noisy
        console.log(
          `[kb] Loaded: ${summaryCount} docs, ${conceptCount} concepts (${KB_ROOT})`,
        );
      }
    }
  });
}
