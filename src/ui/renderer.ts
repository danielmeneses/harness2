import type { Event, EventBus } from "../events.ts";
import type { ApprovalRequest, ApprovalResponse } from "../safety/approvals.ts";
import { describePredicate } from "../loop/spec.ts";
import { MarkdownRenderer, stripAnsi } from "./markdown.ts";
import type { Terminal } from "./terminal.ts";
import { fmtDuration, fmtTokens, oneLine, sanitizeTerminal } from "../util.ts";
import type { ControlPanel } from "./control.ts";
import { drawFooter } from "./footer.ts";

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

type ColorName = keyof typeof CODES;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const VERBOSE_TOOLS = new Set(["loop_inspect", "loop_set", "loop_stage", "loop_halt", "loop_note", "loop_ask", "loop_spawn", "todo"]);
const DELTA_TYPES = new Set(["assistant.thinking.delta", "assistant.text.delta", "tool.output.delta"]);
const HISTORY_SKIP = new Set([...DELTA_TYPES, "session.start", "session.resume", "session.clear", "provider"]);

function argSummary(name: string, args: Record<string, unknown>): string {
  const str = (k: string): string | undefined => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  const path = str("path");
  switch (name) {
    case "read":
      return path ? ` ${path}${typeof args.offset === "number" ? `:${args.offset}` : ""}` : "";
    case "write":
      return path ? ` ${path} (${String(args.content ?? "").length} chars)` : "";
    case "edit":
      return path ? ` ${path} (${Array.isArray(args.edits) ? args.edits.length : 0} edits)` : "";
    case "bash":
      return ` $ ${oneLine(str("command") ?? "", 100)}`;
    case "glob":
      return ` ${str("pattern") ?? ""}`;
    case "grep":
      return ` /${str("pattern") ?? ""}/`;
    case "ls":
      return ` ${path ?? "."}`;
    case "fetch":
      return ` ${str("url") ?? ""}`;
    case "todo":
      return ` ${str("action") ?? ""}`;
    case "loop_set":
      return ` ${oneLine(str("reason") ?? str("preset") ?? "loop change", 80)}`;
    case "loop_stage":
      return ` ${str("action") ?? "next"}${str("stage") ? ` → ${str("stage")}` : ""}`;
    case "loop_spawn":
      return ` ${str("name") ?? "sub"}: ${oneLine(str("task") ?? "", 70)}`;
    case "loop_ask":
      return ` ${oneLine(str("question") ?? "", 80)}`;
    case "loop_note":
      return ` ${oneLine(str("text") ?? "", 70)}`;
    default:
      return ` ${oneLine(JSON.stringify(args), 80)}`;
  }
}

class StreamWriter {
  partial = "";
  kind: "text" | "thinking" | null = null;
  #r: Renderer;
  stream: string;

  constructor(r: Renderer, stream: string) {
    this.#r = r;
    this.stream = stream;
  }

  append(kind: "text" | "thinking", text: string): void {
    if (!text) return;
    if (kind !== this.kind) {
      const previous = this.kind;
      this.commit();
      if (previous === "thinking") this.#r.endThinking(this.stream);
      this.kind = kind;
      this.#r.acquire(this);
      if (kind === "thinking") this.#r.writeThinkingHeader(this.stream);
      else if (previous === "thinking") this.#r.blankLine();
    } else {
      this.#r.acquire(this);
    }
    if (kind === "thinking" && !this.#r.showThinking) return;
    this.#feed(kind, text);
  }

  #feed(kind: "text" | "thinking", text: string): void {
    let rest = text;
    while (true) {
      const i = rest.indexOf("\n");
      if (i < 0) {
        if (rest) {
          this.#r.appendStreaming(this.stream, kind, rest);
          this.partial += rest;
        }
        break;
      }
      const piece = rest.slice(0, i);
      if (piece) {
        this.#r.appendStreaming(this.stream, kind, piece);
        this.partial += piece;
      }
      rest = rest.slice(i + 1);
      const line = this.partial;
      this.partial = "";
      this.#r.clearPreview(this.stream);
      if (kind === "thinking") this.#r.writeThinkingLine(this.stream, line);
      else this.#r.writeAssistantLine(this.stream, line);
    }
  }

  commit(): void {
    const line = this.partial;
    this.partial = "";
    this.#r.clearPreview(this.stream);
    if (!line) return;
    if (this.kind === "thinking") this.#r.writeThinkingLine(this.stream, line);
    else this.#r.writeAssistantLine(this.stream, line);
  }

  flush(): void {
    this.commit();
    this.#r.endThinking(this.stream);
    this.#r.finishAssistant(this.stream);
    this.kind = null;
    this.#r.release(this);
  }
}

export class Renderer {
  #term: Terminal;
  #color: boolean;
  showThinking: boolean;
  #writers = new Map<string, StreamWriter>();
  #markdown = new Map<string, MarkdownRenderer>();
  #think = new Map<string, { text: string; startedAt: number; live: boolean }>();
  #previews = new Map<string, { rows: number; prefixLen: number; length: number }>();
  #history: Event[] = [];
  #replaying = false;
  #replayPending = false;
  #header = "";
  #thinkingChars = 0;
  #active: StreamWriter | null = null;
  #streamNames = new Map<string, string>();
  #toolCards = new Map<string, { stream: string; name: string; args: Record<string, unknown>; started: number }>();
  #toolActive = new Map<string, string>();
  #sawDelta = new Set<string>();
  #statusVisible = false;
  #statusSuspended = false;
  #lastBlank = false;
  #needsBlankAfterTools = false;
  #running = false;
  #timer: NodeJS.Timeout | null = null;
  #frame = 0;
  #runStarted = 0;
  #step = 0;
  #stage = "";
  #stageIndex = 0;
  #stageTotal = 1;
  #mode = "";
  #tokens = 0;
  #tps = 0;
  #control: (() => ControlPanel) | null = null;

  constructor(term: Terminal, opts: { showThinking: boolean; color: boolean; header?: string }) {
    this.#term = term;
    this.showThinking = opts.showThinking;
    this.#color = opts.color;
    this.#header = opts.header ?? "";
  }

  attach(bus: EventBus): () => void {
    return bus.subscribe((ev) => this.handle(ev));
  }

  setControl(control: (() => ControlPanel) | null): void {
    this.#control = control;
  }

  #s(name: ColorName, text: string): string {
    return this.#color ? `${CODES[name]}${text}${CODES.reset}` : text;
  }

  #toolKey(stream: string, id: string): string {
    return `${stream}:${id}`;
  }

  #prefix(stream: string): string {
    if (stream === "main") return "";
    const name = sanitizeTerminal(this.#streamNames.get(stream) ?? stream.split(".").pop() ?? stream);
    return this.#s("dim", `│ ${name} `);
  }

  /** Write incoming model text immediately; the completed line is re-rendered. */
  appendStreaming(stream: string, kind: "text" | "thinking", text: string): void {
    const safe = sanitizeTerminal(text).replace(/\t/g, "  ");
    if (!safe) return;
    this.#clearStatus();
    let p = this.#previews.get(stream);
    if (!p) {
      const prefix = this.#prefix(stream);
      this.#term.write(prefix);
      p = { rows: 0, prefixLen: stripAnsi(prefix).length, length: 0 };
      this.#previews.set(stream, p);
    }
    const body = kind === "thinking" ? this.#s("dim", safe) : safe;
    this.#term.write(body);
    p.length += safe.length;
    p.rows = Math.max(1, Math.ceil((p.prefixLen + p.length) / Math.max(1, this.#term.width)));
  }

  clearPreview(stream: string): void {
    const p = this.#previews.get(stream);
    if (!p) return;
    this.#previews.delete(stream);
    this.#term.write("\r");
    for (let i = 0; i < p.rows; i++) {
      this.#term.write("\x1b[2K");
      if (i < p.rows - 1) this.#term.write("\x1b[1A");
    }
  }

  #clearAllPreviews(): void {
    for (const stream of [...this.#previews.keys()]) this.clearPreview(stream);
  }

  #line(text: string): void {
    this.#clearAllPreviews();
    this.#clearStatus();
    this.#term.write(`${text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")}\r\n`);
    this.#lastBlank = text.trim() === "";
    this.#refreshStatus();
  }

  /** Vertical whitespace that survives the transient status line. */
  #blank(): void {
    this.#clearAllPreviews();
    if (this.#lastBlank) {
      this.#needsBlankAfterTools = false;
      return;
    }
    this.#clearStatus();
    this.#term.write("\r\n");
    this.#lastBlank = true;
    this.#needsBlankAfterTools = false;
    this.#refreshStatus();
  }

  /** The assistant's prose is the thing the human reads; thinking stays dim. */
  #assistantStyle(line: string): string {
    if (!this.#color) return line;
    return `\x1b[1m\x1b[97m\x1b[48;5;236m${line}\x1b[0m`;
  }

  #beforeAssistantDelta(): void {
    if (this.#needsBlankAfterTools) this.#blank();
  }

  #clearStatus(): void {
    // The footer is persistent; renderer streaming must not erase it.
  }

  #refreshStatus(): void {
    if (this.#statusSuspended || !this.#running) return;
    const control = this.#control?.() ?? null;
    this.#term.saveCursor();
    drawFooter(this.#term, {
      inputLines: [this.#statusLine()],
      control,
      color: this.#color,
    });
    this.#term.restoreCursor();
  }

  #statusLine(): string {
    const elapsed = fmtDuration(Date.now() - this.#runStarted);
    const spinner = SPINNER[this.#frame % SPINNER.length];
    const stage =
      this.#stage && this.#stageTotal > 1
        ? `stage ${this.#stage} ${this.#stageIndex + 1}/${this.#stageTotal}`
        : this.#stage
          ? `stage ${this.#stage}`
          : "";
    return [
      spinner,
      `step ${this.#step}`,
      stage,
      this.#toolActive.size ? `● ${[...new Set(this.#toolActive.values())].slice(0, 2).join(", ")}` : "",
      this.#thinkingChars ? `thinking ${fmtTokens(this.#thinkingChars)}` : "",
      this.#tps ? `${Math.round(this.#tps)} tok/s` : "",
      elapsed,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  acquire(writer: StreamWriter): void {
    if (this.#active && this.#active !== writer && this.#active.partial) this.#active.flush();
    this.#active = writer;
  }

  release(writer: StreamWriter): void {
    if (this.#active === writer) this.#active = null;
  }

  writeThinkingHeader(stream: string): void {
    this.#line(`${this.#prefix(stream)}${this.#s("dim", "✻ thinking")}`);
  }

  #mdFor(stream: string): MarkdownRenderer {
    let md = this.#markdown.get(stream);
    if (!md) {
      md = new MarkdownRenderer({ color: this.#color });
      this.#markdown.set(stream, md);
    }
    return md;
  }

  writeThinkingLine(stream: string, raw: string): void {
    let line = sanitizeTerminal(raw);
    if (line.length > 4000) line = `${line.slice(0, 4000)}…`;
    this.#line(`${this.#prefix(stream)}${this.#s("dim", line)}`);
  }

  writeAssistantLine(stream: string, raw: string): void {
    const prefix = this.#prefix(stream);
    const width = Math.max(20, this.#term.width - stripAnsi(prefix).length);
    const text = sanitizeTerminal(raw);
    for (const line of this.#mdFor(stream).render(text, width)) {
      if (line === "") this.#blank();
      else this.#line(`${prefix}${line}`);
    }
  }

  finishAssistant(stream: string): void {
    const prefix = this.#prefix(stream);
    const width = Math.max(20, this.#term.width - stripAnsi(prefix).length);
    for (const line of this.#mdFor(stream).finish(width)) {
      if (line === "") this.#blank();
      else this.#line(`${prefix}${line}`);
    }
  }

  #thinkStart(stream: string): { text: string; startedAt: number; live: boolean } {
    let block = this.#think.get(stream);
    if (!block) {
      block = { text: "", startedAt: Date.now(), live: this.showThinking };
      this.#think.set(stream, block);
    }
    return block;
  }

  endThinking(stream: string): void {
    const block = this.#think.get(stream);
    if (!block) return;
    this.#think.delete(stream);
    if (block.text.trim()) {
      if (!block.live) {
        this.#blank();
        this.#line(
          this.#s(
            "dim",
            `${this.#prefix(stream)}✻ thinking · ${fmtTokens(block.text.length)} chars · ${fmtDuration(Date.now() - block.startedAt)} · ctrl-o to expand all`,
          ),
        );
        this.#blank();
      }
    }
    if (stream === "main") {
      this.#thinkingChars = 0;
      this.#refreshStatus();
    }
  }

  #endAllThinking(): void {
    for (const stream of [...this.#think.keys()]) this.endThinking(stream);
  }

  #writer(stream: string): StreamWriter {
    let writer = this.#writers.get(stream);
    if (!writer) {
      writer = new StreamWriter(this, stream);
      this.#writers.set(stream, writer);
    }
    return writer;
  }

  #flushActive(): void {
    if (this.#active?.partial) this.#active.flush();
  }

  flushAll(): void {
    this.#endAllThinking();
    this.#flushActive();
    for (const writer of this.#writers.values()) writer.flush();
  }

  startRun(mode: string): void {
    this.#mode = mode;
    this.#running = true;
    this.#runStarted = Date.now();
    this.#tokens = 0;
    this.#tps = 0;
    this.#step = 0;
    this.#stage = "";
    this.#stageIndex = 0;
    this.#stageTotal = 1;
    this.#frame = 0;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = setInterval(() => {
      this.#frame++;
      this.#refreshStatus();
    }, 250);
    this.#refreshStatus();
  }

  endRun(): void {
    this.flushAll();
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#clearStatus();
    if (this.#replayPending) {
      this.#replayPending = false;
      this.replayTranscript();
    }
    this.#blank();
    this.#toolCards.clear();
    this.#toolActive.clear();
  }

  blankLine(): void {
    this.#blank();
  }

  showNotice(text: string): void {
    this.#line(this.#s("dim", `· ${sanitizeTerminal(text)}`));
  }

  showError(text: string): void {
    this.#line(this.#s("red", `✖ ${sanitizeTerminal(text)}`));
  }

  toggleThinking(): void {
    this.showThinking = !this.showThinking;
    if (this.#running) {
      this.#replayPending = true;
      this.#line(this.#s("dim", `thinking: ${this.showThinking ? "expanded" : "collapsed"} after this turn`));
      this.#blank();
      return;
    }
    this.replayTranscript();
  }

  setHistory(events: Event[]): void {
    this.#history = events.filter((ev) => !HISTORY_SKIP.has(ev.t));
  }

  replayTranscript(): void {
    if (this.#running) {
      this.#replayPending = true;
      return;
    }
    if (!this.#history.length) {
      this.#line(this.#s("dim", "nothing to expand yet"));
      this.#blank();
      return;
    }
    const events = [...this.#history];
    this.#replaying = true;
    this.#writers.clear();
    this.#markdown.clear();
    this.#active = null;
    this.#streamNames.clear();
    this.#toolCards.clear();
    this.#toolActive.clear();
    this.#sawDelta.clear();
    this.#think.clear();
    this.#thinkingChars = 0;
    this.#statusVisible = false;
    this.#statusSuspended = false;
    this.#lastBlank = false;
    this.#needsBlankAfterTools = false;
    this.#tokens = 0;
    this.#tps = 0;
    this.#step = 0;
    this.#stage = "";
    this.#stageIndex = 0;
    this.#stageTotal = 1;
    this.#mode = "";
    this.#frame = 0;
    this.#runStarted = 0;

    this.#term.write("\x1b[3J\x1b[2J\x1b[H");
    if (this.#header) {
      this.#line(this.#s("dim", sanitizeTerminal(this.#header)));
      this.#blank();
    }
    for (const ev of events) this.handle(ev);
    this.flushAll();
    this.#replaying = false;
    this.#line(this.#s("dim", `thinking: ${this.showThinking ? "expanded" : "collapsed"} · ctrl-o toggles all`));
    this.#blank();
  }

  #renderThinkingBlock(stream: string, thinking: string, expanded: boolean): void {
    const text = sanitizeTerminal(thinking).replace(/\n+$/, "");
    if (!text.trim()) return;
    this.#blank();
    if (expanded) {
      this.#line(`${this.#prefix(stream)}${this.#s("dim", "✻ thinking")}`);
      for (const line of text.split("\n")) {
        this.#line(`${this.#prefix(stream)}${this.#s("dim", line)}`);
      }
    } else {
      this.#line(
        this.#s("dim", `${this.#prefix(stream)}✻ thinking · ${fmtTokens(text.length)} chars · ctrl-o to expand all`),
      );
    }
    this.#blank();
  }

  handle(ev: Event): void {
    if (this.#replaying) {
      if (DELTA_TYPES.has(ev.t)) return;
    } else if (!HISTORY_SKIP.has(ev.t)) {
      this.#history.push(ev);
    }
    const stream = ev.stream;
    switch (ev.t) {
      case "assistant.text.delta": {
        this.endThinking(stream);
        this.#beforeAssistantDelta();
        this.#sawDelta.add(stream);
        this.#writer(stream).append("text", ev.text);
        return;
      }
      case "assistant.thinking.delta": {
        const block = this.#thinkStart(stream);
        block.text += ev.text;
        if (stream === "main") this.#thinkingChars = block.text.length;
        if (!block.live) return;
        this.#beforeAssistantDelta();
        this.#sawDelta.add(stream);
        this.#writer(stream).append("thinking", ev.text);
        return;
      }
      case "assistant.message": {
        if (this.#replaying && ev.thinking && ev.thinking.trim()) {
          this.#renderThinkingBlock(stream, ev.thinking, this.showThinking);
        }
        this.endThinking(stream);
        const writer = this.#writer(stream);
        if (!this.#sawDelta.has(stream) && ev.text) writer.append("text", ev.text);
        writer.flush();
        this.#sawDelta.delete(stream);
        if (ev.text.trim()) this.#blank();
        return;
      }
      case "user.message": {
        if (ev.synthetic) return;
        this.flushAll();
        const prefix = stream === "main" ? "" : this.#prefix(stream);
        const lines = ev.text.split("\n");
        lines.forEach((line, i) => {
          const clean = sanitizeTerminal(line);
          if (i === 0 && stream === "main") this.#line(`${this.#s("bold", "> ")}${clean}`);
          else this.#line(`${prefix}${i === 0 ? this.#s("bold", "▸ ") : "  "}${clean}`);
        });
        this.#blank();
        return;
      }
      case "loop.nudge": {
        this.#blank();
        this.#line(this.#s("yellow", `${this.#prefix(stream)}↻ ${sanitizeTerminal(ev.text)}`));
        this.#blank();
        return;
      }
      case "tool.call": {
        this.endThinking(stream);
        this.#flushActive();
        this.#writer(stream).flush();
        const key = this.#toolKey(stream, ev.id);
        this.#toolCards.set(key, { stream, name: ev.name, args: ev.args, started: Date.now() });
        this.#toolActive.set(key, ev.name);
        this.#refreshStatus();
        return;
      }
      case "tool.output.delta": {
        // Tool output is printed as a styled card once the result is known.
        return;
      }
      case "tool.result": {
        const key = this.#toolKey(stream, ev.id);
        const card = this.#toolCards.get(key);
        this.#toolCards.delete(key);
        this.#toolActive.delete(key);
        this.#printToolCard(stream, ev, card);
        this.#refreshStatus();
        return;
      }
      case "loop.spec": {
        this.#blank();
        const stages = sanitizeTerminal(ev.spec.stages.map((s) => s.id).join(" → "));
        const reason = sanitizeTerminal(oneLine(ev.reason, 120));
        const finish = sanitizeTerminal(describePredicate(ev.spec.finish));
        this.#line(
          `${this.#prefix(stream)}${this.#s("cyan", "↻ loop updated")} ${this.#s("dim", `(by ${ev.by})`)}: ${reason}\n  ${this.#s(
            "dim",
            `stages: ${stages} · maxSteps ${ev.spec.maxSteps} · finish: ${finish}`,
          )}`,
        );
        this.#blank();
        return;
      }
      case "loop.stage": {
        if (stream === "main") {
          this.#stage = ev.id;
          this.#stageIndex = ev.index;
          this.#stageTotal = ev.total;
          this.#step = ev.step || this.#step;
        }
        if (ev.step > 0) {
          this.#blank();
          this.#line(`${this.#prefix(stream)}${this.#s("cyan", "▶ stage")} ${this.#s("bold", sanitizeTerminal(ev.id))} ${this.#s("dim", `(${ev.index + 1}/${ev.total})`)}`);
          this.#blank();
        }
        return;
      }
      case "loop.note": {
        this.#line(this.#s("dim", `${this.#prefix(stream)}✎ note: ${sanitizeTerminal(oneLine(ev.text, 200))}`));
        return;
      }
      case "loop.spawn": {
        this.#blank();
        const childName = sanitizeTerminal(ev.name);
        this.#streamNames.set(ev.child, childName);
        this.#line(this.#s("magenta", `⤷ ${childName}: ${sanitizeTerminal(oneLine(ev.task, 120))}`));
        return;
      }
      case "loop.spawn.result": {
        this.#blank();
        const name = sanitizeTerminal(this.#streamNames.get(ev.child) ?? ev.child);
        const color = ev.ok ? "magenta" : "red";
        this.#line(this.#s(color, `⤶ ${name} ${ev.ok ? "done" : "failed"}: ${sanitizeTerminal(oneLine(ev.output, 160))}`));
        return;
      }
      case "todo": {
        if (!ev.items.length) {
          this.#line(this.#s("dim", `${this.#prefix(stream)}☑ todo: empty`));
          return;
        }
        const done = ev.items.filter((t) => t.done).length;
        const next = ev.items.find((t) => !t.done);
        this.#line(this.#s("dim", `${this.#prefix(stream)}☑ todo ${done}/${ev.items.length}${next ? ` · next: ${sanitizeTerminal(oneLine(next.text, 80))}` : " · complete"}`));
        return;
      }
      case "compaction": {
        this.#blank();
        this.#line(
          this.#s(
            "dim",
            `${this.#prefix(stream)}▣ compacted ${ev.beforeMessages} → ${ev.afterMessages} messages (~${fmtTokens(ev.beforeTokens)} → ${fmtTokens(ev.afterTokens)} tokens)`,
          ),
        );
        this.#blank();
        return;
      }
      case "provider": {
        this.#mode = ev.mode;
        this.#line(this.#s("dim", sanitizeTerminal(`⇄ provider: ${ev.mode}${ev.detail ? ` (${ev.detail})` : ""}`)));
        return;
      }
      case "notice": {
        this.#line(this.#s(ev.level === "warn" ? "yellow" : "dim", `${this.#prefix(stream)}${ev.level === "warn" ? "!" : "·"} ${sanitizeTerminal(ev.message)}`));
        return;
      }
      case "error": {
        this.endThinking(stream);
        this.flushAll();
        this.#blank();
        this.#line(this.#s("red", `${this.#prefix(stream)}✖ ${sanitizeTerminal(ev.message)}`));
        this.#blank();
        return;
      }
      case "usage": {
        if (stream !== "main") return;
        if (ev.step === 1) {
          this.#tokens = 0;
          this.#tps = 0;
        }
        this.#step = ev.step;
        const total = ev.usage.totalTokens ?? (ev.usage.promptTokens ?? 0) + (ev.usage.completionTokens ?? 0);
        this.#tokens += total;
        this.#tps = ev.tokensPerSec ?? 0;
        this.#refreshStatus();
        return;
      }
      case "approval.request": {
        if (!this.#replaying) return;
        this.#blank();
        this.#line(this.#s("dim", `${this.#prefix(stream)}⚠ ${sanitizeTerminal(ev.title)}`));
        for (const line of (ev.detail ?? "").split("\n").slice(0, 3)) {
          if (line) this.#line(this.#s("dim", `  ${sanitizeTerminal(line)}`));
        }
        return;
      }
      case "approval.result": {
        if (!this.#replaying) return;
        this.#line(
          this.#s(
            "dim",
            `${this.#prefix(stream)}→ ${ev.decision}${ev.reason ? `: ${sanitizeTerminal(ev.reason)}` : ""}`,
          ),
        );
        return;
      }
      case "done": {
        if (stream === "main") this.#endAllThinking();
        else this.endThinking(stream);
        if (stream !== "main") {
          this.#writer(stream).flush();
          const name = this.#streamNames.get(stream) ?? stream.split(".").pop() ?? stream;
          const color = ev.reason === "completed" || ev.reason === "halted" ? "green" : ev.reason === "max_steps" ? "yellow" : "red";
          this.#line(this.#s(color, `${this.#prefix(stream)}─ ${name} ${ev.reason}`));
          return;
        }
        this.flushAll();
        this.#running = false;
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        this.#clearStatus();
        this.#blank();
        const color = ev.reason === "completed" || ev.reason === "halted" ? "green" : ev.reason === "max_steps" ? "yellow" : "red";
        const elapsed = this.#runStarted ? fmtDuration(Date.now() - this.#runStarted) : "";
        const stats = [this.#tokens ? `${fmtTokens(this.#tokens)} tok` : "", elapsed ? elapsed : ""].filter(Boolean).join(" · ");
        this.#line(this.#s(color, `─ done · ${ev.reason}${stats ? ` · ${stats}` : ""}`));
        this.#lastBlank = false;
        this.#toolCards.clear();
        this.#toolActive.clear();
        return;
      }
      default:
        return;
    }
  }

  #printToolCard(
    stream: string,
    ev: Extract<Event, { t: "tool.result" }>,
    card: { args: Record<string, unknown> } | undefined,
  ): void {
    const meta = ev.meta ?? {};
    const details: string[] = [];
    if (typeof meta.exitCode === "number") details.push(`exit ${meta.exitCode}`);
    if (typeof meta.durationMs === "number") details.push(fmtDuration(meta.durationMs));
    if (typeof meta.replacements === "number") details.push(`${meta.replacements} replacements`);
    if (meta.created === true) details.push("new file");
    const header = `● ${sanitizeTerminal(ev.name)}${sanitizeTerminal(argSummary(ev.name, card?.args ?? {}))}`;
    const showOutput =
      !ev.ok ||
      ev.name === "bash" ||
      ev.name === "write" ||
      ev.name === "edit" ||
      VERBOSE_TOOLS.has(ev.name);
    const outputLines: string[] = [];
    if (showOutput && ev.output.trim()) {
      const max = ev.name === "bash" ? 40 : 20;
      const lines = sanitizeTerminal(ev.output).split("\n");
      for (const line of lines.slice(0, max)) outputLines.push(`  ${line.replace(/\t/g, "  ")}`);
      if (lines.length > max) outputLines.push(`  … ${lines.length - max} more lines`);
    }
    const diffLines: string[] = [];
    if (typeof meta.diff === "string" && meta.diff && (ev.name === "write" || ev.name === "edit")) {
      const lines = sanitizeTerminal(meta.diff).split("\n");
      for (const line of lines.slice(0, 40)) diffLines.push(`  ${line.replace(/\t/g, "  ")}`);
      if (lines.length > 40) diffLines.push("  … diff truncated");
    }
    const status = `${ev.ok ? "✓" : "✗"} ${sanitizeTerminal(ev.name)}${details.length ? ` (${details.join(", ")})` : ""}`;

    this.#blank();
    this.#cardLine(stream, header, true, ev.ok);
    for (const line of outputLines) this.#cardLine(stream, line, false, ev.ok);
    for (const line of diffLines) this.#cardLine(stream, line, false, ev.ok);
    this.#cardLine(stream, status, false, ev.ok);
    this.#blank();
    this.#needsBlankAfterTools = true;
  }

  #cardLine(stream: string, text: string, bold: boolean, ok: boolean): void {
    const name = sanitizeTerminal(this.#streamNames.get(stream) ?? stream.split(".").pop() ?? stream);
    const prefix = stream === "main" ? "" : `│ ${name} `;
    if (!this.#color) {
      this.#line(`${prefix}${text}`);
      return;
    }
    const width = Math.max(20, this.#term.width);
    const pad = " ".repeat(Math.max(0, width - (prefix.length + text.length)));
    // Truecolor near-black yellow; ANSI has no alpha. Fall back to dark olive.
    const bg = /truecolor|24bit/i.test(process.env.COLORTERM ?? "")
      ? "\x1b[48;2;30;27;8m"
      : "\x1b[48;5;58m";
    const fg = ok ? "\x1b[92m" : "\x1b[91m";
    const boldCode = bold ? "\x1b[1m" : "";
    this.#line(`${bg}${fg}${boldCode}${prefix}${text}${pad}\x1b[0m`);
  }

  async askApproval(req: ApprovalRequest): Promise<ApprovalResponse> {
    this.#statusSuspended = true;
    this.flushAll();
    this.#clearStatus();
    try {
      if (req.kind === "ask") {
        this.#line(`${this.#s("bold", "?")} ${sanitizeTerminal(req.title)}`);
        if (req.detail) for (const line of req.detail.split("\n")) this.#line(this.#s("dim", `  ${sanitizeTerminal(line)}`));
        const answer = await this.#term.readLine(`${this.#s("cyan", "answer> ")}`);
        if (answer === null) return { decision: "deny", reason: "cancelled" };
        return { decision: "once", reason: answer };
      }

      this.#line(this.#s("yellow", `⚠ ${sanitizeTerminal(req.title)}`));
      const detail = req.detail ?? "";
      const detailLines = detail.split("\n");
      const maxLines = req.kind === "loop" ? 60 : 40;
      for (let i = 0; i < Math.min(detailLines.length, maxLines); i++) {
        this.#line(this.#s("dim", `  ${sanitizeTerminal(detailLines[i])}`));
      }
      if (detailLines.length > maxLines) {
        this.#line(this.#s("dim", `  … ${detailLines.length - maxLines} more lines`));
      }

      const choice = await this.#term.readChoice(
        ["y", "s", "a", "n"],
        `${this.#s("dim", "[y] once  [s] session  [a] always  [n] deny")} › `,
      );
      if (choice === null || choice === "n") {
        let reason = "denied by the user";
        if (choice === "n") {
          const extra = await this.#term.readLine(`${this.#s("dim", "reason (enter to skip)> ")}`);
          if (extra) reason = extra;
        }
        this.#line(`${this.#s("red", "→ denied")}${this.#s("dim", `: ${sanitizeTerminal(reason)}`)}`);
        return { decision: "deny", reason };
      }
      if (choice === "y") {
        this.#line(this.#s("green", "→ allowed (once)"));
        return { decision: "once" };
      }
      if (choice === "s") {
        this.#line(this.#s("green", "→ allowed for this session"));
        return { decision: "session" };
      }
      this.#line(this.#s("green", "→ allowed (saved for future runs)"));
      return { decision: "always" };
    } finally {
      this.#statusSuspended = false;
      if (this.#running) this.#refreshStatus();
    }
  }
}
