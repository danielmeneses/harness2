import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readdir, readFile, rmdir, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Event } from "./events.ts";
import type { Msg, TodoItem, Usage } from "./types.ts";
import { randomId } from "./util.ts";
import { defaultSpec, type LoopSpec } from "./loop/spec.ts";
import type { SpecLimits } from "./loop/limits.ts";
import { harnessPath } from "./home.ts";

export type SessionMeta = {
  id: string;
  cwd: string;
  model: string;
  mode: string;
  version: string;
};

export type SessionInfo = {
  path: string;
  mtime: number;
  meta: SessionMeta;
};

export type LoadedSession = {
  path: string;
  meta: SessionMeta | null;
  messages: Msg[];
  spec: LoopSpec;
  stageIndex: number;
  notes: string[];
  todos: TodoItem[];
  usage: Usage;
  contextTokens: number;
  contextReported: boolean;
  lastAssistant: string;
  events: Event[];
};

export function sessionFileName(meta: SessionMeta): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${ts}-${meta.id}.jsonl`;
}

export class SessionStore {
  path: string;
  #fh: FileHandle | null;
  #queue: Promise<void> = Promise.resolve();

  private constructor(path: string, fh: FileHandle) {
    this.path = path;
    this.#fh = fh;
  }

  static async create(dir: string, meta: SessionMeta): Promise<SessionStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, sessionFileName(meta));
    const fh = await open(path, "a", 0o600);
    await chmod(path, 0o600).catch(() => {});
    return new SessionStore(path, fh);
  }

  static async open(path: string): Promise<SessionStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const fh = await open(path, "a", 0o600);
    await chmod(path, 0o600).catch(() => {});
    return new SessionStore(path, fh);
  }

  append(ev: Event): void {
    const line = `${JSON.stringify(ev)}\n`;
    this.#queue = this.#queue
      .then(async () => {
        if (this.#fh) await this.#fh.write(line);
      })
      .catch(() => {
        // a broken session log must not kill the run
      });
  }

  async switchTo(path: string): Promise<void> {
    await this.close();
    this.path = path;
    this.#fh = await open(path, "a");
  }

  async close(): Promise<void> {
    await this.#queue;
    if (this.#fh) {
      const fh = this.#fh;
      this.#fh = null;
      await fh.close().catch(() => {});
    }
  }
}

async function readJsonl(path: string): Promise<Event[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Event[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Event);
    } catch {
      // ignore a torn final line
    }
  }
  return out;
}

export async function loadSession(path: string, limits: SpecLimits): Promise<LoadedSession> {
  const events = await readJsonl(path);
  let meta: SessionMeta | null = null;
  let messages: Msg[] = [];
  let spec = defaultSpec(limits);
  let stageIndex = 0;
  let notes: string[] = [];
  let todos: TodoItem[] = [];
  let usage: Usage = {};
  let contextTokens = 0;
  let contextReported = false;
  let lastAssistant = "";

  for (const ev of events) {
    if (ev.stream !== "main") continue;
    switch (ev.t) {
      case "session.start":
        meta = { id: ev.id, cwd: ev.cwd, model: ev.model, mode: ev.mode, version: ev.version };
        break;
      case "session.clear":
        messages = [];
        notes = [];
        todos = [];
        stageIndex = 0;
        break;
      case "user.message":
        messages.push({ role: "user", content: ev.text, synthetic: ev.synthetic });
        break;
      case "assistant.message":
        messages.push({
          role: "assistant",
          content: ev.text,
          thinking: ev.thinking || undefined,
          toolCalls: ev.toolCalls.length ? ev.toolCalls : undefined,
          synthetic: ev.synthetic,
        });
        if (ev.text.trim()) lastAssistant = ev.text;
        break;
      case "tool.result":
        messages.push({
          role: "tool",
          toolCallId: ev.id,
          name: ev.name,
          content: ev.output,
          ok: ev.ok,
        });
        break;
      case "loop.spec":
        spec = ev.spec;
        stageIndex = Math.min(stageIndex, spec.stages.length - 1);
        break;
      case "loop.stage":
        stageIndex = Math.max(0, Math.min(ev.index, spec.stages.length - 1));
        break;
      case "loop.note":
        notes.push(ev.text);
        break;
      case "todo":
        todos = ev.items;
        break;
      case "compaction": {
        contextTokens = ev.afterTokens;
        contextReported = false;
        const keep = Math.max(0, ev.afterMessages - 1);
        const kept = messages.slice(-keep);
        while (kept.length && kept[0].role === "tool") kept.shift();
        messages = [
          { role: "user", content: `[Compacted history summary]\n${ev.summary}\n\nContinue from here.`, synthetic: true },
          ...kept,
        ];
        break;
      }
      case "usage":
        usage = {
          promptTokens: (usage.promptTokens ?? 0) + (ev.usage.promptTokens ?? 0),
          completionTokens: (usage.completionTokens ?? 0) + (ev.usage.completionTokens ?? 0),
          totalTokens: (usage.totalTokens ?? 0) + (ev.usage.totalTokens ?? 0),
        };
        if (ev.usage.promptTokens !== undefined) {
          contextTokens = ev.usage.promptTokens;
          contextReported = ev.reported !== false;
        }
        break;
      default:
        break;
    }
  }

  // Repair an interrupted turn: the last assistant message may have tool calls without results.
  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === "assistant" && m.toolCalls?.length);
  if (lastAssistantMsg && lastAssistantMsg.role === "assistant") {
    const ids = new Set(messages.filter((m) => m.role === "tool").map((m) => m.toolCallId));
    for (const call of lastAssistantMsg.toolCalls ?? []) {
      if (!ids.has(call.id)) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: "[interrupted: harness stopped before this tool produced a result]",
          ok: false,
        });
      }
    }
  }

  spec = spec.stages.length ? spec : defaultSpec(limits);
  return {
    path,
    meta,
    messages,
    spec,
    stageIndex,
    notes,
    todos,
    usage,
    contextTokens,
    contextReported,
    lastAssistant,
    events,
  };
}

export async function listSessions(dir: string, cwd: string, limit = 20): Promise<SessionInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    const first = await readFile(path, "utf8").then((raw) => raw.split("\n")[0] ?? "").catch(() => "");
    let meta: SessionMeta | null = null;
    try {
      const ev = JSON.parse(first) as Event;
      if (ev.t === "session.start") meta = { id: ev.id, cwd: ev.cwd, model: ev.model, mode: ev.mode, version: ev.version };
    } catch {
      // not a session file
    }
    if (!meta || meta.cwd !== cwd) continue;
    out.push({ path, mtime: s.mtimeMs, meta });
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export async function latestSession(dir: string, cwd: string): Promise<string | null> {
  const list = await listSessions(dir, cwd, 1);
  return list[0]?.path ?? null;
}

export function exportMarkdown(loaded: LoadedSession): string {
  const lines: string[] = [];
  if (loaded.meta) {
    lines.push(`# harness2 session ${loaded.meta.id}`, "", `- cwd: \`${loaded.meta.cwd}\``, `- model: \`${loaded.meta.model}\``, "");
  }
  lines.push(`## Loop spec`, "", "```json", JSON.stringify(loaded.spec, null, 2), "```", "");
  if (loaded.notes.length) {
    lines.push("## Notes", "", ...loaded.notes.map((n) => `- ${n}`), "");
  }
  lines.push("## Conversation", "");
  for (const m of loaded.messages) {
    if (m.role === "user") {
      if (m.synthetic && m.content.startsWith("[harness loop state]")) continue;
      lines.push(`### User`, "", m.content, "");
    } else if (m.role === "assistant") {
      lines.push(`### Assistant`, "");
      if (m.thinking) lines.push("<details><summary>thinking</summary>", "", m.thinking, "", "</details>", "");
      if (m.content) lines.push(m.content, "");
      for (const call of m.toolCalls ?? []) {
        lines.push(`<details><summary>tool call: ${call.name}</summary>`, "", "```json", JSON.stringify(call.args, null, 2), "```", "", "</details>", "");
      }
    } else {
      lines.push(`### Tool result: ${m.name} (${m.ok ? "ok" : "failed"})`, "", "```", m.content, "```", "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function newSessionMeta(cwd: string, model: string, mode: string, version: string): SessionMeta {
  return { id: randomId(), cwd, model, mode, version };
}

export function historyPath(): string {
  return harnessPath("history.jsonl");
}

/** Move a project's old .harness2/sessions and history into the central home. */
export async function migrateProjectState(cwd: string, targetSessionsDir: string, migrateSessions: boolean): Promise<void> {
  const legacyRoot = join(cwd, ".harness2");
  const legacySessions = join(legacyRoot, "sessions");
  if (migrateSessions && resolve(legacySessions) !== resolve(targetSessionsDir)) {
    try {
      await mkdir(targetSessionsDir, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(legacySessions, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const src = join(legacySessions, entry.name);
        const dest = join(targetSessionsDir, entry.name);
        try {
          await copyFile(src, dest, constants.COPYFILE_EXCL);
          await chmod(dest, 0o600).catch(() => {});
          await unlink(src);
        } catch {
          // Leave a non-migratable file alone rather than risk data loss.
        }
      }
      await rmdir(legacySessions).catch(() => {});
    } catch {
      // No legacy project sessions.
    }
  }

  const legacyHistory = join(legacyRoot, "history.jsonl");
  const targetHistory = historyPath();
  if (resolve(legacyHistory) !== resolve(targetHistory)) {
    try {
      const raw = await readFile(legacyHistory, "utf8");
      if (raw) {
        await mkdir(dirname(targetHistory), { recursive: true, mode: 0o700 });
        const fh = await open(targetHistory, "a", 0o600);
        await fh.write(raw.endsWith("\n") ? raw : `${raw}\n`);
        await fh.close();
        await chmod(targetHistory, 0o600).catch(() => {});
      }
      await unlink(legacyHistory);
    } catch {
      // No legacy project history.
    }
  }
  await rmdir(legacyRoot).catch(() => {});
}

export async function loadHistory(path: string, limit = 200): Promise<string[]> {
  const raw = await readFile(path, "utf8").catch(() => "");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (typeof v === "string") out.push(v);
    } catch {
      // ignore
    }
  }
  return out.slice(-limit);
}

export async function appendHistory(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, "a", 0o600);
  await fh.write(`${JSON.stringify(line)}\n`);
  await fh.close();
  await chmod(path, 0o600).catch(() => {});
}
