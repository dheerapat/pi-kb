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

  deleteWorkspace(name?: string): string {
    const wp = this.getWorkspaceRoot(name);

    if (!name || name === "default") {
      const keepDir = path.join(KB_ROOT, "workspaces");
      if (fs.existsSync(wp.root)) {
        for (const entry of fs.readdirSync(wp.root)) {
          const full = path.join(wp.root, entry);
          if (full === keepDir) continue;
          fs.rmSync(full, { recursive: true, force: true });
        }
      }
      return wp.root;
    }

    const wsDir = path.join(WORKSPACES_DIR, name);
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
    const frontmatter = [
      "---",
      `source: "${originalName}"`,
      `doc_source: "source/${originalName}"`,
      `added: "${addedAt}"`,
      "---",
    ].join("\n");
    const full = frontmatter + "\n\n" + content;
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
    let updated: string | undefined;
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
          } else if (trimmed.startsWith("updated:")) {
            updated = trimmed
              .slice("updated:".length)
              .trim()
              .replace(/^["']|["']$/g, "");
          }
        }
      }
    }

    return { slug, sources, updated, body };
  }

  writeConcept(
    slug: string,
    content: string,
    sources: string[],
    workspace?: string,
  ): void {
    const wp = this.getWorkspaceRoot(workspace);
    fs.mkdirSync(wp.conceptsDir, { recursive: true });
    const now = new Date().toISOString();
    const sourcesYaml = "[" + sources.map((s) => `"${s}"`).join(", ") + "]";
    const frontmatter = [
      "---",
      `sources: ${sourcesYaml}`,
      `updated: "${now}"`,
      "---",
    ].join("\n");
    const full = frontmatter + "\n\n" + content;
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
