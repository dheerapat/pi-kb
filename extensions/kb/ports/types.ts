/**
 * ports/types.ts — Domain types and interfaces for the KB extension.
 *
 * Every adapter (filesystem, HTTP) implements one of the ports defined here.
 * Command and tool handlers depend only on these interfaces, never on
 * concrete implementations — this is the ports & adapters boundary.
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  /** Original filename (e.g. "architecture.md") */
  name: string;
  /** Path to the copy in source/ (relative to workspace root) */
  sourcePath: string;
  /** Original absolute path or normalized URL where the file came from */
  originalPath: string;
  /** Slug used in summaries/ and concepts/ (filename without extension) */
  docName: string;
  /** ISO timestamp of first add */
  addedAt: string;
  /** ISO timestamp of last compilation */
  lastCompiledAt?: string;
  /** True when all wiki artifacts (summary, concepts, index) are written */
  compiled: boolean;
}

export type Registry = Record<string, RegistryEntry>;

export interface ConceptInfo {
  slug: string;
  sources: string[];
  updated?: string;
  body: string;
}

export interface WikiDump {
  index: string;
  summaries: Record<string, string>;
  concepts: Record<string, string>;
}

export interface WorkspacePaths {
  root: string;
  registryPath: string;
  sourceDir: string;
  wikiDir: string;
  summariesDir: string;
  conceptsDir: string;
  indexPath: string;
}

export interface CopyResult {
  destRel: string;
  destAbs: string;
}

export interface FetchedContent {
  content: string;
  title: string | null;
}

// ---------------------------------------------------------------------------
// Port: KnowledgeBaseStore
//
// All filesystem operations for the knowledge base. Implemented by
// adapters/filesystem-store.ts. Could be swapped for SQLite, S3, etc.
// ---------------------------------------------------------------------------

export interface KnowledgeBaseStore {
  // ── Paths ────────────────────────────────────────────
  getWorkspaceRoot(name?: string): WorkspacePaths;

  // ── Workspaces ───────────────────────────────────────
  listWorkspaces(): string[];
  workspaceExists(name: string): boolean;
  ensureKbDir(workspace?: string): boolean;
  kbExists(workspace?: string): boolean;
  deleteWorkspace(name?: string): string;

  // ── Hashing ──────────────────────────────────────────
  hashContent(content: string): string;
  hashFile(filePath: string): string;

  // ── Registry ─────────────────────────────────────────
  readRegistry(workspace?: string): Registry;
  writeRegistry(registry: Registry, workspace?: string): void;
  isDocNameUsed(docName: string, workspace?: string): boolean;
  normalizeUrl(url: string): string;
  isUrlInRegistry(url: string, workspace?: string): boolean;
  findByUrl(url: string, workspace?: string): RegistryEntry | null;

  // ── Source files ─────────────────────────────────────
  copySource(absPath: string, workspace?: string): CopyResult;
  writeSourceContent(
    filename: string,
    content: string,
    workspace?: string,
  ): CopyResult;
  readSource(destRel: string, workspace?: string): string;

  // ── Index ────────────────────────────────────────────
  readIndex(workspace?: string): string;
  writeIndex(content: string, workspace?: string): void;

  // ── Summaries ────────────────────────────────────────
  listSummaries(workspace?: string): string[];
  readSummary(docName: string, workspace?: string): string | null;
  writeSummary(
    docName: string,
    content: string,
    originalName: string,
    addedAt: string,
    workspace?: string,
  ): void;
  deleteSummary(docName: string, workspace?: string): boolean;

  // ── Concepts ─────────────────────────────────────────
  listConcepts(workspace?: string): string[];
  readConcept(slug: string, workspace?: string): ConceptInfo | null;
  writeConcept(
    slug: string,
    content: string,
    sources: string[],
    workspace?: string,
  ): void;
  deleteConcept(slug: string, workspace?: string): boolean;

  // ── Compilation tracking ─────────────────────────────
  isEntryCompiled(entry: RegistryEntry): boolean;
  countPendingCompilations(workspace?: string): number;

  // ── Wiki dump ────────────────────────────────────────
  dumpWiki(workspace?: string): WikiDump;
}

// ---------------------------------------------------------------------------
// Port: ContentFetcher
//
// Fetches URLs and converts HTML to Markdown. Implemented by
// adapters/http-fetcher.ts. Could be swapped for a browser-based fetcher
// for JS-heavy sites.
// ---------------------------------------------------------------------------

export interface ContentFetcher {
  fetchAndConvert(url: string): Promise<FetchedContent>;
}
