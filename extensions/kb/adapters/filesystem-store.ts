/**
 * adapters/filesystem-store.ts — File I/O implementation of KnowledgeBaseStore.
 *
 * All paths are relative to KB_ROOT (~/.pi/agent/kb/).
 * Named workspaces live under ~/.pi/agent/kb/workspaces/<name>/.
 * The default workspace lives directly under KB_ROOT.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { homedir } from "node:os";
import type {
  KnowledgeBaseStore,
  WorkspacePaths,
  Registry,
  RegistryEntry,
  ConceptInfo,
  WikiDump,
  CopyResult,
} from "../ports/types";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

export const KB_ROOT = path.join(homedir(), ".pi", "agent", "kb");
export const WORKSPACES_DIR = path.join(KB_ROOT, "workspaces");

// ---------------------------------------------------------------------------
// FilesystemStore
// ---------------------------------------------------------------------------

export class FilesystemStore implements KnowledgeBaseStore {
  // ── Paths ───────────────────────────────────────────────

  getWorkspaceRoot(name?: string): WorkspacePaths {
    const base =
      name && name !== "default" ? path.join(WORKSPACES_DIR, name) : KB_ROOT;

    return {
      root: base,
      registryPath: path.join(base, "registry.json"),
      sourceDir: path.join(base, "source"),
      wikiDir: path.join(base, "wiki"),
      summariesDir: path.join(base, "wiki", "summaries"),
      conceptsDir: path.join(base, "wiki", "concepts"),
      indexPath: path.join(base, "wiki", "index.md"),
    };
  }

  // ── Workspaces ──────────────────────────────────────────

  listWorkspaces(): string[] {
    if (!fs.existsSync(WORKSPACES_DIR)) return [];
    return fs
      .readdirSync(WORKSPACES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  workspaceExists(name: string): boolean {
    if (!name || name === "default") return this.kbExists();
    return fs.existsSync(path.join(WORKSPACES_DIR, name));
  }

  ensureKbDir(workspace?: string): boolean {
    const wp = this.getWorkspaceRoot(workspace);
    const isNew = !fs.existsSync(wp.root);

    fs.mkdirSync(wp.root, { recursive: true });
    fs.mkdirSync(wp.sourceDir, { recursive: true });
    fs.mkdirSync(wp.summariesDir, { recursive: true });
    fs.mkdirSync(wp.conceptsDir, { recursive: true });

    if (!fs.existsSync(wp.registryPath)) {
      fs.writeFileSync(wp.registryPath, JSON.stringify({}, null, 2), "utf-8");
    }
    if (!fs.existsSync(wp.indexPath)) {
      fs.writeFileSync(
        wp.indexPath,
        "# Knowledge Base Index\n\n## Documents\n\n## Concepts\n",
        "utf-8",
      );
    }
    return isNew;
  }

  kbExists(workspace?: string): boolean {
    const wp = this.getWorkspaceRoot(workspace);
    return fs.existsSync(wp.root);
  }

  clearWorkspace(name?: string): string {
    const wp = this.getWorkspaceRoot(name);
    for (const p of [wp.sourceDir, wp.wikiDir, wp.registryPath]) {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
    return wp.root;
  }

  deleteWorkspace(name?: string): string {
    // Only for named workspaces. Use clearWorkspace to clear the default workspace.
    const wsDir = path.join(WORKSPACES_DIR, name!);
    if (fs.existsSync(wsDir)) {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
    return wsDir;
  }

  // ── Hashing ─────────────────────────────────────────────

  hashContent(content: string): string {
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  }

  hashFile(filePath: string): string {
    const content = fs.readFileSync(filePath, "utf-8");
    return this.hashContent(content);
  }

  // ── Registry ────────────────────────────────────────────

  readRegistry(workspace?: string): Registry {
    const wp = this.getWorkspaceRoot(workspace);
    if (!fs.existsSync(wp.registryPath)) return {};
    const raw = fs.readFileSync(wp.registryPath, "utf-8");
    try {
      return JSON.parse(raw) as Registry;
    } catch {
      return {};
    }
  }

  writeRegistry(registry: Registry, workspace?: string): void {
    const wp = this.getWorkspaceRoot(workspace);
    fs.writeFileSync(
      wp.registryPath,
      JSON.stringify(registry, null, 2),
      "utf-8",
    );
  }

  isDocNameUsed(docName: string, workspace?: string): boolean {
    const reg = this.readRegistry(workspace);
    return Object.values(reg).some((e) => e.docName === docName);
  }

  normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
        parsed.pathname = parsed.pathname.slice(0, -1);
      }
      if (
        (parsed.protocol === "https:" && parsed.port === "443") ||
        (parsed.protocol === "http:" && parsed.port === "80")
      ) {
        parsed.port = "";
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  isUrlInRegistry(url: string, workspace?: string): boolean {
    const normalized = this.normalizeUrl(url);
    const reg = this.readRegistry(workspace);
    return Object.values(reg).some(
      (e) => this.normalizeUrl(e.originalPath) === normalized,
    );
  }

  findByUrl(url: string, workspace?: string): RegistryEntry | null {
    const normalized = this.normalizeUrl(url);
    const reg = this.readRegistry(workspace);
    return (
      Object.values(reg).find(
        (e) => this.normalizeUrl(e.originalPath) === normalized,
      ) ?? null
    );
  }

  // ── Source files ────────────────────────────────────────

  copySource(absPath: string, workspace?: string): CopyResult {
    const wp = this.getWorkspaceRoot(workspace);
    const name = path.basename(absPath);
    const destAbs = path.join(wp.sourceDir, name);
    if (fs.existsSync(destAbs)) {
      throw new Error(
        `A file named "${name}" already exists in the KB source/ directory.\n` +
          `Rename your file on disk before adding it.`,
      );
    }
    fs.copyFileSync(absPath, destAbs);
    return { destRel: `source/${name}`, destAbs };
  }

  writeSourceContent(
    filename: string,
    content: string,
    workspace?: string,
  ): CopyResult {
    const wp = this.getWorkspaceRoot(workspace);
    const destAbs = path.join(wp.sourceDir, filename);
    if (fs.existsSync(destAbs)) {
      throw new Error(
        `A file named "${filename}" already exists in the KB source/ directory.`,
      );
    }
    fs.writeFileSync(destAbs, content, "utf-8");
    return { destRel: `source/${filename}`, destAbs };
  }

  readSource(destRel: string, workspace?: string): string {
    const wp = this.getWorkspaceRoot(workspace);
    return fs.readFileSync(path.join(wp.root, destRel), "utf-8");
  }

  deleteSource(sourcePath: string, workspace?: string): boolean {
    const wp = this.getWorkspaceRoot(workspace);
    const p = path.join(wp.root, sourcePath);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }

  // ── Index ───────────────────────────────────────────────

  readIndex(workspace?: string): string {
    const wp = this.getWorkspaceRoot(workspace);
    if (!fs.existsSync(wp.indexPath)) return "";
    return fs.readFileSync(wp.indexPath, "utf-8");
  }

  writeIndex(content: string, workspace?: string): void {
    const wp = this.getWorkspaceRoot(workspace);
    fs.mkdirSync(wp.wikiDir, { recursive: true });
    fs.writeFileSync(wp.indexPath, content, "utf-8");
  }

  // ── Summaries ───────────────────────────────────────────

  listSummaries(workspace?: string): string[] {
    const wp = this.getWorkspaceRoot(workspace);
    if (!fs.existsSync(wp.summariesDir)) return [];
    return fs
      .readdirSync(wp.summariesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  }

  readSummary(docName: string, workspace?: string): string | null {
    const wp = this.getWorkspaceRoot(workspace);
    const p = path.join(wp.summariesDir, `${docName}.md`);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf-8");
  }

  writeSummary(
    docName: string,
    content: string,
    originalName: string,
    addedAt: string,
    workspace?: string,
  ): void {
    const wp = this.getWorkspaceRoot(workspace);
    fs.mkdirSync(wp.summariesDir, { recursive: true });

    // Frontmatter
    const frontmatter = [
      "---",
      `name: "${docName}"`,
      `source: "${originalName}"`,
      `date_added: "${addedAt}"`,
      "---",
    ].join("\n");

    // Deterministic footer: extract [[concept/...]] links from body
    const conceptLinks = extractConceptLinks(content);
    const footer = buildSummaryFooter(conceptLinks);

    const full = frontmatter + "\n\n" + content + "\n\n" + footer;
    fs.writeFileSync(
      path.join(wp.summariesDir, `${docName}.md`),
      full,
      "utf-8",
    );
  }

  deleteSummary(docName: string, workspace?: string): boolean {
    const wp = this.getWorkspaceRoot(workspace);
    const p = path.join(wp.summariesDir, `${docName}.md`);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }

  // ── Concepts ────────────────────────────────────────────

  listConcepts(workspace?: string): string[] {
    const wp = this.getWorkspaceRoot(workspace);
    if (!fs.existsSync(wp.conceptsDir)) return [];
    return fs
      .readdirSync(wp.conceptsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  }

  readConcept(slug: string, workspace?: string): ConceptInfo | null {
    const wp = this.getWorkspaceRoot(workspace);
    const p = path.join(wp.conceptsDir, `${slug}.md`);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");

    let sources: string[] = [];
    let dateAdded: string | undefined;
    let needsReview = false;
    let body = raw;

    if (raw.startsWith("---")) {
      const end = raw.indexOf("---", 3);
      if (end !== -1) {
        const fm = raw.slice(3, end);
        body = raw.slice(end + 3).trimStart();

        for (const line of fm.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("sources:")) {
            const match = trimmed.match(/sources:\s*\[(.*)\]/);
            if (match) {
              sources = match[1]
                .split(",")
                .map((s) => s.trim().replace(/^["']|["']$/g, ""))
                .filter(Boolean);
            }
          } else if (trimmed.startsWith("date_added:")) {
            dateAdded = trimmed
              .slice("date_added:".length)
              .trim()
              .replace(/^["']|["']$/g, "");
          } else if (trimmed.startsWith("updated:")) {
            // Legacy field — use as date_added fallback
            if (!dateAdded) {
              dateAdded = trimmed
                .slice("updated:".length)
                .trim()
                .replace(/^["']|["']$/g, "");
            }
          } else if (trimmed.startsWith("needs_review:")) {
            const val = trimmed.slice("needs_review:".length).trim();
            needsReview = val === "true";
          }
        }
      }
    }

    // Strip deterministic footer (--- separator + Sources section) from body
    const footerSep = body.lastIndexOf("\n\n---\n");
    if (footerSep !== -1) {
      const afterSep = body.slice(footerSep + 1).trimStart();
      if (afterSep.startsWith("---") && afterSep.includes("**Sources**")) {
        body = body.slice(0, footerSep);
      }
    }

    return { slug, sources, dateAdded, needsReview, body };
  }

  writeConcept(
    slug: string,
    content: string,
    sources: string[],
    workspace?: string,
    needsReview?: boolean,
  ): void {
    const wp = this.getWorkspaceRoot(workspace);
    fs.mkdirSync(wp.conceptsDir, { recursive: true });
    const now = new Date().toISOString();
    const sourcesYaml = "[" + sources.map((s) => `"${s}"`).join(", ") + "]";
    const needsReviewStr = needsReview === true ? "true" : "false";

    const frontmatter = [
      "---",
      `name: "${slug}"`,
      `sources: ${sourcesYaml}`,
      `date_added: "${now}"`,
      `needs_review: ${needsReviewStr}`,
      "---",
    ].join("\n");

    // Deterministic footer: links back to each source summary
    const footer = buildConceptFooter(sources);

    const full = frontmatter + "\n\n" + content + "\n\n" + footer;
    fs.writeFileSync(path.join(wp.conceptsDir, `${slug}.md`), full, "utf-8");
  }

  deleteConcept(slug: string, workspace?: string): boolean {
    const wp = this.getWorkspaceRoot(workspace);
    const p = path.join(wp.conceptsDir, `${slug}.md`);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }

  // ── Compilation tracking ────────────────────────────────

  isEntryCompiled(entry: RegistryEntry): boolean {
    return entry.compiled !== false;
  }

  countPendingCompilations(workspace?: string): number {
    const reg = this.readRegistry(workspace);
    return Object.values(reg).filter((e) => !this.isEntryCompiled(e)).length;
  }

  // ── Wiki dump ───────────────────────────────────────────

  dumpWiki(workspace?: string): WikiDump {
    const summaries: Record<string, string> = {};
    for (const name of this.listSummaries(workspace)) {
      const s = this.readSummary(name, workspace);
      if (s) summaries[name] = s;
    }

    const concepts: Record<string, string> = {};
    for (const slug of this.listConcepts(workspace)) {
      const c = this.readConcept(slug, workspace);
      if (c) concepts[slug] = c.body;
    }

    return {
      index: this.readIndex(workspace),
      summaries,
      concepts,
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic footer builders
// ---------------------------------------------------------------------------

/** Extract unique [[concept/...]] slugs from markdown body text. */
function extractConceptLinks(body: string): string[] {
  const seen = new Set<string>();
  const regex = /\[\[concept\/([^\]|#]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    seen.add(match[1]);
  }
  return [...seen].sort();
}

function buildSummaryFooter(conceptSlugs: string[]): string {
  if (conceptSlugs.length === 0) {
    return "---\n\n*No concepts reference this document yet.*";
  }
  return (
    "---\n" +
    "\n" +
    "**Concepts**\n" +
    conceptSlugs.map((s) => `[[concept/${s}]]`).join("\n") +
    "\n"
  );
}

function buildConceptFooter(sources: string[]): string {
  if (sources.length === 0) {
    return "---\n\n*No sources.*";
  }
  return (
    "---\n" +
    "\n" +
    "**Sources**\n" +
    sources.map((s) => `[[${s}]]`).join("\n") +
    "\n"
  );
}

// ---------------------------------------------------------------------------
// Post-compile summary footer sync
// ---------------------------------------------------------------------------

/**
 * Regenerate `**Concepts**` footers in all summary files by scanning
 * concept sources to find which concepts reference each summary.
 * Called at the end of compilation (in kb_update_index) so summary
 * footers are always in sync with concept source lists.
 */
export function syncSummaryFooters(
  store: FilesystemStore,
  workspace?: string,
): void {
  const wp = store.getWorkspaceRoot(workspace);
  const summaries = store.listSummaries(workspace);
  const conceptSlugs = store.listConcepts(workspace);

  // Build map: summary docName → concept slugs that reference it
  const refs = new Map<string, string[]>();
  for (const s of summaries) refs.set(s, []);

  for (const slug of conceptSlugs) {
    const c = store.readConcept(slug, workspace);
    if (!c) continue;
    for (const src of c.sources) {
      const docName = extractDocNameFromSource(src);
      if (docName && refs.has(docName)) {
        refs.get(docName)!.push(slug);
      }
    }
  }

  // Update each summary's footer in place
  for (const [docName, slugs] of refs) {
    const summaryPath = path.join(wp.summariesDir, `${docName}.md`);
    if (!fs.existsSync(summaryPath)) continue;

    const raw = fs.readFileSync(summaryPath, "utf-8");

    // Parse frontmatter
    let frontmatter = "";
    let body = raw;
    if (raw.startsWith("---")) {
      const end = raw.indexOf("---", 3);
      if (end !== -1) {
        frontmatter = raw.slice(0, end + 3);
        body = raw.slice(end + 3).trimStart();
      }
    }

    // Strip any existing trailing --- footer separator
    const lastSep = body.lastIndexOf("\n---\n");
    if (lastSep !== -1) {
      body = body.slice(0, lastSep).trimEnd();
    }

    // Build deterministic footer from actual concept references
    const deduped = [...new Set(slugs)].sort();
    const footer =
      deduped.length > 0
        ? "---\n\n**Concepts**\n" +
          deduped.map((s) => `[[concept/${s}]]`).join("\n") + "\n"
        : "---\n\n*No concepts reference this document yet.*";

    const full = frontmatter + "\n\n" + body + "\n\n" + footer;
    fs.writeFileSync(summaryPath, full, "utf-8");
  }
}

/** Extract docName from a source reference like "summary/arch" → "arch", "file.md" → "file" */
function extractDocNameFromSource(src: string): string | null {
  if (src.startsWith("summary/")) return src.slice("summary/".length);
  // Legacy format: "filename.md"
  return src.replace(/\.md$/, "");
}
