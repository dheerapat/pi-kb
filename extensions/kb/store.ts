/**
 * store.ts — File I/O layer for the pi-native KB extension.
 *
 * All paths are relative to KB_ROOT (~/.pi/agent/kb/).
 * Handles workspace resolution, directory creation, registry, source
 * copying, and wiki read/write.
 *
 * Workspaces:
 *   - The KB root (~/.pi/agent/kb/) is the "default" workspace.
 *   - Named workspaces live under ~/.pi/agent/kb/workspaces/<name>/.
 *   - Every public function accepts an optional `workspace` parameter.
 *     Pass a string for a named workspace; omit/undefined for default.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Paths (default workspace)
// ---------------------------------------------------------------------------

export const KB_ROOT = path.join(homedir(), ".pi", "agent", "kb");
export const WORKSPACES_DIR = path.join(KB_ROOT, "workspaces");

// ---------------------------------------------------------------------------
// Workspace path resolution
// ---------------------------------------------------------------------------

export interface WorkspacePaths {
  root: string;
  registryPath: string;
  sourceDir: string;
  wikiDir: string;
  summariesDir: string;
  conceptsDir: string;
  indexPath: string;
}

/** Resolve a workspace name to its full directory structure.
 *  Passing undefined, null, "" or "default" returns the default workspace. */
export function getWorkspaceRoot(name?: string): WorkspacePaths {
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

/** List all named workspaces (excludes "default"). */
export function listWorkspaces(): string[] {
  if (!fs.existsSync(WORKSPACES_DIR)) return [];
  return fs
    .readdirSync(WORKSPACES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Check if a named workspace exists. */
export function workspaceExists(name: string): boolean {
  if (!name || name === "default") return kbExists();
  return fs.existsSync(path.join(WORKSPACES_DIR, name));
}

/** Delete a workspace entirely.
 *  For named workspaces, the whole directory under workspaces/ is removed.
 *  For "default", the source/, wiki/, and registry.json are cleared, but
 *  the workspaces/ subdirectory is left intact.
 *  Returns the deleted workspace root path. */
export function deleteWorkspace(name?: string): string {
  const wp = getWorkspaceRoot(name);

  if (!name || name === "default") {
    // Default workspace: clear contents, keep workspaces/ subdirectory
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

  // Named workspace: delete the whole directory
  const wsDir = path.join(WORKSPACES_DIR, name);
  if (fs.existsSync(wsDir)) {
    fs.rmSync(wsDir, { recursive: true, force: true });
  }
  return wsDir;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  /** Original filename (e.g. "architecture.md") */
  name: string;
  /** Path to the copy in source/ (relative to workspace root) */
  sourcePath: string;
  /** Original absolute path where the file came from */
  originalPath: string;
  /** Slug used in summaries/ and concepts/ (filename without extension) */
  docName: string;
  /** ISO timestamp of first add */
  addedAt: string;
  /** ISO timestamp of last compilation */
  lastCompiledAt?: string;
  /** True only after ALL wiki artifacts (summary, concepts, index) are written.
   *  Set by kb_update_index (the final compilation step). Used to detect
   *  interrupted compilations where registry was written but LLM didn't finish. */
  compiled: boolean;
}

export type Registry = Record<string, RegistryEntry>;

export interface ConceptInfo {
  slug: string;
  sources: string[];
  updated?: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Directory setup
// ---------------------------------------------------------------------------

/** Create the full KB directory tree for a workspace if it doesn't exist.
 *  Returns true if this was a first-time creation (the workspace root was missing). */
export function ensureKbDir(workspace?: string): boolean {
  const wp = getWorkspaceRoot(workspace);
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

/** True if the workspace has been initialized (its root dir exists). */
export function kbExists(workspace?: string): boolean {
  const wp = getWorkspaceRoot(workspace);
  return fs.existsSync(wp.root);
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf-8");
  return hashContent(content);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function readRegistry(workspace?: string): Registry {
  const wp = getWorkspaceRoot(workspace);
  if (!fs.existsSync(wp.registryPath)) return {};
  const raw = fs.readFileSync(wp.registryPath, "utf-8");
  try {
    return JSON.parse(raw) as Registry;
  } catch {
    return {};
  }
}

export function writeRegistry(registry: Registry, workspace?: string): void {
  const wp = getWorkspaceRoot(workspace);
  fs.writeFileSync(wp.registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

/** Check if hash is already in registry. */
export function isInRegistry(hash: string, workspace?: string): boolean {
  const reg = readRegistry(workspace);
  return hash in reg;
}

/** Check if a docName (slug) is already used in registry. */
export function isDocNameUsed(docName: string, workspace?: string): boolean {
  const reg = readRegistry(workspace);
  return Object.values(reg).some((e) => e.docName === docName);
}

/** Normalize a URL for dedup comparison: strip trailing slash (unless root),
 *  fragment, and default ports (443 for https, 80 for http). */
export function normalizeUrl(url: string): string {
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

/** Check if a URL is already in the registry by originalPath.
 *  Normalizes URLs before comparison (trailing slash, fragment, default port). */
export function isUrlInRegistry(url: string, workspace?: string): boolean {
  const normalized = normalizeUrl(url);
  const reg = readRegistry(workspace);
  return Object.values(reg).some(
    (e) => normalizeUrl(e.originalPath) === normalized,
  );
}

/** Find a registry entry by URL (originalPath). Returns null if not found. */
export function findByUrl(
  url: string,
  workspace?: string,
): RegistryEntry | null {
  const normalized = normalizeUrl(url);
  const reg = readRegistry(workspace);
  return (
    Object.values(reg).find(
      (e) => normalizeUrl(e.originalPath) === normalized,
    ) ?? null
  );
}

/** Find a registry entry by content hash. */
export function findInRegistry(
  hash: string,
  workspace?: string,
): RegistryEntry | null {
  const reg = readRegistry(workspace);
  return reg[hash] ?? null;
}

// ---------------------------------------------------------------------------
// Source files
// ---------------------------------------------------------------------------

/** Copy a source file into the workspace source/ dir. Returns relative path.
 *  Throws if a file with the same name already exists in source/. */
export function copySource(
  absPath: string,
  workspace?: string,
): { destRel: string; destAbs: string } {
  const wp = getWorkspaceRoot(workspace);
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

/** Write raw markdown content directly into the workspace source/ dir
 *  (for URL-fetched docs). Throws if a file with the same name already exists. */
export function writeSourceContent(
  filename: string,
  content: string,
  workspace?: string,
): { destRel: string; destAbs: string } {
  const wp = getWorkspaceRoot(workspace);
  const destAbs = path.join(wp.sourceDir, filename);
  if (fs.existsSync(destAbs)) {
    throw new Error(
      `A file named "${filename}" already exists in the KB source/ directory.`,
    );
  }
  fs.writeFileSync(destAbs, content, "utf-8");
  return { destRel: `source/${filename}`, destAbs };
}

/** Read source file content (full text). destRel is relative to workspace root. */
export function readSource(destRel: string, workspace?: string): string {
  const wp = getWorkspaceRoot(workspace);
  return fs.readFileSync(path.join(wp.root, destRel), "utf-8");
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export function readIndex(workspace?: string): string {
  const wp = getWorkspaceRoot(workspace);
  if (!fs.existsSync(wp.indexPath)) return "";
  return fs.readFileSync(wp.indexPath, "utf-8");
}

export function writeIndex(content: string, workspace?: string): void {
  const wp = getWorkspaceRoot(workspace);
  fs.mkdirSync(wp.wikiDir, { recursive: true });
  fs.writeFileSync(wp.indexPath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export function listSummaries(workspace?: string): string[] {
  const wp = getWorkspaceRoot(workspace);
  if (!fs.existsSync(wp.summariesDir)) return [];
  return fs
    .readdirSync(wp.summariesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

export function readSummary(
  docName: string,
  workspace?: string,
): string | null {
  const wp = getWorkspaceRoot(workspace);
  const p = path.join(wp.summariesDir, `${docName}.md`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8");
}

export function writeSummary(
  docName: string,
  content: string,
  originalName: string,
  addedAt: string,
  workspace?: string,
): void {
  const wp = getWorkspaceRoot(workspace);
  fs.mkdirSync(wp.summariesDir, { recursive: true });
  const frontmatter = [
    "---",
    `source: "${originalName}"`,
    `doc_source: "source/${originalName}"`,
    `added: "${addedAt}"`,
    "---",
  ].join("\n");
  const full = frontmatter + "\n\n" + content;
  fs.writeFileSync(path.join(wp.summariesDir, `${docName}.md`), full, "utf-8");
}

/** Check whether a registry entry is fully compiled (all wiki artifacts present).
 *  Missing `compiled` field is treated as true for backward compatibility with
 *  registries created before the compiled flag was introduced. */
export function isEntryCompiled(entry: RegistryEntry): boolean {
  return entry.compiled !== false;
}

/** Count registry entries that are not yet fully compiled. */
export function countPendingCompilations(workspace?: string): number {
  const reg = readRegistry(workspace);
  return Object.values(reg).filter((e) => !isEntryCompiled(e)).length;
}

// ---------------------------------------------------------------------------
// Concepts
// ---------------------------------------------------------------------------

export function listConcepts(workspace?: string): string[] {
  const wp = getWorkspaceRoot(workspace);
  if (!fs.existsSync(wp.conceptsDir)) return [];
  return fs
    .readdirSync(wp.conceptsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

export function readConcept(
  slug: string,
  workspace?: string,
): ConceptInfo | null {
  const wp = getWorkspaceRoot(workspace);
  const p = path.join(wp.conceptsDir, `${slug}.md`);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf-8");

  // Parse frontmatter
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
          // Parse YAML-style list: ["a.md", "b.md"]
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

export function writeConcept(
  slug: string,
  content: string,
  sources: string[],
  workspace?: string,
): void {
  const wp = getWorkspaceRoot(workspace);
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

/** Delete a concept page. Returns true if it existed. */
export function deleteConcept(slug: string, workspace?: string): boolean {
  const wp = getWorkspaceRoot(workspace);
  const p = path.join(wp.conceptsDir, `${slug}.md`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/** Delete a summary page. Returns true if it existed. */
export function deleteSummary(docName: string, workspace?: string): boolean {
  const wp = getWorkspaceRoot(workspace);
  const p = path.join(wp.summariesDir, `${docName}.md`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

// ---------------------------------------------------------------------------
// Full wiki dump (for query context)
// ---------------------------------------------------------------------------

export interface WikiDump {
  index: string;
  summaries: Record<string, string>;
  concepts: Record<string, string>;
}

/** Read everything from the wiki. */
export function dumpWiki(workspace?: string): WikiDump {
  const summaries: Record<string, string> = {};
  for (const name of listSummaries(workspace)) {
    const s = readSummary(name, workspace);
    if (s) summaries[name] = s;
  }

  const concepts: Record<string, string> = {};
  for (const slug of listConcepts(workspace)) {
    const c = readConcept(slug, workspace);
    if (c) concepts[slug] = c.body;
  }

  return {
    index: readIndex(workspace),
    summaries,
    concepts,
  };
}
