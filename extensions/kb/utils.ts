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
  rest: string;
} {
  let rest = rawArgs.trim();

  const match = rest.match(/(?:^|\s)(?:-w|--workspace)\s+(\S+)/);
  if (match) {
    const workspace = match[1];
    rest = rest.replace(match[0], " ").replace(/\s+/g, " ").trim();
    return { workspace, rest };
  }

  return { rest };
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
// Wiki link resolver
// ---------------------------------------------------------------------------

interface WikiLink {
  fullMatch: string;
  prefix: string | null;
  slug: string;
  anchor: string | null;
  displayText: string | null;
  start: number;
  end: number;
}

interface CodeRange {
  start: number;
  end: number;
}

/** Find all [[...]] wiki links in content, skipping code fences. */
function parseWikiLinks(content: string): WikiLink[] {
  const fenceRanges = findCodeFenceRanges(content);
  const links: WikiLink[] = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    if (isInRanges(match.index, fenceRanges)) continue;

    const inner = match[1];
    let target = inner;
    let displayText: string | null = null;

    const pipeIdx = target.indexOf("|");
    if (pipeIdx !== -1) {
      displayText = target.slice(pipeIdx + 1);
      target = target.slice(0, pipeIdx);
    }

    let anchor: string | null = null;
    const hashIdx = target.indexOf("#");
    if (hashIdx !== -1) {
      anchor = target.slice(hashIdx + 1);
      target = target.slice(0, hashIdx);
    }

    let prefix: string | null = null;
    let slug = target;
    const slashIdx = target.indexOf("/");
    if (slashIdx !== -1) {
      prefix = target.slice(0, slashIdx);
      slug = target.slice(slashIdx + 1);
    }

    links.push({
      fullMatch: match[0],
      prefix,
      slug,
      anchor,
      displayText,
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return links;
}

function findCodeFenceRanges(content: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  const lines = content.split("\n");
  let inFence = false;
  let fenceStart = 0;
  let pos = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (inFence) {
        ranges.push({ start: fenceStart, end: pos + line.length });
        inFence = false;
      } else {
        fenceStart = pos;
        inFence = true;
      }
    }
    pos += line.length + 1;
  }

  if (inFence) {
    ranges.push({ start: fenceStart, end: content.length });
  }

  return ranges;
}

function isInRanges(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some((r) => pos >= r.start && pos < r.end);
}

/**
 * Resolve all [[...]] wiki links in content against live slug registries.
 *
 * - Prefixed links (summary/slug, concept/slug) are validated; invalid ones
 *   are stripped to plain text.
 * - Unprefixed links are auto-resolved (concepts checked first, then summaries).
 * - `pendingSlugs` is a set of concept slugs that will be written in the
 *   current session but don't exist on disk yet (Gap 1 fix).
 * - When `preserveUnknownConcepts` is true, [[concept/...]] links to unknown
 *   slugs are kept as-is instead of being stripped. Used for summaries where
 *   the LLM references concepts that haven't been written yet.
 *
 * Returns the cleaned content.
 */
export function resolveLinks(
  content: string,
  summaries: Set<string>,
  concepts: Set<string>,
  pendingSlugs: Set<string>,
  opts?: { preserveUnknownConcepts?: boolean },
): string {
  const preserveUnknown = opts?.preserveUnknownConcepts === true;
  const links = parseWikiLinks(content);
  // Process in reverse so replacements don't shift indices
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    let resolved: string;

    if (link.prefix === "summary") {
      if (summaries.has(link.slug)) {
        resolved = link.fullMatch; // valid, keep as-is
      } else {
        resolved = stripBrackets(link);
      }
    } else if (link.prefix === "concept") {
      if (concepts.has(link.slug) || pendingSlugs.has(link.slug)) {
        resolved = link.fullMatch; // valid (including pending), keep as-is
      } else if (preserveUnknown) {
        resolved = link.fullMatch; // aspirational link — keep for summaries
      } else {
        resolved = stripBrackets(link);
      }
    } else {
      // No prefix — try to resolve: concepts first, then summaries
      if (concepts.has(link.slug) || pendingSlugs.has(link.slug)) {
        resolved = rebuildLink("concept", link);
      } else if (summaries.has(link.slug)) {
        resolved = rebuildLink("summary", link);
      } else if (preserveUnknown) {
        resolved = link.fullMatch; // aspirational, keep unprefixed
      } else {
        resolved = stripBrackets(link);
      }
    }

    content =
      content.slice(0, link.start) + resolved + content.slice(link.end);
  }

  return content;
}

function stripBrackets(link: WikiLink): string {
  // Emit plain text: prefix/slug or just slug, preserving display text
  const base = link.prefix ? `${link.prefix}/${link.slug}` : link.slug;
  return link.displayText ? `${base}|${link.displayText}` : base;
}

function rebuildLink(prefix: string, link: WikiLink): string {
  const anchor = link.anchor ? `#${link.anchor}` : "";
  const display = link.displayText ? `|${link.displayText}` : "";
  return `[[${prefix}/${link.slug}${anchor}${display}]]`;
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
