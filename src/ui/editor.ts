import type { Terminal, Key } from "./terminal.ts";
import { filterCommands, type SlashCommand } from "../commands.ts";
import { sanitizeTerminal } from "../util.ts";
import type { ControlPanel } from "./control.ts";
import { drawFooter, footerTop } from "./footer.ts";

type Layout = { rows: number; cursorRow: number; cursorCol: number; lines: string[] };

function singleLine(text: string): string {
  return sanitizeTerminal(text).replace(/\s+/g, " ");
}

function clip(text: string, width: number): string {
  if (width <= 1) return "…";
  if (text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}

export type EditorResult = string | null | { action: "toggle-thinking"; text: string };

export type SelectOption = { value: string; label: string; description?: string };

function computeLayout(buffer: string, cursor: number, width: number): Layout {
  const lines = buffer.split("\n");
  let lineIdx = lines.length - 1;
  let col = lines[lineIdx]?.length ?? 0;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (cursor <= count + lines[i].length) {
      lineIdx = i;
      col = cursor - count;
      break;
    }
    count += lines[i].length + 1;
  }
  const indent = 2;
  let rows = 0;
  let cursorRow = 0;
  let cursorCol = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineRows = Math.max(1, Math.ceil((indent + lines[i].length) / width));
    if (i === lineIdx) {
      const pos = indent + col;
      cursorRow = rows + Math.floor(pos / width);
      cursorCol = Math.min(width - 1, pos % width);
    }
    rows += lineRows;
  }
  return { rows, cursorRow, cursorCol, lines };
}

export class Editor {
  #term: Terminal;
  #history: string[];
  #histIdx = 0;
  #draft = "";
  #color: boolean;
  #menuIndex = 0;
  #lastQuery: string | null = null;
  #select: { options: SelectOption[]; title: string } | null = null;
  #selectIndex = 0;
  #lastSelectQuery: string | null = null;
  #control: (() => ControlPanel) | null = null;
  #footerActive = false;
  #prevChromeStart = 0;
  buffer = "";
  cursor = 0;
  #prev: { rows: number; cursorRow: number } = { rows: 0, cursorRow: 0 };

  constructor(term: Terminal, history: string[], opts: { color?: boolean } = {}) {
    this.#term = term;
    this.#history = history.slice(-200);
    this.#color = opts.color ?? true;
  }

  setControl(control: (() => ControlPanel) | null): void {
    this.#control = control;
  }

  remember(line: string): void {
    this.#history.push(line);
    if (this.#history.length > 200) this.#history = this.#history.slice(-200);
    this.#histIdx = this.#history.length;
    this.#draft = "";
  }

  async select(options: SelectOption[], title: string): Promise<string | null> {
    this.#select = { options, title };
    this.#selectIndex = 0;
    this.#lastSelectQuery = null;
    this.buffer = "";
    this.cursor = 0;
    this.#footerActive = false;
    this.#prevChromeStart = 0;
    this.#render();
    while (true) {
      const key = await this.#term.readKey();
      if (!key) {
        this.#closeSelect();
        return null;
      }
      const action = this.#applySelect(key);
      if (action?.kind === "selected") {
        this.#closeSelect();
        return action.value;
      }
      if (action?.kind === "cancel") {
        this.#closeSelect();
        return null;
      }
      this.#render();
    }
  }

  #closeSelect(): void {
    this.#closeFooter();
    this.#select = null;
    this.#lastSelectQuery = null;
    this.buffer = "";
    this.cursor = 0;
  }

  #applySelect(key: Key): { kind: "selected"; value: string } | { kind: "cancel" } | null {
    if (key.type === "enter") {
      const matches = this.#selectMatches();
      if (!matches.length) return null;
      const index = Math.max(0, Math.min(this.#selectIndex, matches.length - 1));
      return { kind: "selected", value: matches[index].value };
    }
    if (key.type === "up" || key.type === "down") {
      const matches = this.#selectMatches();
      if (!matches.length) return null;
      const n = matches.length;
      const current = Math.max(0, Math.min(this.#selectIndex, n - 1));
      this.#selectIndex = key.type === "up" ? (current - 1 + n) % n : (current + 1) % n;
      return null;
    }
    if (key.type === "escape" || (key.type === "ctrl" && key.ch === "c")) return { kind: "cancel" };
    if (key.type === "ctrl" && (key.ch === "o" || key.ch === "d")) return null;
    if (key.type === "tab" || key.type === "newline") return null;
    this.#apply(key);
    return null;
  }

  #selectMatches(): SelectOption[] {
    const select = this.#select;
    if (!select) return [];
    const query = this.buffer.trim().toLowerCase();
    if (!query) return select.options;
    const byLabel = select.options.filter((option) =>
      `${option.label} ${option.value}`.toLowerCase().includes(query),
    );
    if (byLabel.length) return byLabel;
    return select.options.filter((option) =>
      (option.description ?? "").toLowerCase().includes(query),
    );
  }

  #syncSelect(): void {
    if (this.buffer !== this.#lastSelectQuery) {
      this.#lastSelectQuery = this.buffer;
      this.#selectIndex = 0;
    }
  }

  #selectMenuLines(inputRows: number, width: number): string[] {
    const select = this.#select;
    if (!select) return [];
    const matches = this.#selectMatches();
    const maxRows = Math.max(1, this.#term.height - inputRows - 4);
    const visible = Math.min(matches.length, maxRows);
    const index = Math.max(0, Math.min(this.#selectIndex, Math.max(0, matches.length - 1)));
    const start = Math.max(0, Math.min(index - Math.floor(visible / 2), matches.length - visible));
    const labelWidth = Math.min(
      50,
      matches.length
        ? Math.max(...matches.map((option) => singleLine(option.label).length))
        : 0,
    );
    const lines: string[] = [];
    lines.push(this.#style("\x1b[1m\x1b[36m", clip(singleLine(select.title), width - 1)));
    for (let i = 0; i < visible; i++) {
      const option = matches[start + i];
      const selected = start + i === index;
      const label = singleLine(option.label);
      const description = singleLine(option.description ?? "");
      const plain = `${selected ? "▸ " : "  "}${clip(label, labelWidth).padEnd(labelWidth)}  ${description}`;
      const text = clip(plain, width - 1);
      lines.push(selected ? this.#style("\x1b[1m\x1b[36m", text) : this.#style("\x1b[2m", text));
    }
    if (!matches.length) lines.push(this.#style("\x1b[2m", "  no matches"));
    const count = matches.length ? `${index + 1}/${matches.length}` : "0/0";
    const hint = clip(`  ↑/↓ select · Enter choose · type to filter · Esc/Ctrl-C cancel · ${count}`, width - 1);
    lines.push(this.#style("\x1b[2m", hint));
    return lines;
  }

  async read(initial = ""): Promise<EditorResult> {
    this.#histIdx = this.#history.length;
    this.#draft = initial;
    this.buffer = initial;
    this.cursor = initial.length;
    this.#footerActive = false;
    this.#prevChromeStart = 0;
    this.#render();
    while (true) {
      const key = await this.#term.readKey();
      if (!key) {
        this.#closeFooter();
        return null;
      }
      const action = this.#apply(key);
      if (action === "submit") {
        const out = this.buffer;
        this.buffer = "";
        this.cursor = 0;
        this.#drawRunningFooter();
        return out;
      }
      if (action === "cancel") {
        this.#closeFooter();
        this.buffer = "";
        this.cursor = 0;
        return null;
      }
      if (action === "toggle-thinking") {
        const text = this.buffer;
        this.#closeFooter();
        this.buffer = "";
        this.cursor = 0;
        return { action: "toggle-thinking", text };
      }
      this.#render();
    }
  }

  #inputLayout(width: number): { lines: string[]; cursorLine: number; cursorCol: number } {
    const available = Math.max(1, width - 2);
    const logical = this.buffer.split("\n");
    const before = this.buffer.slice(0, this.cursor);
    const cursorLogical = before.split("\n").length - 1;
    const lineStart = before.lastIndexOf("\n") + 1;
    const cursorOffset = this.cursor - lineStart;
    const lines: string[] = [];
    let cursorLine = 0;
    let cursorCol = 0;

    for (let i = 0; i < logical.length; i++) {
      const text = logical[i];
      const visualStart = lines.length;
      if (!text.length) {
        lines.push("");
      } else {
        for (let pos = 0; pos < text.length; pos += available) {
          lines.push(text.slice(pos, pos + available));
        }
      }
      if (i === cursorLogical) {
        const exactEnd = cursorOffset > 0 && cursorOffset === text.length && cursorOffset % available === 0;
        if (exactEnd) {
          if (i === logical.length - 1) {
            lines.push("");
            cursorLine = lines.length - 1;
          } else {
            // The cursor is on the explicit newline; the next logical line owns
            // the cursor row, so do not add a synthetic wrap line here.
            cursorLine = lines.length;
          }
          cursorCol = 0;
        } else {
          const chunk = Math.floor(cursorOffset / available);
          cursorLine = visualStart + Math.min(chunk, Math.max(0, lines.length - visualStart - 1));
          cursorCol = cursorOffset % available;
        }
      }
    }

    if (!lines.length) lines.push("");
    const maxInputRows = Math.max(1, this.#term.height - 4);
    if (lines.length > maxInputRows) {
      const start = Math.max(0, Math.min(cursorLine - Math.floor(maxInputRows / 2), lines.length - maxInputRows));
      const visible = lines.slice(start, start + maxInputRows);
      cursorLine -= start;
      return { lines: visible, cursorLine, cursorCol };
    }
    return { lines, cursorLine, cursorCol };
  }

  #drawRunningFooter(): void {
    const newTop = footerTop(this.#term, 1);
    this.#clearChromeAbove(newTop);
    drawFooter(this.#term, {
      inputLines: [""],
      control: this.#control ? this.#control() : null,
      color: this.#color,
    });
    this.#term.restoreCursor();
    this.#footerActive = false;
    this.#prevChromeStart = 0;
    this.#prev = { rows: 0, cursorRow: 0 };
  }

  #clearChromeAbove(newStart: number): void {
    if (this.#prevChromeStart > 0 && this.#prevChromeStart < newStart) {
      for (let row = this.#prevChromeStart; row < newStart; row++) {
        this.#term.moveTo(row, 1);
        this.#term.clearLine();
      }
    }
    this.#prevChromeStart = 0;
  }

  #closeFooter(): void {
    if (this.#prevChromeStart > 0) {
      for (let row = this.#prevChromeStart; row <= this.#term.height; row++) {
        this.#term.moveTo(row, 1);
        this.#term.clearLine();
      }
    }
    this.#prevChromeStart = 0;
    this.#restoreOutput();
    this.#prev = { rows: 0, cursorRow: 0 };
  }

  #restoreOutput(): void {
    if (!this.#footerActive) return;
    this.#term.restoreCursor();
    this.#footerActive = false;
  }

  #apply(key: Key): "submit" | "cancel" | "toggle-thinking" | null {
    switch (key.type) {
      case "enter": {
        const matches = this.#menuMatches();
        if (matches.length) {
          const index = Math.max(0, Math.min(this.#menuIndex, matches.length - 1));
          this.buffer = matches[index].name;
          this.cursor = this.buffer.length;
        }
        return "submit";
      }
      case "escape":
        if (this.#menuMatches().length) {
          this.buffer = "";
          this.cursor = 0;
          this.#menuIndex = 0;
        }
        return null;
      case "newline":
        this.#insert("\n");
        return null;
      case "char":
        this.#insert(key.ch);
        return null;
      case "paste":
        this.#insert(key.text.replace(/\r\n/g, "\n").replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
        return null;
      case "tab": {
        const matches = this.#menuMatches();
        if (matches.length) {
          const index = Math.max(0, Math.min(this.#menuIndex, matches.length - 1));
          const text = `${matches[index].name} `;
          this.buffer = text;
          this.cursor = text.length;
          this.#menuIndex = 0;
          return null;
        }
        this.#insert("  ");
        return null;
      }
      case "backspace": {
        if (this.cursor === 0) return null;
        const before = this.buffer.slice(0, this.cursor);
        const last = [...before].pop() ?? "";
        this.buffer = this.buffer.slice(0, this.cursor - last.length) + this.buffer.slice(this.cursor);
        this.cursor -= last.length;
        return null;
      }
      case "delete": {
        const next = [...this.buffer.slice(this.cursor)][0] ?? "";
        if (!next) return null;
        this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + next.length);
        return null;
      }
      case "left": {
        const before = this.buffer.slice(0, this.cursor);
        const last = [...before].pop() ?? "";
        this.cursor -= last.length;
        return null;
      }
      case "right": {
        const next = [...this.buffer.slice(this.cursor)][0] ?? "";
        this.cursor += next.length;
        return null;
      }
      case "home":
        this.cursor = this.buffer.lastIndexOf("\n", this.cursor - 1) + 1;
        return null;
      case "end": {
        const nl = this.buffer.indexOf("\n", this.cursor);
        this.cursor = nl < 0 ? this.buffer.length : nl;
        return null;
      }
      case "up":
      case "down": {
        const matches = this.#menuMatches();
        if (matches.length) {
          const n = matches.length;
          const current = Math.max(0, Math.min(this.#menuIndex, n - 1));
          this.#menuIndex = key.type === "up" ? (current - 1 + n) % n : (current + 1) % n;
          return null;
        }
        this.#historyMove(key.type === "up" ? -1 : 1);
        return null;
      }
      case "ctrl": {
        if (key.ch === "c") {
          if (!this.buffer) return "cancel";
          this.buffer = "";
          this.cursor = 0;
          return null;
        }
        if (key.ch === "d") {
          if (!this.buffer) return "cancel";
          const next = [...this.buffer.slice(this.cursor)][0] ?? "";
          if (next) this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + next.length);
          return null;
        }
        if (key.ch === "a") {
          this.cursor = this.buffer.lastIndexOf("\n", this.cursor - 1) + 1;
          return null;
        }
        if (key.ch === "e") {
          const nl = this.buffer.indexOf("\n", this.cursor);
          this.cursor = nl < 0 ? this.buffer.length : nl;
          return null;
        }
        if (key.ch === "u") {
          const start = this.buffer.lastIndexOf("\n", this.cursor - 1) + 1;
          this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
          this.cursor = start;
          return null;
        }
        if (key.ch === "k") {
          const end = this.buffer.indexOf("\n", this.cursor);
          const realEnd = end < 0 ? this.buffer.length : end;
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(realEnd);
          return null;
        }
        if (key.ch === "o") return "toggle-thinking";
        if (key.ch === "w") {
          const before = this.buffer.slice(0, this.cursor);
          const m = /(\s*\S+)\s*$/.exec(before);
          if (m) {
            const cut = m[1].length;
            this.buffer = this.buffer.slice(0, this.cursor - cut) + this.buffer.slice(this.cursor);
            this.cursor -= cut;
          }
          return null;
        }
        return null;
      }
      default:
        return null;
    }
  }

  #insert(text: string): void {
    if (this.buffer.length + text.length > 200_000) return;
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  #historyMove(delta: number): void {
    if (this.buffer.includes("\n")) return;
    if (this.#histIdx === this.#history.length) this.#draft = this.buffer;
    const next = this.#histIdx + delta;
    if (next < 0) return;
    if (next >= this.#history.length) {
      this.#histIdx = this.#history.length;
      this.buffer = this.#draft;
    } else {
      this.#histIdx = next;
      this.buffer = this.#history[next] ?? "";
    }
    this.cursor = this.buffer.length;
  }

  #menuQuery(): string | null {
    const match = /^\/([^\s]*)$/.exec(this.buffer);
    return match ? match[1].toLowerCase() : null;
  }

  #menuMatches(): SlashCommand[] {
    const query = this.#menuQuery();
    return query === null ? [] : filterCommands(query);
  }

  #syncMenu(): void {
    const query = this.#menuQuery();
    if (query !== this.#lastQuery) {
      this.#lastQuery = query;
      this.#menuIndex = 0;
    }
  }

  #style(code: string, text: string): string {
    return this.#color ? `${code}${text}\x1b[0m` : text;
  }

  #menuLines(inputRows: number, width: number): string[] {
    const matches = this.#menuMatches();
    if (!matches.length) return [];
    const maxRows = Math.max(1, this.#term.height - inputRows - 3);
    const visible = Math.min(matches.length, maxRows);
    const index = Math.max(0, Math.min(this.#menuIndex, matches.length - 1));
    const start = Math.max(0, Math.min(index - Math.floor(visible / 2), matches.length - visible));
    const labelWidth = Math.min(
      44,
      Math.max(...matches.map((command) => command.name.length + (command.args ? 1 + command.args.length : 0))),
    );
    const lines: string[] = [];
    for (let i = 0; i < visible; i++) {
      const command = matches[start + i];
      const selected = start + i === index;
      const label = command.name + (command.args ? ` ${command.args}` : "");
      const plain = `${selected ? "▸ " : "  "}${clip(label, labelWidth).padEnd(labelWidth)}  ${command.description}`;
      const text = clip(plain, width - 1);
      lines.push(selected ? this.#style("\x1b[1m\x1b[36m", text) : this.#style("\x1b[2m", text));
    }
    const hint = clip(`  ↑/↓ select · Tab insert · Enter run · ${index + 1}/${matches.length}`, width - 1);
    lines.push(this.#style("\x1b[2m", hint));
    return lines;
  }

  #render(): void {
    const width = Math.max(20, this.#term.width);
    const input = this.#inputLayout(width);
    const top = footerTop(this.#term, input.lines.length);
    const menu = this.#select
      ? this.#selectMenuLines(1, width)
      : this.#menuLines(1, width);
    if (!this.#footerActive) {
      this.#term.saveCursor();
      this.#footerActive = true;
    }
    const menuRows = Math.max(0, top - 1);
    const visibleMenu = menuRows ? menu.slice(-menuRows) : [];
    const menuStart = top - visibleMenu.length;
    if (this.#prevChromeStart > 0 && this.#prevChromeStart < menuStart) {
      for (let row = this.#prevChromeStart; row < menuStart; row++) {
        this.#term.moveTo(row, 1);
        this.#term.clearLine();
      }
    }
    for (let i = 0; i < visibleMenu.length; i++) {
      this.#term.moveTo(menuStart + i, 1);
      this.#term.clearLine();
      this.#term.write(visibleMenu[i]);
    }

    drawFooter(this.#term, {
      inputLines: input.lines,
      control: this.#control ? this.#control() : null,
      color: this.#color,
    });
    this.#term.moveTo(top + 1 + input.cursorLine, 3 + input.cursorCol);
    this.#prevChromeStart = menuStart;
    this.#prev = { rows: 0, cursorRow: 0 };
  }
}
