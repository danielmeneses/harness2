import { FOOTER_ROWS } from "./footer.ts";

export type Key =
  | { type: "char"; ch: string }
  | { type: "enter" }
  | { type: "newline" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "tab" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "ctrl"; ch: string }
  | { type: "alt"; ch: string }
  | { type: "paste"; text: string };

const ESC_MAP: Record<string, Key> = {
  "\x1b[A": { type: "up" },
  "\x1b[B": { type: "down" },
  "\x1b[C": { type: "right" },
  "\x1b[D": { type: "left" },
  "\x1b[H": { type: "home" },
  "\x1b[F": { type: "end" },
  "\x1b[1~": { type: "home" },
  "\x1b[7~": { type: "home" },
  "\x1b[4~": { type: "end" },
  "\x1b[8~": { type: "end" },
  "\x1b[3~": { type: "delete" },
  "\x1b[Z": { type: "tab" },
};

export class Terminal {
  #stdin = process.stdin;
  #stdout = process.stdout;
  #buf = "";
  #queue: Key[] = [];
  #waiters: Array<(k: Key | null) => void> = [];
  #defaultHandler: ((k: Key) => void) | null = null;
  #mode: "modal" | "default" = "default";
  #started = false;
  #keepAlive: NodeJS.Timeout | null = null;
  #escTimer: NodeJS.Timeout | null = null;
  #fullscreen = false;

  get isTTY(): boolean {
    return !!this.#stdin.isTTY && !!this.#stdout.isTTY;
  }

  get width(): number {
    return this.#stdout.columns || 80;
  }

  get height(): number {
    return this.#stdout.rows || 24;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (!this.#fullscreen) {
      this.#fullscreen = true;
      // Clear the visible screen and prior scrollback once; subsequent output
      // scrolls into normal terminal scrollback so the conversation remains
      // browsable.
      this.write("\x1b[3J\x1b[2J\x1b[H");
    }
    this.setScrollRegion(1, Math.max(1, this.height - FOOTER_ROWS));
    if (this.#stdin.isTTY) this.#stdin.setRawMode(true);
    this.#stdin.setEncoding("utf8");
    this.#stdin.resume();
    this.#stdin.on("data", this.#onData);
    this.#stdin.on("end", this.#onEnd);
    this.#stdin.on("close", this.#onEnd);
    // A raw TTY normally keeps the event loop alive, but some wrappers pause
    // stdin while idle. Keep an explicit ref until the terminal is stopped.
    if (!this.#keepAlive) this.#keepAlive = setInterval(() => {}, 60_000);
    this.write("\x1b[?2004h");
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.write("\x1b[?2004l");
    this.#stdin.off("data", this.#onData);
    this.#stdin.off("end", this.#onEnd);
    this.#stdin.off("close", this.#onEnd);
    if (this.#keepAlive) {
      clearInterval(this.#keepAlive);
      this.#keepAlive = null;
    }
    if (this.#escTimer) {
      clearTimeout(this.#escTimer);
      this.#escTimer = null;
    }
    if (this.#stdin.isTTY) {
      try {
        this.#stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    this.#stdin.pause();
    this.resetScrollRegion();
    this.#buf = "";
    this.#queue = [];
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }

  write(text: string): void {
    try {
      this.#stdout.write(text);
    } catch {
      // EPIPE or closed stdout
    }
  }

  moveTo(row: number, col: number): void {
    this.write(`\x1b[${Math.max(1, row)};${Math.max(1, col)}H`);
  }

  clearLine(): void {
    this.write("\x1b[2K");
  }

  saveCursor(): void {
    this.write("\x1b7");
  }

  restoreCursor(): void {
    this.write("\x1b8");
  }

  setScrollRegion(top: number, bottom: number): void {
    this.write(`\x1b[${Math.max(1, top)};${Math.max(1, bottom)}r`);
  }

  resetScrollRegion(): void {
    this.write("\x1b[r");
  }

  setDefaultHandler(handler: ((k: Key) => void) | null): void {
    this.#defaultHandler = handler;
  }

  setMode(mode: "modal" | "default"): void {
    this.#mode = mode;
  }

  readKey(): Promise<Key | null> {
    this.#mode = "modal";
    if (!this.#started) return Promise.resolve(null);
    if (this.#queue.length) return Promise.resolve(this.#queue.shift() as Key);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async readLine(prompt: string): Promise<string | null> {
    const prevMode = this.#mode;
    this.#mode = "modal";
    this.write(prompt);
    let buf = "";
    try {
      while (true) {
      const k = await this.readKey();
      if (!k) return null;
      if (k.type === "enter") {
        this.write("\r\n");
        return buf;
      }
      if (k.type === "ctrl" && k.ch === "c") {
        this.write("^C\r\n");
        return null;
      }
      if (k.type === "escape") {
        this.write("^[\r\n");
        return null;
      }
      if (k.type === "ctrl" && k.ch === "d" && !buf) {
        this.write("\r\n");
        return null;
      }
      if (k.type === "backspace") {
        if (buf) {
          const chars = [...buf];
          const last = chars.pop() ?? "";
          buf = chars.join("");
          this.write(last.length > 1 ? "\b \b".repeat(last.length) : "\b \b");
        }
        continue;
      }
      if (k.type === "char") {
        if (buf.length < 2000) {
          buf += k.ch;
          this.write(k.ch);
        }
      } else if (k.type === "paste") {
        const text = k.text.replace(/\s+/g, " ").slice(0, 2000);
        buf += text;
        this.write(text);
      }
      }
    } finally {
      this.#mode = prevMode;
    }
  }

  async readSecret(prompt: string): Promise<string | null> {
    const prevMode = this.#mode;
    this.#mode = "modal";
    this.write(prompt);
    let buf = "";
    try {
      while (true) {
        const k = await this.readKey();
        if (!k) return null;
        if (k.type === "enter") {
          this.write("\r\n");
          return buf;
        }
        if (k.type === "ctrl" && k.ch === "c") {
          this.write("^C\r\n");
          return null;
        }
        if (k.type === "escape") {
          this.write("^[\r\n");
          return null;
        }
        if (k.type === "ctrl" && k.ch === "d" && !buf) {
          this.write("\r\n");
          return null;
        }
        if (k.type === "backspace") {
          if (buf) {
            buf = buf.slice(0, -1);
            this.write("\b \b");
          }
          continue;
        }
        if (k.type === "char") {
          if (buf.length < 4000) {
            buf += k.ch;
            this.write("*");
          }
        } else if (k.type === "paste") {
          const text = k.text.replace(/\s+/g, "").slice(0, 4000 - buf.length);
          buf += text;
          this.write("*".repeat(text.length));
        }
      }
    } finally {
      this.#mode = prevMode;
    }
  }

  async readChoice(allowed: string[], prompt: string): Promise<string | null> {
    const prevMode = this.#mode;
    this.#mode = "modal";
    this.write(prompt);
    try {
      while (true) {
      const k = await this.readKey();
      if (!k) return null;
      if ((k.type === "ctrl" && k.ch === "c") || k.type === "escape") {
        if (allowed.includes("n")) {
          this.write("n\r\n");
          return "n";
        }
        this.write("\r\n");
        return null;
      }
      if (k.type === "enter") {
        if (allowed.includes("n")) {
          this.write("n\r\n");
          return "n";
        }
        continue;
      }
      if (k.type === "char") {
        const ch = k.ch.toLowerCase();
        if (allowed.includes(ch)) {
          this.write(`${ch}\r\n`);
          return ch;
        }
      }
      }
    } finally {
      this.#mode = prevMode;
    }
  }

  #onEnd = (): void => {
    this.stop();
  };

  #onData = (chunk: string | Buffer): void => {
    this.#buf += chunk.toString();
    if (this.#escTimer) {
      clearTimeout(this.#escTimer);
      this.#escTimer = null;
    }
    const keys = this.#parse();
    for (const key of keys) this.#dispatch(key);
    // A lone ESC is also the prefix of every escape sequence. Give the rest
    // of a split sequence a moment to arrive before treating it as Escape.
    if (this.#buf === "\x1b") {
      this.#escTimer = setTimeout(() => {
        this.#escTimer = null;
        if (this.#buf !== "\x1b") return;
        this.#buf = "";
        this.#dispatch({ type: "escape" });
      }, 30);
    }
  };

  #dispatch(key: Key): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(key);
      return;
    }
    if (this.#mode === "default" && this.#defaultHandler) {
      this.#defaultHandler(key);
      return;
    }
    this.#queue.push(key);
  }

  #parse(): Key[] {
    const out: Key[] = [];
    while (this.#buf.length) {
      if (this.#buf.startsWith("\x1b[200~")) {
        const end = this.#buf.indexOf("\x1b[201~");
        if (end < 0) break;
        out.push({ type: "paste", text: this.#buf.slice(6, end) });
        this.#buf = this.#buf.slice(end + 6);
        continue;
      }
      if (this.#buf.startsWith("\x1b")) {
        if (this.#buf.startsWith("\x1b\r") || this.#buf.startsWith("\x1b\n")) {
          out.push({ type: "newline" });
          this.#buf = this.#buf.slice(2);
          continue;
        }
        const seq = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(this.#buf);
        if (seq) {
          const key = ESC_MAP[seq[0]];
          if (key) out.push(key);
          this.#buf = this.#buf.slice(seq[0].length);
          continue;
        }
        if (this.#buf.startsWith("\x1b[") || this.#buf.startsWith("\x1bO")) {
          if (this.#buf.startsWith("\x1bO") && this.#buf.length >= 3) {
            this.#buf = this.#buf.slice(3);
            continue;
          }
          break;
        }
        if (this.#buf.length >= 2) {
          const ch = [...this.#buf.slice(1)][0];
          if (ch) {
            out.push({ type: "alt", ch });
            this.#buf = this.#buf.slice(1 + ch.length);
            continue;
          }
        }
        break;
      }

      const ch = [...this.#buf][0];
      this.#buf = this.#buf.slice(ch.length);
      const code = ch.codePointAt(0) ?? 0;
      if (ch === "\r") out.push({ type: "enter" });
      else if (ch === "\n") out.push({ type: "newline" });
      else if (ch === "\x7f" || ch === "\b") out.push({ type: "backspace" });
      else if (ch === "\t") out.push({ type: "tab" });
      else if (code >= 32) out.push({ type: "char", ch });
      else if (code >= 1 && code <= 26) out.push({ type: "ctrl", ch: String.fromCharCode(code + 96) });
    }
    return out;
  }
}
