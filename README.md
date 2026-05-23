# pi-kb — pi-native Knowledge Base

A pi extension that compiles markdown documents into a structured, interlinked wiki using your LLM. Inspired by [OpenKB](https://github.com/VectifyAI/OpenKB) (which also inspired by Andrej Karparthy) but built entirely as a pi extension with no external dependencies beyond your LLM.

## Install

```bash
pi install git:github.com/dheerapat/pi-kb
```

## Usage

```
/kb-init <name>           Create a named workspace
/kb-add <file.md | url>   Add a markdown file or URL to the knowledge base
/kb-add @file.md          Pi file autocomplete works
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

**Detection:** `/kb-status` shows a `⚠ Pending compilation` line when there are
documents stuck in this state. `/kb-list` marks them with `⚠[pending]`.

**Recovery:** Run `/kb-repair` to re-compile all pending documents. Pass a
`docName` to repair a specific one:

```
/kb-repair                  # Re-compile all pending docs
/kb-repair design           # Re-compile just one
/kb-repair -w myproject     # Repair a specific workspace
```

Re-adding the same file also triggers automatic recovery — `/kb-add` detects
the interrupted state and resumes compilation instead of rejecting the duplicate.

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

1. `/kb-add docs/peptic_ulcer.md` copies the file into `~/.pi/agent/kb/source/` and writes an entry to `registry.json` with `compiled: false`
2. `/kb-add -w myproject docs/design.md` copies the file into `~/.pi/agent/kb/workspaces/myproject/source/`
3. `/kb-add https://example.com/article` fetches the page, converts HTML to Markdown using [html-to-markdown](https://github.com/kreuzberg-dev/html-to-markdown) (Rust-powered), and saves the result
4. Pi's LLM reads the current wiki state, writes a summary, extracts cross-cutting concepts, and updates the index
5. The final step (`kb_update_index`) sets `compiled: true` on the registry entry — this is the atomic commit point that marks the document as fully compiled
6. Everything is stored as plain markdown in `~/.pi/agent/kb/wiki/` — open it in Obsidian for graph view

If step 4 is interrupted, the registry keeps `compiled: false`. `/kb-status`
shows the gap, `/kb-repair` resumes compilation, and re-adding the same file
auto-recovers.

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
