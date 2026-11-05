import type { ToolImpl } from "./types.ts";
import { capOutput, denied, failure } from "./types.ts";
import { optInt, reqString } from "./args.ts";

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "");
  const text = decodeEntities(
    body
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
  return { title: decodeEntities(title), text };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      out += decoder.decode(value, { stream: true });
      truncated = true;
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  return { text: out, truncated };
}

const fetchTool: ToolImpl = {
  spec: {
    name: "fetch",
    description:
      "Fetch a URL over HTTP(S) and return readable text. Network access may require approval. HTML is reduced to text. No JavaScript execution.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "http:// or https:// URL." },
        maxChars: { type: "integer", description: "Maximum characters to return (default 20000, max 100000)." },
      },
      required: ["url"],
    },
  },
  async execute(args, ctx) {
    const raw = reqString(args, "url");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return failure(`invalid URL: ${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return failure("only http:// and https:// URLs are supported");
    }
    const maxChars = Math.min(100_000, Math.max(1000, optInt(args, "maxChars", 20_000)));

    if (ctx.cfg.safety.network === "deny") return denied("network access is disabled by config");
    if (ctx.cfg.safety.network === "ask") {
      const res = await ctx.approvals.request({
        kind: "network",
        title: "network fetch needs approval",
        detail: url.toString(),
        key: `network:${url.origin}`,
        stream: ctx.conv.id,
      });
      if (res.decision === "deny") return denied(res.reason || "denied by the user");
    }

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]);
    const approvedOrigins = new Set<string>([url.origin]);
    const request = async (target: URL): Promise<Response> =>
      fetch(target, {
        headers: { "User-Agent": "harness2/0.1", Accept: "text/html,application/json,text/plain,*/*" },
        signal,
        redirect: "manual",
      });

    let currentUrl = url;
    let res: Response;
    try {
      // Redirects are followed manually so a cross-origin redirect cannot
      // bypass an approval issued for the first origin.
      for (let hop = 0; ; hop++) {
        if (hop >= 5) return failure(`too many redirects (last: ${currentUrl.toString()})`);
        res = await request(currentUrl);
        if (res.status < 300 || res.status >= 400) break;
        const location = res.headers.get("location");
        if (!location) break;
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          return failure(`invalid redirect target: ${location}`);
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return failure(`redirect to unsupported protocol: ${next.protocol}`);
        }
        if (!approvedOrigins.has(next.origin)) {
          if (ctx.cfg.safety.network === "ask") {
            const decision = await ctx.approvals.request({
            kind: "network",
            title: "cross-origin redirect needs approval",
            detail: `${currentUrl.toString()}\n→ ${next.toString()}`,
              key: `network:${next.origin}`,
              stream: ctx.conv.id,
            });
            if (decision.decision === "deny") return denied(decision.reason || "denied by the user");
          }
          approvedOrigins.add(next.origin);
        }
        currentUrl = next;
      }
    } catch (e) {
      return failure(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const { text: body, truncated } = await readCapped(res, maxChars * 4);
    let text = body;
    let title = "";
    if (contentType.includes("html") || /^\s*<!doctype html/i.test(body)) {
      const parsed = htmlToText(body);
      text = parsed.text;
      title = parsed.title;
    }
    const header = [
      `URL: ${res.url}`,
      `Status: ${res.status} ${res.statusText}`.trim(),
      `Type: ${contentType || "unknown"}`,
      title ? `Title: ${title}` : "",
      "",
    ]
      .filter((l) => l !== "")
      .join("\n");
    return {
      ok: res.ok,
      output: capOutput(`${header}\n${text || "(empty body)"}`, Math.min(maxChars, ctx.cfg.safety.toolOutputChars)),
      meta: { status: res.status, contentType, truncated },
    };
  },
};

export const fetchTools: ToolImpl[] = [fetchTool];
