/**
 * tools.test.ts — Core write operations tested directly against the store.
 *
 * Tests the deterministic behavior that the tools delegate to:
 *   - writeSummary (frontmatter + footer)
 *   - writeConcept (creation with sources)
 *   - updateConcept (source merging — the key new behavior)
 *
 * Run: node --import tsx --test extensions/kb/tools.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FilesystemStore, syncSummaryFooters } from "./adapters/filesystem-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRaw(
  store: FilesystemStore,
  dir: "summaries" | "concepts",
  name: string,
  workspace = "test-ws",
): string {
  const wp = store.getWorkspaceRoot(workspace);
  return fs.readFileSync(
    path.join(wp.wikiDir, dir, `${name}.md`),
    "utf-8",
  );
}

function parseSources(content: string): string[] {
  const m = content.match(/sources:\s*\[([^\]]*)\]/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function wsDir(): string {
  return path.join(os.homedir(), ".pi/agent/kb/workspaces/test-ws");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function setup() {
  const store = new FilesystemStore();
  store.ensureKbDir("test-ws");
  return store;
}

function teardown() {
  fs.rmSync(wsDir(), { recursive: true, force: true });
}

describe("writeSummary", () => {
  let store: FilesystemStore;

  beforeEach(() => { store = setup(); });
  afterEach(() => teardown());

  it("writes frontmatter and extracts concept links into footer", () => {
    store.writeSummary(
      "test-doc",
      "## Overview\nThis describes caching.\n\nSee [[concept/caching-strategy]] and [[concept/latency]].\n",
      "test-doc.md",
      "2024-01-01T00:00:00.000Z",
      "test-ws",
    );

    const raw = readRaw(store, "summaries", "test-doc");

    assert.ok(raw.startsWith("---"), "should have frontmatter");
    assert.ok(raw.includes('name: "test-doc"'));
    assert.ok(raw.includes('source: "test-doc.md"'));
    assert.ok(raw.includes('date_added: "2024-01-01T00:00:00.000Z"'));

    // Deterministic footer from body concept links
    assert.ok(raw.includes("**Concepts**"));
    assert.ok(raw.includes("[[concept/caching-strategy]]"));
    assert.ok(raw.includes("[[concept/latency]]"));
  });

  it("writes empty footer when no concept links in body", () => {
    store.writeSummary(
      "plain-doc",
      "Just text, no wiki links.",
      "plain.md",
      "2024-01-01T00:00:00.000Z",
      "test-ws",
    );

    const raw = readRaw(store, "summaries", "plain-doc");
    assert.ok(raw.includes("No concepts reference this document yet"));
  });
});

describe("writeConcept", () => {
  let store: FilesystemStore;

  beforeEach(() => { store = setup(); });
  afterEach(() => teardown());

  it("creates concept with frontmatter and sources footer", () => {
    store.writeConcept(
      "caching-strategy",
      "## Overview\nUse Redis for hot paths.",
      ["summary/test-doc"],
      "test-ws",
    );

    const raw = readRaw(store, "concepts", "caching-strategy");

    assert.ok(raw.startsWith("---"), "should have frontmatter");
    assert.ok(raw.includes('name: "caching-strategy"'));
    assert.ok(raw.includes('needs_review: false'));

    const sources = parseSources(raw);
    assert.deepEqual(sources, ["summary/test-doc"]);

    // Deterministic footer
    assert.ok(raw.includes("**Sources**"));
    assert.ok(raw.includes("[[summary/test-doc]]"));
  });

  it("stores multiple initial sources", () => {
    store.writeConcept(
      "error-handling",
      "## Patterns\nAlways use structured errors.",
      ["summary/api-design", "summary/backend-bible"],
      "test-ws",
    );

    const raw = readRaw(store, "concepts", "error-handling");
    const sources = parseSources(raw);
    assert.deepEqual(
      sources.sort(),
      ["summary/api-design", "summary/backend-bible"].sort(),
    );
  });

  it("writes needs_review: true when flag is set", () => {
    store.writeConcept(
      "under-review",
      "## Body",
      ["summary/a"],
      "test-ws",
      true, // needsReview
    );

    const raw = readRaw(store, "concepts", "under-review");
    assert.ok(raw.includes("needs_review: true"));
  });
});

describe("updateConcept (deterministic source merge)", () => {
  let store: FilesystemStore;

  beforeEach(() => { store = setup(); });
  afterEach(() => teardown());

  // Simulates what kb_update_concept does:
  function updateConcept(
    slug: string,
    body: string,
    newSource: string,
    workspace = "test-ws",
  ) {
    const existing = store.readConcept(slug, workspace);
    if (!existing) throw new Error(`Concept "${slug}" does not exist`);
    const merged = [...new Set([...existing.sources, newSource])];
    store.writeConcept(slug, body, merged, workspace);
    return merged;
  }

  it("merges new source with existing ones", () => {
    // Seed: concept with 2 sources
    store.writeConcept(
      "caching",
      "## Old body\nUse Redis.",
      ["summary/doc-a", "summary/doc-b"],
      "test-ws",
    );

    // Update: add a 3rd source
    const merged = updateConcept(
      "caching",
      "## New body\nRedis + Memcached.",
      "summary/doc-c",
    );

    assert.deepEqual(
      merged.sort(),
      ["summary/doc-a", "summary/doc-b", "summary/doc-c"].sort(),
    );

    const raw = readRaw(store, "concepts", "caching");
    assert.ok(raw.includes("## New body"));
    assert.ok(raw.includes("[[summary/doc-a]]"));
    assert.ok(raw.includes("[[summary/doc-b]]"));
    assert.ok(raw.includes("[[summary/doc-c]]"));
  });

  it("deduplicates identical source", () => {
    store.writeConcept(
      "dedup",
      "## Original",
      ["summary/x"],
      "test-ws",
    );

    const merged = updateConcept("dedup", "## Updated", "summary/x");
    assert.deepEqual(merged, ["summary/x"]);
  });

  it("throws when concept does not exist", () => {
    assert.throws(
      () => updateConcept("nonexistent", "## Body", "summary/x"),
      /does not exist/,
    );
  });

  it("preserves old sources regardless of what caller passes", () => {
    // Seed: 3 sources
    store.writeConcept(
      "multi",
      "## Multi-source",
      ["summary/a", "summary/b", "summary/c"],
      "test-ws",
    );

    // Simulate LLM only knowing about the new one —
    // the merge is computed from disk, so old sources survive.
    const merged = updateConcept("multi", "## Updated", "summary/d");

    assert.deepEqual(
      merged.sort(),
      ["summary/a", "summary/b", "summary/c", "summary/d"].sort(),
    );
  });
});

describe("syncSummaryFooters (post-compile deterministic sync)", () => {
  let store: FilesystemStore;

  beforeEach(() => { store = setup(); });
  afterEach(() => teardown());

  it("regenerates summary footers from concept sources", () => {
    // Write summary (initial footer from body links)
    store.writeSummary(
      "doc-a",
      "Doc A content.",
      "doc-a.md",
      "2024-01-01T00:00:00.000Z",
      "test-ws",
    );
    store.writeSummary(
      "doc-b",
      "Doc B content.",
      "doc-b.md",
      "2024-01-01T00:00:00.000Z",
      "test-ws",
    );

    // Write concept referencing doc-a
    store.writeConcept(
      "topic-x",
      "## Topic X\nSpans multiple docs.",
      ["summary/doc-a", "summary/doc-b"],
      "test-ws",
    );

    // Sync footers (simulates what kb_update_index does)
    syncSummaryFooters(store, "test-ws");

    // doc-a footer should now reflect concept sources
    const raw = readRaw(store, "summaries", "doc-a");
    assert.ok(raw.includes("[[concept/topic-x]]"));

    // doc-b footer as well
    const rawB = readRaw(store, "summaries", "doc-b");
    assert.ok(rawB.includes("[[concept/topic-x]]"));
  });
});
