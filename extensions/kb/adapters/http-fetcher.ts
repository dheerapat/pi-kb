/**
 * adapters/http-fetcher.ts — Fetches URLs and converts HTML → Markdown.
 *
 * Implements the ContentFetcher port using node:https/http (no undici/fetch
 * dependency to avoid version conflicts) and @kreuzberg/html-to-markdown-node.
 */

import { convert } from "@kreuzberg/html-to-markdown-node";
import * as https from "node:https";
import * as http from "node:http";
import type { ContentFetcher, FetchedContent } from "../ports/types";

export class HttpFetcher implements ContentFetcher {
  /**
   * Fetch a URL and convert HTML → Markdown.
   */
  async fetchAndConvert(url: string): Promise<FetchedContent> {
    const html = await httpGet(url);

    if (html.trim().length === 0) {
      throw new Error("Fetched content is empty");
    }

    const result = convert(html);
    if (!result.content || result.content.trim().length === 0) {
      throw new Error("HTML to markdown conversion produced empty output");
    }

    return {
      content: result.content,
      title: result.metadata?.document?.title ?? null,
    };
  }
}

/** Simple HTTP GET with redirect-following, IPv4-only, and timeout. */
function httpGet(targetUrl: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = 30_000;

    const doGet = (urlStr: string, redirectsLeft: number) => {
      const parsed = new URL(urlStr);
      const mod = parsed.protocol === "https:" ? https : http;

      const req = mod.get(
        urlStr,
        {
          headers: {
            "User-Agent": "pi-kb/0.1.0",
            Accept: "text/html, text/plain",
          },
          family: 4, // force IPv4 — avoids IPv6 timeouts
          timeout,
        },
        (res) => {
          // Redirect
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (redirectsLeft <= 0) {
              reject(new Error("Too many redirects"));
              return;
            }
            res.resume();
            doGet(
              new URL(res.headers.location, urlStr).toString(),
              redirectsLeft - 1,
            );
            return;
          }

          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${res.statusMessage || "error"}`,
              ),
            );
            res.resume();
            return;
          }

          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");
            resolve(body);
          });
          res.on("error", reject);
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("Request timed out"));
      });
    };

    doGet(targetUrl, maxRedirects);
  });
}
