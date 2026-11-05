import type { ToolCall } from "../types.ts";
import { randomId } from "../util.ts";

const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";

export type SplitItem =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; call: ToolCall };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseToolCall(body: string, final: boolean): ToolCall {
  const raw = body.trim();
  try {
    if (final && !raw) throw new Error("unterminated tool_call block");
    const v = JSON.parse(raw);
    if (!isRecord(v)) throw new Error("tool call must be a JSON object");
    const name = typeof v.name === "string" ? v.name : typeof v.tool === "string" ? v.tool : "";
    let args: unknown = v.arguments ?? v.args ?? v.parameters ?? {};
    if (typeof args === "string") args = JSON.parse(args);
    if (!name) throw new Error("missing tool name");
    if (!isRecord(args)) throw new Error("arguments must be a JSON object");
    return { id: randomId("call_"), name, args };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      id: randomId("call_"),
      name: "invalid_tool_call",
      args: { raw: raw.slice(0, 2000) },
      argError: message,
    };
  }
}

/**
 * Splits decoded model text into assistant text, thinking, and tool calls.
 * Tags may be split across arbitrary chunk boundaries.
 */
export class TagSplitter {
  #buf = "";
  #tags: Array<[string, string]>;
  #thinkingEnd: string | null = null;
  #maxTag: number;

  constructor(tags: Array<[string, string]>) {
    this.#tags = tags;
    this.#maxTag = Math.max(TOOL_OPEN.length, ...tags.map(([a, b]) => Math.max(a.length, b.length)));
  }

  feed(chunk: string): SplitItem[] {
    this.#buf += chunk;
    return this.#scan(false);
  }

  flush(): SplitItem[] {
    return this.#scan(true);
  }

  #scan(final: boolean): SplitItem[] {
    const out: SplitItem[] = [];

    while (true) {
      if (this.#thinkingEnd) {
        const end = this.#buf.indexOf(this.#thinkingEnd);
        if (end < 0) {
          const keep = final ? 0 : Math.min(this.#buf.length, Math.max(0, this.#thinkingEnd.length - 1));
          const emit = this.#buf.slice(0, this.#buf.length - keep);
          if (emit) out.push({ kind: "thinking", text: emit });
          this.#buf = this.#buf.slice(this.#buf.length - keep);
          if (final) {
            this.#thinkingEnd = null;
            this.#buf = "";
          }
          break;
        }
        if (end > 0) out.push({ kind: "thinking", text: this.#buf.slice(0, end) });
        this.#buf = this.#buf.slice(end + this.#thinkingEnd.length);
        this.#thinkingEnd = null;
        continue;
      }

      const hits: Array<{ pos: number; start: string; end: string; tool?: boolean }> = [];
      for (const [start, end] of this.#tags) {
        const pos = this.#buf.indexOf(start);
        if (pos >= 0) hits.push({ pos, start, end });
      }
      const toolPos = this.#buf.indexOf(TOOL_OPEN);
      if (toolPos >= 0) hits.push({ pos: toolPos, start: TOOL_OPEN, end: TOOL_CLOSE, tool: true });
      hits.sort((a, b) => a.pos - b.pos);

      if (hits.length === 0) {
        if (final) {
          if (this.#buf) out.push({ kind: "text", text: this.#buf });
          this.#buf = "";
        } else {
          const keep = Math.min(this.#buf.length, Math.max(0, this.#maxTag - 1));
          const emit = this.#buf.slice(0, this.#buf.length - keep);
          if (emit) out.push({ kind: "text", text: emit });
          this.#buf = this.#buf.slice(this.#buf.length - keep);
        }
        break;
      }

      const hit = hits[0];
      if (hit.pos > 0) out.push({ kind: "text", text: this.#buf.slice(0, hit.pos) });
      this.#buf = this.#buf.slice(hit.pos);

      if (hit.tool) {
        const end = this.#buf.indexOf(TOOL_CLOSE);
        if (end < 0) {
          if (final) out.push({ kind: "tool", call: parseToolCall(this.#buf.slice(TOOL_OPEN.length), true) });
          // keep the block buffered for the next chunk
          break;
        }
        const body = this.#buf.slice(TOOL_OPEN.length, end);
        this.#buf = this.#buf.slice(end + TOOL_CLOSE.length);
        out.push({ kind: "tool", call: parseToolCall(body, false) });
        continue;
      }

      this.#buf = this.#buf.slice(hit.start.length);
      this.#thinkingEnd = hit.end;
    }

    return out;
  }
}
