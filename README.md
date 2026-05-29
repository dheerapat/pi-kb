# pi-kb — pi-native Knowledge Base

A pi extension that compiles markdown documents into a structured, interlinked wiki using your LLM. Inspired by [OpenKB](https://github.com/VectifyAI/OpenKB) (which also inspired by Andrej Karparthy) but built entirely as a pi extension with no external dependencies beyond your LLM.

## Install

```bash
pi install git:github.com/dheerapat/pi-kb
```

## Usage

```
/kb-init <name>           Create a named workspace
/kb-add [-f] @file | url  Add a markdown file (via @) or URL; -f skips pending-confirmation
/kb-add-content <text>    Add inline markdown text (LLM chooses the title)
/kb-query <question>      Ask a question against the knowledge base
/kb-list                  List all documents and concepts
/kb-status                Show knowledge base stats
/kb-remove <docName>      Remove a document and clean up wiki pages
/kb-repair [docName]      Re-compile interrupted /kb-add documents
/kb-ws-rm <name>          Delete a workspace (confirmation required)
/kb-workspaces            List all workspaces and their stats
```

All commands accept `-w <name>` to target a specific workspace:

```
/kb-add -w myproject docs/design.md
/kb-query -w myproject "what is the caching strategy?"
/kb-list -w myproject
/kb-status -w myproject
/kb-remove -w myproject design
```

If no workspace is specified, commands operate on the **default** workspace at `~/.pi/agent/kb/`.

### Interrupted compilations & recovery

When you run `/kb-add`, the source file is copied and registered immediately,
but the wiki compilation (summary, concepts, index) runs asynchronously through
the LLM. If the session is interrupted mid-compilation, the registry will list
the document but the wiki will be incomplete.

**At most one document can be pending at a time.** If you try to `/kb-add` a new
document while another is still pending, pi shows a confirmation dialog: discard
the pending document and add the new one, or keep the pending one (use
`/kb-repair` to finish it). Pass `-f` to skip the dialog and force-discard:
`/kb-add -f new-file.md`. Re-adding _the same_ file or URL while it's pending
triggers a re-compile — the dedup logic runs before the guard, so retrying the
same document always works.

**Detection:** `/kb-status` shows a `⚠ Pending compilation` line. `/kb-list` marks
them with `⚠[pending]`.

**Recovery:** Run `/kb-repair` to re-compile all pending documents:

```
/kb-repair                  # Re-compile all pending docs
/kb-repair design           # Re-compile just one
/kb-repair -w myproject     # Repair a specific workspace
```

Re-adding the same file also triggers automatic recovery.

**Removal recovery:** If a `/kb-remove` session is interrupted, Phase 1 completes
synchronously so the KB is always internally consistent. If Phase 2 (LLM cleanup)
is interrupted, affected concepts keep a `needs_review: true` flag that can be
cleared by re-running the removal or manually updating the concept.

### Workspaces

Create isolated knowledge bases for different projects:

```bash
/kb-init myproject               # Create workspace
/kb-add -w myproject design.md   # Populate it
/kb-query -w myproject "what's the auth flow?"
```

Workspaces are stored as subdirectories under `~/.pi/agent/kb/workspaces/`.

To delete a workspace and all its data:

```bash
/kb-ws-rm myproject       # Deletes everything in workspace "myproject"
/kb-ws-rm default         # Clears the default workspace (keeps named workspaces)
```

A confirmation dialog is shown before anything is removed. Deleting the default
workspace (`/kb-ws-rm default`) clears its sources, summaries, concepts, and
index but preserves any named workspaces under `workspaces/`.

## How it works

### Adding a document (`/kb-add`)

1. The source file is copied into `source/` and registered in `registry.json` with `compiled: false`
2. The LLM receives a compile prompt with the document content
3. **Summary:** The LLM writes a 200–400 word summary via `kb_write_summary`. A **deterministic footer** is appended — concept links are extracted from the body and listed as `[[concept/...]]` references
4. **Concepts:** The LLM creates new topics via `kb_write_concept` or extends existing ones via `kb_update_concept`:
   - `kb_write_concept` — creates a new concept with an explicit sources list
   - `kb_update_concept` — updates an existing concept with new information. The new source is **automatically merged** with existing sources on the server. Old sources are preserved deterministically — the LLM never touches them
5. **Index:** The LLM calls `kb_update_index` which **filters entries against disk** before writing — any slug the LLM invented that doesn't correspond to a real file is silently dropped
6. After the index is written, a **footer sync pass** regenerates every summary's `**Concepts**` footer from the actual concept source lists on disk — guaranteeing footers are always in sync
7. The registry entry is marked `compiled: true` at the final step (the atomic commit point)

### Adding inline content (`/kb-add-content`)

Paste text directly into the knowledge base without a file or URL:

```
/kb-add-content # My Notes on Rust

Rust is a systems programming language that...
```

1. The text is hashed and saved as `source/inline-{hash}.md` with a temporary `internal-*` docName
2. The LLM receives a compile prompt that instructs it to **first choose a meaningful docName** via `kb_set_docname(oldDocName, newDocName)`
3. After renaming, the LLM follows the same compile pipeline as `/kb-add` (summary → concepts → index)
4. If the LLM forgets to rename, `kb_write_summary` rejects temporary `inline-*` names and prompts it to try again

Same deduplication, pending-compilation guard, and `-f` override apply.

### Removing a document (`/kb-remove`)

Removal uses a **two-phase staged pipeline**. Phase 1 is entirely deterministic (no LLM); Phase 2 is an optional LLM cleanup.

**Phase 1 — deterministic structural cleanup:**

1. Delete the summary file
2. For each concept that references the removed document:
   - If the document was the **only source** → delete the concept entirely
   - If other sources remain → update the sources list, set `needs_review: true` in frontmatter, **keep the body intact** (no data loss)
3. Rebuild `index.md` from disk (scanning summaries/ and concepts/ directories)
4. Delete the source file from `source/`
5. Delete the registry entry **last** — at this point all wiki files are already consistent

**Phase 2 — LLM surgical cleanup (non-critical):**

- Only runs if concepts were affected
- The LLM reads each concept flagged `needs_review: true`, surgically removes content traceable to the deleted document, and writes back with `needs_review: false`
- If the session is interrupted during Phase 2, the KB remains valid — concepts just have `needs_review: true` flags that can be resolved later with a re-run

### File format

**Summary** (`wiki/summaries/{docName}.md`):

```markdown
---
name: "architecture"
source: "architecture.md"
date_added: "2026-05-26T..."
---

<summary prose>

---

**Concepts**
[[concept/caching-strategy]]
```

**Concept** (`wiki/concepts/{slug}.md`):

```markdown
---
name: "caching-strategy"
sources: [summary/architecture, summary/design]
date_added: "2026-05-26T..."
needs_review: false
---

<concept prose>

---

**Sources**
[[summary/architecture]]
[[summary/design]]
```

- **Frontmatter** — machine-readable metadata (`name`, `sources`, `date_added`, `needs_review`)
- **Body** — LLM-written prose
- **Footer** — **deterministic** (code-generated, not LLM): concepts list their sources, summaries list referencing concepts (synced post-compile from ground truth). All `[[...]]` wiki links are generated by footers — the LLM writes plain markdown bodies

### Recovery & repair

**Compilation interrupted:** If a `/kb-add` session is interrupted mid-compilation, the registry keeps `compiled: false`. `/kb-status` shows a `⚠ Pending compilation` line. Run `/kb-repair` to resume.

**Removal interrupted:** If a `/kb-remove` session is interrupted after Phase 1 (which completes synchronously), the KB is already consistent. If interrupted during Phase 2, concepts retain `needs_review: true` flags. Re-running `/kb-remove` for the same document or manually calling `kb_write_concept` on the affected concepts clears the flag.

### Failure modes — before vs after

| Failure                                       | Before (LLM-driven)                 | After (deterministic)                                              |
| --------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| LLM invents slug in index                     | Phantom entry                       | Filtered before write                                              |
| Session interrupted mid-remove                | Orphaned wiki files, no repair path | Phase 1 already committed; body preserved with `needs_review` flag |
| Concept body corrupted by remove              | Undetectable                        | Sources list correct, body kept, flag for review                   |
| Registry deleted before cleanup               | Inconsistent state                  | Registry deleted last, after all file ops                          |
| LLM forgets old sources when updating concept | Sources lost                        | Union from disk — old sources always preserved                     |

```
~/.pi/agent/kb/
├── registry.json         # Hash-based dedup tracking
├── source/               # Original file copies
├── wiki/
│   ├── index.md          # KB overview with one-liner entries
│   ├── summaries/        # Per-document summaries
│   └── concepts/         # Cross-document topic synthesis
└── workspaces/           # Named, isolated workspaces
    └── myproject/
        ├── registry.json
        ├── source/
        └── wiki/
            ├── index.md
            ├── summaries/
            └── concepts/
```

## Web Page Compatibility

`/kb-add` fetches pages using a plain HTTP request and converts the raw HTML to Markdown. This works well for static or server-rendered pages but will produce thin or empty results for JavaScript-heavy sites, since no browser or JS engine is involved.

**Works well:**

- Documentation sites (plain HTML, SSG output)
- Wikipedia, blog posts, news articles
- GitHub READMEs and rendered markdown pages
- Most technical references and man pages

**Likely to fail or produce poor output:**

- Single-page applications (React, Vue, Angular)
- Pages that require login or session cookies
- Sites behind Cloudflare or bot-detection challenges
- Content loaded via infinite scroll or lazy fetch

If a page produces an empty or garbled result, try finding a static mirror, an archived version at web.archive.org, or export the content manually as a `.md` file and use `/kb-add <file.md>` instead.

## Query from anywhere

The knowledge base lives in `~/.pi/agent/kb/` — a fixed location in your home directory, not inside any project or repository. Once you've compiled documents, you can run `/kb-query` (with an optional `-w` workspace flag) from any directory on your machine. There's no need to be inside the repo where the source files originally came from.

Cross-reference documents across workspaces by switching between them:

```
/kb-query "how does this repo handle errors?"
/kb-query -w backend "how does this repo handle errors?"
```

## Version controlling your KB

The `~/.pi/agent/kb/` folder is plain files — `registry.json` and markdown — so it's easy to track with Git if you want history, backups, or to sync across machines.

```bash
cd ~/.pi/agent/kb
git init
echo "source/" >> .gitignore   # optionally skip raw source copies
git add .
git commit -m "initial kb snapshot"
```

From there, commit whenever you add documents, push to a private remote to back up or share the compiled wiki, and pull on another machine to restore it. Since `/kb-add` deduplicates via `registry.json`, the state will be consistent as long as the registry and wiki are in sync.

## Requirements

- pi coding agent
