/**
 * store.ts — File I/O layer for the pi-native KB extension.
 *
 * All paths are relative to KB_ROOT (~/.pi/agent/kb/).
 * Handles directory creation, registry, source copying, wiki read/write.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const KB_ROOT = path.join(homedir(), ".pi", "agent", "kb");
export const REGISTRY_PATH = path.join(KB_ROOT, "registry.json");
export const SOURCE_DIR = path.join(KB_ROOT, "source");
export const WIKI_DIR = path.join(KB_ROOT, "wiki");
export const SUMMARIES_DIR = path.join(WIKI_DIR, "summaries");
export const CONCEPTS_DIR = path.join(WIKI_DIR, "concepts");
export const INDEX_PATH = path.join(WIKI_DIR, "index.md");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryEntry {
    /** Original filename (e.g. "architecture.md") */
    name: string;
    /** Path to the copy in source/ (relative to KB_ROOT) */
    sourcePath: string;
    /** Original absolute path where the file came from */
    originalPath: string;
    /** Slug used in summaries/ and concepts/ (filename without extension) */
    docName: string;
    /** ISO timestamp of first add */
    addedAt: string;
    /** ISO timestamp of last compilation */
    lastCompiledAt?: string;
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

/** Create the full KB directory tree if it doesn't exist. Returns true if
 *  this was a first-time creation (the KB root was missing). */
export function ensureKbDir(): boolean {
    const isNew = !fs.existsSync(KB_ROOT);
    fs.mkdirSync(KB_ROOT, { recursive: true });
    fs.mkdirSync(SOURCE_DIR, { recursive: true });
    fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
    fs.mkdirSync(CONCEPTS_DIR, { recursive: true });
    if (!fs.existsSync(REGISTRY_PATH)) {
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify({}, null, 2), "utf-8");
    }
    if (!fs.existsSync(INDEX_PATH)) {
        writeIndex("# Knowledge Base Index\n\n## Documents\n\n## Concepts\n");
    }
    return isNew;
}

/** True if the KB has been initialized (the root dir exists). */
export function kbExists(): boolean {
    return fs.existsSync(KB_ROOT);
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

export function readRegistry(): Registry {
    if (!fs.existsSync(REGISTRY_PATH)) return {};
    const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
    try {
        return JSON.parse(raw) as Registry;
    } catch {
        return {};
    }
}

export function writeRegistry(registry: Registry): void {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf-8");
}

/** Check if hash is already in registry. */
export function isInRegistry(hash: string): boolean {
    const reg = readRegistry();
    return hash in reg;
}

/** Check if a docName (slug) is already used in registry. */
export function isDocNameUsed(docName: string): boolean {
    const reg = readRegistry();
    return Object.values(reg).some((e) => e.docName === docName);
}

/** Check if a file has been indexed (by content hash). */
export function findInRegistry(hash: string): RegistryEntry | null {
    const reg = readRegistry();
    return reg[hash] ?? null;
}

// ---------------------------------------------------------------------------
// Source files
// ---------------------------------------------------------------------------

/** Copy a source file into source/. Returns the relative path in the kb.
 *  Throws if a file with the same name already exists in source/. */
export function copySource(absPath: string): {
    destRel: string;
    destAbs: string;
} {
    const name = path.basename(absPath);
    const destAbs = path.join(SOURCE_DIR, name);
    if (fs.existsSync(destAbs)) {
        throw new Error(
            `A file named "${name}" already exists in the KB source/ directory.\n` +
                `Rename your file on disk before adding it.`,
        );
    }
    fs.copyFileSync(absPath, destAbs);
    return { destRel: `source/${name}`, destAbs };
}

/** Write raw markdown content directly into source/ (for URL-fetched docs).
 *  Throws if a file with the same name already exists. */
export function writeSourceContent(
    filename: string,
    content: string,
): { destRel: string; destAbs: string } {
    const destAbs = path.join(SOURCE_DIR, filename);
    if (fs.existsSync(destAbs)) {
        throw new Error(
            `A file named "${filename}" already exists in the KB source/ directory.`,
        );
    }
    fs.writeFileSync(destAbs, content, "utf-8");
    return { destRel: `source/${filename}`, destAbs };
}

/** Read source file content (full text). */
export function readSource(destRel: string): string {
    return fs.readFileSync(path.join(KB_ROOT, destRel), "utf-8");
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export function readIndex(): string {
    if (!fs.existsSync(INDEX_PATH)) return "";
    return fs.readFileSync(INDEX_PATH, "utf-8");
}

export function writeIndex(content: string): void {
    fs.mkdirSync(WIKI_DIR, { recursive: true });
    fs.writeFileSync(INDEX_PATH, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export function listSummaries(): string[] {
    if (!fs.existsSync(SUMMARIES_DIR)) return [];
    return fs
        .readdirSync(SUMMARIES_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""));
}

export function readSummary(docName: string): string | null {
    const p = path.join(SUMMARIES_DIR, `${docName}.md`);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf-8");
}

export function writeSummary(
    docName: string,
    content: string,
    originalName: string,
    addedAt: string,
): void {
    fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
    const frontmatter = [
        "---",
        `source: "${originalName}"`,
        `doc_source: "source/${originalName}"`,
        `added: "${addedAt}"`,
        "---",
    ].join("\n");
    const full = frontmatter + "\n\n" + content;
    fs.writeFileSync(path.join(SUMMARIES_DIR, `${docName}.md`), full, "utf-8");
}

// ---------------------------------------------------------------------------
// Concepts
// ---------------------------------------------------------------------------

export function listConcepts(): string[] {
    if (!fs.existsSync(CONCEPTS_DIR)) return [];
    return fs
        .readdirSync(CONCEPTS_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""));
}

export function readConcept(slug: string): ConceptInfo | null {
    const p = path.join(CONCEPTS_DIR, `${slug}.md`);
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
): void {
    fs.mkdirSync(CONCEPTS_DIR, { recursive: true });
    const now = new Date().toISOString();
    const sourcesYaml = "[" + sources.map((s) => `"${s}"`).join(", ") + "]";
    const frontmatter = [
        "---",
        `sources: ${sourcesYaml}`,
        `updated: "${now}"`,
        "---",
    ].join("\n");
    const full = frontmatter + "\n\n" + content;
    fs.writeFileSync(path.join(CONCEPTS_DIR, `${slug}.md`), full, "utf-8");
}

/** Delete a concept page. Returns true if it existed. */
export function deleteConcept(slug: string): boolean {
    const p = path.join(CONCEPTS_DIR, `${slug}.md`);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
}

/** Delete a summary page. Returns true if it existed. */
export function deleteSummary(docName: string): boolean {
    const p = path.join(SUMMARIES_DIR, `${docName}.md`);
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
export function dumpWiki(): WikiDump {
    const summaries: Record<string, string> = {};
    for (const name of listSummaries()) {
        const s = readSummary(name);
        if (s) summaries[name] = s;
    }

    const concepts: Record<string, string> = {};
    for (const slug of listConcepts()) {
        const c = readConcept(slug);
        if (c) concepts[slug] = c.body;
    }

    return {
        index: readIndex(),
        summaries,
        concepts,
    };
}
