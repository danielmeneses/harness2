import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function hashString(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.max(0, Math.floor(max * 0.7));
  const tail = Math.max(0, max - head);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${omitted} chars truncated] …\n${text.slice(text.length - tail)}`;
}

export function oneLine(text: string, max = 140): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Remove terminal control sequences so model/tool output cannot mess up the UI. */
export function sanitizeTerminal(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\r/g, "");
}

export function randomId(prefix = ""): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.message === "aborted");
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtTokens(n: number | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
