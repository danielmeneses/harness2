import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { historyPath, loadSession, migrateProjectState } from "../src/session.ts";
import { defaultSpec, normalizeSpec } from "../src/loop/spec.ts";

const LIMITS = { maxStepsCap: 100, contextWindow: 32768 };

function line(ev: unknown): string {
  return `${JSON.stringify(ev)}\n`;
}

async function writeSession(events: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "h2-session-"));
  const path = join(dir, "s.jsonl");
  await writeFile(path, events.map(line).join(""));
  return path;
}

const base = { seq: 1, ts: new Date().toISOString(), stream: "main" };

test("loads messages and ignores child streams", async () => {
  const path = await writeSession([
    { ...base, t: "session.start", id: "s1", cwd: "/tmp", model: "m", mode: "chat", version: "0" },
    { ...base, t: "user.message", text: "hello" },
    { ...base, t: "assistant.message", text: "hi", thinking: "", toolCalls: [] },
    { ...base, stream: "main.sub1", t: "user.message", text: "child task" },
    { ...base, stream: "main.sub1", t: "assistant.message", text: "child result", thinking: "", toolCalls: [] },
    { ...base, t: "assistant.message", text: "done", thinking: "", toolCalls: [] },
  ]);
  const loaded = await loadSession(path, LIMITS);
  assert.equal(loaded.messages.length, 3);
  assert.equal(loaded.messages[0].role, "user");
  assert.equal(loaded.lastAssistant, "done");
  assert.ok(!JSON.stringify(loaded.messages).includes("child"));
});

test("repairs a dangling tool call from an interrupted run", async () => {
  const path = await writeSession([
    { ...base, t: "session.start", id: "s1", cwd: "/tmp", model: "m", mode: "chat", version: "0" },
    { ...base, t: "user.message", text: "do it" },
    {
      ...base,
      t: "assistant.message",
      text: "",
      thinking: "",
      toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }],
    },
  ]);
  const loaded = await loadSession(path, LIMITS);
  assert.equal(loaded.messages.length, 3);
  const repaired = loaded.messages[2];
  assert.equal(repaired.role, "tool");
  if (repaired.role === "tool") {
    assert.equal(repaired.ok, false);
    assert.match(repaired.content, /interrupted/);
  }
});

test("applies loop specs, stages, notes, todos, and compaction on load", async () => {
  const spec = normalizeSpec(
    { name: "loaded", stages: [{ id: "a", goal: "" }, { id: "b", goal: "" }] },
    LIMITS,
    defaultSpec(LIMITS),
  );
  const path = await writeSession([
    { ...base, t: "session.start", id: "s1", cwd: "/tmp", model: "m", mode: "chat", version: "0" },
    { ...base, t: "user.message", text: "one" },
    { ...base, t: "assistant.message", text: "two", thinking: "", toolCalls: [] },
    { ...base, t: "user.message", text: "three" },
    { ...base, t: "assistant.message", text: "four", thinking: "", toolCalls: [] },
    { ...base, t: "user.message", text: "five" },
    { ...base, t: "assistant.message", text: "six", thinking: "", toolCalls: [] },
    { ...base, t: "loop.spec", spec, by: "user", reason: "test" },
    { ...base, t: "loop.stage", id: "b", index: 1, total: 2, step: 3 },
    { ...base, t: "loop.note", text: "remember this" },
    { ...base, t: "todo", items: [{ text: "do it", done: false }] },
    { ...base, t: "compaction", beforeMessages: 6, afterMessages: 3, beforeTokens: 100, afterTokens: 20, summary: "summary!" },
    { ...base, t: "user.message", text: "after compaction" },
  ]);
  const loaded = await loadSession(path, LIMITS);
  assert.equal(loaded.spec.name, "loaded");
  assert.equal(loaded.stageIndex, 1);
  assert.deepEqual(loaded.notes, ["remember this"]);
  assert.deepEqual(loaded.todos, [{ text: "do it", done: false }]);
  assert.equal(loaded.messages.length, 4);
  assert.equal(loaded.messages[0].role, "user");
  assert.match(String(loaded.messages[0].content), /summary!/);
  assert.equal(loaded.messages[3].role, "user");
  assert.match(String(loaded.messages[3].content), /after compaction/);
  assert.equal(loaded.contextTokens, 20);
  assert.equal(loaded.contextReported, false);
});

test("usage accumulates across events", async () => {
  const path = await writeSession([
    { ...base, t: "session.start", id: "s1", cwd: "/tmp", model: "m", mode: "chat", version: "0" },
    { ...base, t: "usage", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, elapsedMs: 1, step: 1 },
    { ...base, t: "usage", usage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 }, elapsedMs: 1, step: 2 },
  ]);
  const loaded = await loadSession(path, LIMITS);
  assert.equal(loaded.usage.promptTokens, 30);
  assert.equal(loaded.usage.completionTokens, 12);
  assert.equal(loaded.contextTokens, 20);
  assert.equal(loaded.contextReported, true);
});

test("legacy project sessions and history move into the central home", async () => {
  const previous = process.env.HARNESS2_HOME;
  const home = await mkdtemp(join(tmpdir(), "h2-session-home-"));
  process.env.HARNESS2_HOME = home;
  try {
    const cwd = await mkdtemp(join(tmpdir(), "h2-session-project-"));
    const legacySessions = join(cwd, ".harness2", "sessions");
    await mkdir(legacySessions, { recursive: true });
    await writeFile(join(legacySessions, "s.jsonl"), line({ t: "user.message", text: "old" }));
    await writeFile(join(cwd, ".harness2", "history.jsonl"), `${JSON.stringify("old prompt")}\n`);
    const target = join(home, "sessions");
    await migrateProjectState(cwd, target, true);
    assert.equal(await readFile(join(target, "s.jsonl"), "utf8"), line({ t: "user.message", text: "old" }));
    assert.match(await readFile(historyPath(), "utf8"), /old prompt/);
    await assert.rejects(stat(join(cwd, ".harness2")));
  } finally {
    if (previous === undefined) delete process.env.HARNESS2_HOME;
    else process.env.HARNESS2_HOME = previous;
  }
});
