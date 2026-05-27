/**
 * utils.ts — Pure helper functions with no side effects.
 * Extracted from index.ts to keep commands focused on orchestration.
 */

import * as path from "node:path";

/** Convert text to a URL-safe slug: lowercase, hyphens, 80 chars max. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Derive a docName (slug) from a file path by stripping the extension. */
export function docNameFromFile(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

/**
 * Derive a docName from a URL.
 * Prefers the HTML metadata title if available, then falls back to
 * the last path segment, and finally the hostname.
 */
export function docNameFromUrl(
  url: string,
  metadataTitle?: string | null,
): string {
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
 * Parse -w / --workspace flag from raw command args.
 * Returns the workspace name (if any) and the remaining args string.
 */
export function parseWorkspaceArgs(rawArgs: string): {
  workspace?: string;
  force: boolean;
  rest: string;
} {
  let rest = rawArgs.trim();
  let workspace: string | undefined;
  let force = false;

  // Parse -w / --workspace
  const wsMatch = rest.match(/(?:^|\s)(?:-w|--workspace)\s+(\S+)/);
  if (wsMatch) {
    workspace = wsMatch[1];
    rest = rest.replace(wsMatch[0], " ").replace(/\s+/g, " ").trim();
  }

  // Parse -f / --force
  const forceMatch = rest.match(/(?:^|\s)(?:-f|--force)(?:\s|$)/);
  if (forceMatch) {
    force = true;
    rest = rest.replace(forceMatch[0], " ").replace(/\s+/g, " ").trim();
  }

  return { workspace, force, rest };
}

/** Resolve a user-supplied path against the current working directory. */
export function resolvePath(input: string, cwd: string): string {
  if (path.isAbsolute(input)) return input;
  return path.resolve(cwd, input);
}

/** Check whether a string looks like an HTTP(S) URL. */
export function isUrl(str: string): boolean {
  return /^https?:\/\//i.test(str);
}

/** Current time as ISO 8601 string. */
export function isoNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Deterministic index rebuild
// ---------------------------------------------------------------------------

/**
 * Build index.md content from ground-truth disk state.
 * Used by Phase 1 of /kb-remove and by standalone repair utilities.
 */
export function buildIndexContent(
  summaries: string[],
  concepts: Array<{ slug: string; sources: string[] }>,
): string {
  const docLines =
    summaries.length > 0
      ? summaries.map((s) => `- [[summary/${s}]]`)
      : ["(none)"];

  const conceptLines =
    concepts.length > 0
      ? concepts.map(
          (c) =>
            `- [[concept/${c.slug}]] — sources: ${c.sources.join(", ")}`,
        )
      : ["(none)"];

  return [
    "# Knowledge Base Index *(auto-rebuilt)*",
    "",
    "## Documents",
    ...docLines,
    "",
    "## Concepts",
    ...conceptLines,
    "",
  ].join("\n");
}
