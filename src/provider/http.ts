import { isAbortError, sleep } from "../util.ts";

export class HTTPError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.replace(/\s+/g, " ").slice(0, 500)}`);
    this.name = "HTTPError";
    this.status = status;
    this.body = body;
  }
}

export type PostOptions = {
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs: number;
  retries: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
};

function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

function retryDelay(attempt: number, res?: Response): number {
  const fromHeader = res ? retryAfter(res.headers.get("retry-after")) : null;
  if (fromHeader !== null) return Math.min(fromHeader, 30_000);
  return Math.min(30_000, 500 * 2 ** attempt + Math.floor(Math.random() * 250));
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function postSSE(url: string, opts: PostOptions): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const signal = combineSignals(opts.signal, opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: opts.headers,
        body: JSON.stringify(opts.body),
        signal,
      });
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      const err = new HTTPError(res.status, body);
      if (!retryable(res.status) || attempt === opts.retries) throw err;
      const delay = retryDelay(attempt, res);
      opts.onRetry?.(attempt + 1, delay, err.message);
      await sleep(delay, opts.signal);
    } catch (e) {
      if (isAbortError(e) || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))) throw e;
      if (e instanceof HTTPError) throw e;
      lastError = e;
      if (attempt === opts.retries) throw e;
      const delay = retryDelay(attempt);
      opts.onRetry?.(attempt + 1, delay, e instanceof Error ? e.message : String(e));
      await sleep(delay, opts.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sseData(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
}

/** Yields the `data:` payload of each SSE event. */
export async function* readSSE(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error("response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      while (true) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = sseData(block);
        if (data) yield data;
      }
    }
    if (buf.trim()) {
      const data = sseData(buf);
      if (data) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}
