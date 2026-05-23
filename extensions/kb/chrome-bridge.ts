/**
 * chrome-bridge.ts — WebSocket bridge between Chrome extension and pi-kb.
 *
 * When /kb-chrome-bridge runs inside pi, it starts a WebSocket server on
 * ws://127.0.0.1:9876. The Chrome extension connects and sends:
 *
 *   { type: "add",   url: "...", workspace?: "..." }   → spawns child pi RPC
 *   { type: "query", text: "...", workspace?: "..." }   → spawns child pi RPC
 *   { type: "sync",  workspace?: "..." }                → reads filesystem
 *
 * Child pi processes are spawned via --mode rpc and communicate over
 * stdin/stdout JSONL. Events are forwarded to the WS client in real-time.
 * On agent_end the child's stdin is closed and "done" is sent to the client.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";

import {
  readRegistry,
  readIndex,
  listSummaries,
  readSummary,
  listConcepts,
  readConcept,
  listWorkspaces,
  getWorkspaceRoot,
  ConceptInfo,
} from "./store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory containing this file — passed to child pi as -e <dir>. */
const KB_EXT_DIR = __dirname;
const DEFAULT_PORT = 9876;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

/** Construct the RPC prompt line for /kb-add. */
function buildAddPrompt(url: string, workspace?: string): string {
  if (workspace && workspace !== "default") {
    return `/kb-add -w ${workspace} ${url}`;
  }
  return `/kb-add ${url}`;
}

/** Construct the RPC prompt line for /kb-query. */
function buildQueryPrompt(text: string, workspace?: string): string {
  if (workspace && workspace !== "default") {
    return `/kb-query -w ${workspace} ${text}`;
  }
  return `/kb-query ${text}`;
}

// ---------------------------------------------------------------------------
// Child pi RPC spawner
// ---------------------------------------------------------------------------

/**
 * Spawn a child `pi --mode rpc --no-session -e <kb-ext-dir>`, pipe a prompt
 * to its stdin, and forward stdout events to the WebSocket client.
 *
 * @returns  The child process (caller can kill it if needed).
 */
function spawnPiRpc(
  ws: WebSocket,
  promptText: string,
  command: "add" | "query",
  log: (msg: string) => void,
): ChildProcess {
  log(`[kb-bridge] Spawning child pi for ${command}: ${promptText}`);

  const child = spawn(
    "pi",
    ["--mode", "rpc", "--no-session", "-e", KB_EXT_DIR],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  child.on("error", (err: NodeJS.ErrnoException) => {
    const msg =
      err.code === "ENOENT"
        ? `pi binary not found in PATH. Is pi installed?`
        : `Failed to spawn pi: ${err.message}`;
    log(`[kb-bridge] ${msg}`);
    ws.send(safeStringify({ type: "error", message: msg }));
  });

  child.on("exit", (code, signal) => {
    log(
      `[kb-bridge] Child pi for ${command} exited (code=${code}, signal=${signal})`,
    );
  });

  // ── stdout — read JSONL lines, forward as events ──────────
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        ws.send(safeStringify({ type: "event", data: event }));

        // Watch for agent_end — the session is done
        if (event.type === "agent_end") {
          ws.send(safeStringify({ type: "done", command }));
          // Close stdin to signal child it can exit
          try {
            child.stdin!.end();
          } catch {
            // stdin may already be closed
          }
        }
      } catch {
        // Non-JSON line (debug output) — forward as stderr
        ws.send(safeStringify({ type: "stderr", text: trimmed }));
      }
    }
  });

  // ── stderr — forward for debugging ────────────────────────
  child.stderr!.on("data", (chunk: Buffer) => {
    ws.send(safeStringify({ type: "stderr", text: chunk.toString("utf-8") }));
  });

  // ── Send the prompt via stdin ──────────────────────────────
  const promptMsg = safeStringify({
    type: "prompt",
    message: promptText,
  });
  child.stdin!.write(promptMsg + "\n");

  return child;
}

// ---------------------------------------------------------------------------
// Sync — pure filesystem read (no LLM)
// ---------------------------------------------------------------------------

interface SyncData {
  registry: Record<string, unknown>;
  index: string;
  summaries: Record<string, { content: string; source: string; added: string }>;
  concepts: Record<
    string,
    { content: string; sources: string[]; updated: string }
  >;
  workspaces: string[];
}

function buildSyncData(workspace?: string): SyncData {
  const reg = readRegistry(workspace);

  const summaries: SyncData["summaries"] = {};
  for (const name of listSummaries(workspace)) {
    const full = readSummary(name, workspace);
    if (!full) continue;

    // Extract frontmatter metadata for the UI
    let source = "";
    let added = "";
    let content = full;
    if (full.startsWith("---")) {
      const end = full.indexOf("---", 3);
      if (end !== -1) {
        const fm = full.slice(3, end);
        content = full.slice(end + 3).trimStart();
        for (const line of fm.split("\n")) {
          const t = line.trim();
          if (t.startsWith("source:")) {
            source = t
              .slice("source:".length)
              .trim()
              .replace(/^["']|["']$/g, "");
          } else if (t.startsWith("added:")) {
            added = t
              .slice("added:".length)
              .trim()
              .replace(/^["']|["']$/g, "");
          }
        }
      }
    }
    summaries[name] = { content, source, added };
  }

  const concepts: SyncData["concepts"] = {};
  for (const slug of listConcepts(workspace)) {
    const c: ConceptInfo | null = readConcept(slug, workspace);
    if (!c) continue;
    concepts[slug] = {
      content: c.body,
      sources: c.sources,
      updated: c.updated || "",
    };
  }

  return {
    registry: reg as Record<string, unknown>,
    index: readIndex(workspace),
    summaries,
    concepts,
    workspaces: listWorkspaces(),
  };
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

let serverStarted = false;

export function startBridge(
  pi: ExtensionAPI,
  port: number = DEFAULT_PORT,
): void {
  if (serverStarted) {
    pi.log?.("[kb-bridge] Bridge already running.");
    return;
  }

  const log = (msg: string) => {
    pi.log?.(msg);
    console.log(msg);
  };

  const wss = new WebSocketServer({ host: "127.0.0.1", port });

  wss.on("listening", () => {
    serverStarted = true;
    log(`[kb-bridge] WebSocket server listening on ws://127.0.0.1:${port}`);
  });

  wss.on("error", (err: Error) => {
    log(`[kb-bridge] Server error: ${err.message}`);
    serverStarted = false;
  });

  wss.on("connection", (ws: WebSocket) => {
    log("[kb-bridge] Chrome extension connected");

    // Track the active child for this connection so we can clean up
    let activeChild: ChildProcess | null = null;

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(
          safeStringify({
            type: "error",
            message: "Invalid JSON message",
          }),
        );
        return;
      }

      const workspace =
        msg.workspace && msg.workspace !== "default"
          ? msg.workspace
          : undefined;

      switch (msg.type) {
        case "add": {
          if (!msg.url) {
            ws.send(
              safeStringify({
                type: "error",
                message: "Missing 'url' field for add",
              }),
            );
            return;
          }
          // Kill any previous child for this connection
          if (activeChild) {
            activeChild.kill();
            activeChild = null;
          }
          const prompt = buildAddPrompt(msg.url, workspace);
          activeChild = spawnPiRpc(ws, prompt, "add", log);
          break;
        }

        case "query": {
          if (!msg.text) {
            ws.send(
              safeStringify({
                type: "error",
                message: "Missing 'text' field for query",
              }),
            );
            return;
          }
          if (activeChild) {
            activeChild.kill();
            activeChild = null;
          }
          const prompt = buildQueryPrompt(msg.text, workspace);
          activeChild = spawnPiRpc(ws, prompt, "query", log);
          break;
        }

        case "sync": {
          try {
            const data = buildSyncData(workspace);
            ws.send(safeStringify({ type: "sync_result", data }));
          } catch (err: any) {
            ws.send(
              safeStringify({
                type: "error",
                message: `Sync failed: ${err.message}`,
              }),
            );
          }
          break;
        }

        default:
          ws.send(
            safeStringify({
              type: "error",
              message: `Unknown message type: ${msg.type}`,
            }),
          );
      }
    });

    ws.on("close", () => {
      log("[kb-bridge] Chrome extension disconnected");
      if (activeChild) {
        activeChild.kill();
        activeChild = null;
      }
    });

    ws.on("error", (err: Error) => {
      log(`[kb-bridge] WebSocket error: ${err.message}`);
    });
  });

  // Handle server-level shutdown
  const cleanup = () => {
    log("[kb-bridge] Shutting down WebSocket server");
    serverStarted = false;
    wss.clients.forEach((client) => {
      try {
        client.close();
      } catch {
        // ignore
      }
    });
    wss.close();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
