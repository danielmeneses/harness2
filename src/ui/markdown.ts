const RESET = "\x1b[0m";
const STYLES = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  strike: "\x1b[9m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
} as const;

type StyleName = keyof typeof STYLES;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

type Align = "left" | "center" | "right";

/**
 * Line-oriented markdown renderer for the inline terminal.
 * - Code fences and tables keep state across lines.
 * - Tables buffer until the block ends so columns can be aligned.
 * - Markdown is rendered to ANSI; when color is off the text is plain.
 */
export class MarkdownRenderer {
  #color: boolean;
  #inFence = false;
  #fenceChar = "`";
  #lang = "";
  #table: string[] | null = null;
  #prevBlank = true;

  constructor(opts: { color: boolean }) {
    this.#color = opts.color;
  }

  render(raw: string, width: number): string[] {
    const line = raw;
    if (this.#inFence) {
      const close = new RegExp(`^\\s*${this.#fenceChar}{3,}\\s*$`);
      if (close.test(line)) {
        this.#inFence = false;
        const out: string[] = [];
        this.#emit(out, this.#s("dim", "└─"));
        this.#space(out);
        return out;
      }
      return [this.#s("dim", "│ ") + line.replace(/\t/g, "  ")];
    }

    if (this.#table) {
      if (this.#isTableRow(line)) {
        this.#table.push(line);
        return [];
      }
      const out: string[] = [];
      this.#flushTable(out, width);
      if (!line.trim()) {
        this.#blank(out);
        return out;
      }
      this.#space(out);
      out.push(...this.#renderLine(line, width));
      return out;
    }

    if (this.#startsTable(line)) {
      this.#table = [line];
      return [];
    }

    return this.#renderLine(line, width);
  }

  finish(width: number): string[] {
    const out: string[] = [];
    if (this.#inFence) {
      this.#inFence = false;
      this.#emit(out, this.#s("dim", "└─"));
      this.#space(out);
    }
    if (this.#table) this.#flushTable(out, width);
    this.#table = null;
    this.#prevBlank = true;
    return out;
  }

  #renderLine(raw: string, width: number): string[] {
    const line = raw.replace(/\t/g, "  ");
    const out: string[] = [];
    if (!line.trim()) {
      this.#blank(out);
      return out;
    }

    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      this.#space(out);
      this.#inFence = true;
      this.#fenceChar = fence[1][0];
      this.#lang = fence[2].trim();
      const lang = this.#lang ? ` ${this.#s("cyan", this.#lang)}` : "";
      this.#emit(out, `${this.#s("dim", "┌─")}${lang}`);
      return out;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      this.#space(out);
      const level = heading[1].length;
      const text = this.#inline(heading[2]);
      const styled =
        level === 1
          ? this.#s("bold", this.#s("cyan", text))
          : level <= 3
            ? this.#s("bold", text)
            : this.#s("bold", this.#s("dim", text));
      this.#emit(out, styled);
      this.#space(out);
      return out;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      this.#space(out);
      this.#emit(out, this.#s("dim", "─".repeat(Math.min(60, Math.max(20, width - 2)))));
      this.#space(out);
      return out;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(bullet[2]);
      if (task) {
        const done = task[1].toLowerCase() === "x";
        this.#emit(out, `${bullet[1]}${this.#s(done ? "green" : "dim", done ? "☑" : "☐")} ${this.#inline(task[2])}`);
      } else {
        this.#emit(out, `${bullet[1]}${this.#s("cyan", "•")} ${this.#inline(bullet[2])}`);
      }
      return out;
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      this.#emit(out, `${ordered[1]}${this.#s("dim", `${ordered[2]}.`)} ${this.#inline(ordered[3])}`);
      return out;
    }

    const quote = /^(\s*)>\s?(.*)$/.exec(line);
    if (quote) {
      this.#emit(out, `${quote[1]}${this.#s("dim", "│ ")}${this.#inline(quote[2])}`);
      return out;
    }

    this.#emit(out, this.#inline(line));
    return out;
  }

  #flushTable(out: string[], width: number): void {
    const rows = this.#table ?? [];
    this.#table = null;
    if (!rows.length) return;
    const grid = rows.map((r) => this.#splitRow(r));
    const cols = Math.max(...grid.map((r) => r.length));
    if (!cols) return;

    const sepIdx = grid.findIndex((row) => row.length > 0 && row.every((cell) => /^:?-{3,}:?$/.test(cell.trim())));
    let header = grid[0] ?? [];
    let body = sepIdx >= 1 ? grid.slice(sepIdx + 1) : grid.slice(1);
    if (sepIdx === 0) {
      header = grid[1] ?? [];
      body = grid.slice(2);
    }
    const alignRow = sepIdx >= 0 ? grid[sepIdx] : [];
    const aligns = Array.from({ length: cols }, (_, i) => this.#alignOf(alignRow[i] ?? ""));

    const plainRows = grid.map((row) => Array.from({ length: cols }, (_, i) => this.#plain(row[i] ?? "")));
    const maxCell = Math.max(6, Math.floor((Math.max(20, width) - (cols * 3 + 1)) / Math.max(1, cols)));
    const widths = Array.from({ length: cols }, (_, i) => {
      const w = Math.max(1, ...plainRows.map((row) => row[i].length));
      return Math.min(w, maxCell);
    });

    const border = (text: string): string => this.#s("dim", text);
    const cellsRow = (cells: string[], headerRow: boolean): string => {
      const content = widths.map((w, i) => {
        const padded = this.#pad(this.#fit(this.#plain(cells[i] ?? ""), w), w, aligns[i]);
        return headerRow ? this.#s("bold", padded) : padded;
      });
      return `${border("│")} ${content.join(` ${border("│")} `)} ${border("│")}`;
    };

    this.#space(out);
    this.#emit(out, cellsRow(header, true));
    this.#emit(
      out,
      `${border("│")} ${widths.map((w) => this.#s("dim", "─".repeat(w))).join(this.#s("dim", "─┼─"))} ${border("│")}`,
    );
    for (const row of body) this.#emit(out, cellsRow(row, false));
  }

  #splitRow(raw: string): string[] {
    let text = raw.trim();
    if (text.startsWith("|")) text = text.slice(1);
    if (text.endsWith("|")) text = text.slice(0, -1);
    const marker = "\u0000";
    return text
      .replace(/\\\|/g, marker)
      .split("|")
      .map((cell) => cell.replaceAll(marker, "|").trim());
  }

  #startsTable(line: string): boolean {
    const t = line.trim();
    return t.startsWith("|") && !t.startsWith("```") && !t.startsWith("~~~");
  }

  #isTableRow(line: string): boolean {
    const t = line.trim();
    if (!t.includes("|")) return false;
    if (t.startsWith("```") || t.startsWith("~~~")) return false;
    return true;
  }

  #alignOf(cell: string): Align {
    const t = cell.trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    return "left";
  }

  #fit(text: string, width: number): string {
    if (text.length <= width) return text;
    if (width <= 1) return "…";
    return `${text.slice(0, width - 1)}…`;
  }

  #pad(text: string, width: number, align: Align): string {
    const pad = Math.max(0, width - text.length);
    if (align === "right") return `${" ".repeat(pad)}${text}`;
    if (align === "center") {
      const left = Math.floor(pad / 2);
      return `${" ".repeat(left)}${text}${" ".repeat(pad - left)}`;
    }
    return `${text}${" ".repeat(pad)}`;
  }

  #plain(text: string): string {
    return text
      .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|[^\w])__([^_]+)__(?=[^\w]|$)/g, "$1$2")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
  }

  #inline(text: string): string {
    const parts = text.split(/(`+[^`]*`+)/g);
    return parts
      .map((part, index) => {
        if (index % 2 === 1) {
          const ticks = /^`+/.exec(part)?.[0] ?? "`";
          const content = part.slice(ticks.length, part.length - ticks.length);
          return this.#s("cyan", content);
        }
        return this.#inlineText(part);
      })
      .join("");
  }

  #inlineText(text: string): string {
    let s = text;
    s = s.replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (_, alt: string, url: string) => `${this.#s("italic", alt)} ${this.#s("dim", `(${url})`)}`,
    );
    s = s.replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      (_, label: string, url: string) =>
        `${this.#s("cyan", label)}${label === url ? "" : ` ${this.#s("dim", `(${url})`)}`}`,
    );
    s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url: string) => this.#s("cyan", url));
    s = s.replace(/~~([^~]+)~~/g, (_, x: string) => this.#s("strike", x));
    s = s.replace(/\*\*([^*]+)\*\*/g, (_, x: string) => this.#s("bold", x));
    s = s.replace(/(^|[^\w])__([^_]+)__(?=[^\w]|$)/g, (_, pre: string, x: string) => `${pre}${this.#s("bold", x)}`);
    s = s.replace(/\*([^*]+)\*/g, (_, x: string) => this.#s("italic", x));
    s = s.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, (_, pre: string, x: string) => `${pre}${this.#s("italic", x)}`);
    return s;
  }

  #s(style: StyleName, text: string): string {
    if (!this.#color) return text;
    return `${STYLES[style]}${text}${RESET}`;
  }

  #emit(out: string[], text: string): void {
    if (!text) {
      this.#blank(out);
      return;
    }
    out.push(text);
    this.#prevBlank = false;
  }

  #blank(out: string[]): void {
    if (this.#prevBlank) return;
    out.push("");
    this.#prevBlank = true;
  }

  #space(out: string[]): void {
    this.#blank(out);
  }
}
