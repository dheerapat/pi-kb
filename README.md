# pi-kb — pi-native Knowledge Base

A pi extension that compiles markdown documents into a structured, interlinked wiki using your LLM. Inspired by [OpenKB](https://github.com/VectifyAI/OpenKB) but built entirely as a pi extension with no external dependencies beyond your LLM.

## Install

```bash
pi install git:github.com/dheeto/pi-kb
```

## Usage

```
/kb-add <file.md>        Add a markdown file to the knowledge base
/kb-add @file.md         Pi file autocomplete works (strips @ prefix)
/kb-query <question>     Ask a question against the knowledge base
/kb-list                 List all documents and concepts
/kb-status                Show knowledge base stats
/kb-remove <docName>     Remove a document and clean up wiki pages
```

## How it works

1. `/kb-add docs/peptic_ulcer.md` copies the file into `~/.pi/agent/kb/source/`
2. Pi's LLM reads the current wiki state, writes a summary, extracts cross-cutting concepts, and updates the index
3. Everything is stored as plain markdown in `~/.pi/agent/kb/wiki/` — open it in Obsidian for graph view

```
~/.pi/agent/kb/
├── registry.json         # Hash-based dedup tracking
├── source/               # Original file copies
└── wiki/
    ├── index.md           # KB overview with one-liner entries
    ├── summaries/          # Per-document summaries
    └── concepts/           # Cross-document topic synthesis
```

## Requirements

- pi coding agent
- A tool-capable LLM (Anthropic, OpenAI, Google, etc.)
- Node.js 20+

## License

MIT
