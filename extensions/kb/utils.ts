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
