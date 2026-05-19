# pi-kb — pi-native Knowledge Base

A pi extension that compiles markdown documents into a structured, interlinked wiki using your LLM. Inspired by [OpenKB](https://github.com/VectifyAI/OpenKB) (which also inspired by Andrej Karparthy) but built entirely as a pi extension with no external dependencies beyond your LLM.

## Install

```bash
pi install git:github.com/dheerapat/pi-kb
```

## Usage

```
/kb-add <file.md | url>   Add a markdown file or URL to the knowledge base
/kb-add @file.md          Pi file autocomplete works
/kb-query <question>      Ask a question against the knowledge base
/kb-list                  List all documents and concepts
/kb-status                Show knowledge base stats
/kb-remove <docName>      Remove a document and clean up wiki pages
```

## How it works

1. `/kb-add docs/peptic_ulcer.md` copies the file into `~/.pi/agent/kb/source/`
2. `/kb-add https://example.com/article` fetches the page, converts HTML to Markdown using [html-to-markdown](https://github.com/kreuzberg-dev/html-to-markdown) (Rust-powered), and saves the result
3. Pi's LLM reads the current wiki state, writes a summary, extracts cross-cutting concepts, and updates the index
4. Everything is stored as plain markdown in `~/.pi/agent/kb/wiki/` — open it in Obsidian for graph view

```
~/.pi/agent/kb/
├── registry.json         # Hash-based dedup tracking
├── source/               # Original file copies
└── wiki/
    ├── index.md          # KB overview with one-liner entries
    ├── summaries/        # Per-document summaries
    └── concepts/         # Cross-document topic synthesis
```

## Query from anywhere
The knowledge base lives in `~/.pi/agent/kb/` — a fixed location in your home directory, not inside any project or repository. Once you've compiled documents, you can run `/kb-query` from any directory on your machine. There's no need to be inside the repo where the source files originally came from.

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
- A tool-capable LLM (Anthropic, OpenAI, Google, etc.)
- Node.js 20+

## License

MIT
