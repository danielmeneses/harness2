import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config.ts";
import { EventBus, type Event } from "../src/events.ts";
import { Approvals } from "../src/safety/approvals.ts";
import { PathGuard } from "../src/safety/paths.ts";
import { Runner } from "../src/loop/kernel.ts";
import { defaultSpec, normalizeSpec } from "../src/loop/spec.ts";
import type { Provider, ProviderRequest, TurnResult } from "../src/types.ts";

process.env.HARNESS2_HOME = await mkdtemp(join(tmpdir(), "h2-kernel-xdg-"));

class FakeProvider implements Provider {
  readonly mode = "chat" as const;
  turns: TurnResult[];
  requests: ProviderRequest[] = [];

  constructor(turns: TurnResult[]) {
    this.turns = turns;
  }

  async stream(req: ProviderRequest): Promise<TurnResult> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const turn = this.turns.shift();
    if (!turn) throw new Error("fake provider exhausted");
    if (turn.text) req.onText?.(turn.text);
    if (turn.thinking) req.onThinking?.(turn.thinking);
    return turn;
  }
}

function turn(partial: Partial<TurnResult> = {}): TurnResult {
  return { text: "", thinking: "", toolCalls: [], ...partial };
}

async function setup(turns: TurnResult[]) {
  const cwd = await mkdtemp(join(tmpdir(), "h2-kernel-"));
  const outside = await mkdtemp(join(tmpdir(), "h2-kernel-out-"));
  const cfg = defaultConfig(cwd);
  cfg.session.enabled = false;
  cfg.provider.mode = "chat";
  cfg.loop.maxStepsCap = 10;
  cfg.loop.defaultMaxSteps = 10;
  const bus = new EventBus();
  const events: Event[] = [];
  bus.subscribe((ev) => events.push(ev));
  const approvals = new Approvals(cfg, bus.emit);
  await approvals.init();
  const guard = new PathGuard(cfg, approvals);
  const provider = new FakeProvider(turns);
  const runner = new Runner({ cfg, provider, approvals, guard, emit: bus.emit, agentsMd: "" });
  const conv = runner.createConversation();
  return { cwd, outside, cfg, bus, events, approvals, guard, provider, runner, conv };
}

function limits(cfg: ReturnType<typeof defaultConfig>) {
  return { maxStepsCap: cfg.loop.maxStepsCap, contextWindow: cfg.provider.contextWindow };
}

function lastState(req: ProviderRequest): string {
  const m = [...req.messages].reverse().find((x) => x.role === "user" && x.content.startsWith("[harness loop state]"));
  assert.ok(m && m.role === "user", "missing harness state message");
  return m.content;
}

test("a plain final answer completes the run", async () => {
  const s = await setup([turn({ text: "done" })]);
  const result = await s.runner.run(s.conv, "do it");
  assert.equal(result.reason, "completed");
  assert.equal(result.answer, "done");
  assert.equal(s.conv.messages.length, 3);
  assert.ok(s.conv.messages.some((m) => m.role === "user" && m.content.startsWith("[harness loop state]")));
  assert.ok(s.events.some((e) => e.t === "done" && e.stream === "main"));
  assert.equal(s.conv.contextReported, false);
  assert.ok(s.conv.contextTokens > 0);
});

test("a truncated turn is retried instead of completing the run", async () => {
  const s = await setup([
    turn({ thinking: "long reasoning", finishReason: "length" }),
    turn({ text: "done" }),
  ]);
  const result = await s.runner.run(s.conv, "do it");
  assert.equal(result.reason, "completed");
  assert.equal(result.answer, "done");
  assert.equal(s.provider.requests.length, 2);
  assert.ok(s.events.some((e) => e.t === "notice" && /output limit/.test(e.message)));
  assert.ok(s.events.some((e) => e.t === "loop.nudge" && /cut off/.test(e.text)));
});

test("tool calls from a truncated turn are not executed", async () => {
  const s = await setup([
    turn({
      toolCalls: [{ id: "c1", name: "write", args: { path: "cut.txt", content: "partial" } }],
      finishReason: "length",
    }),
    turn({ text: "done" }),
  ]);
  const result = await s.runner.run(s.conv, "write it");
  assert.equal(result.reason, "completed");
  await assert.rejects(readFile(join(s.cwd, "cut.txt"), "utf8"));
  const firstAssistant = s.conv.messages.find((m) => m.role === "assistant");
  assert.ok(firstAssistant && firstAssistant.role === "assistant");
  assert.equal(firstAssistant.toolCalls, undefined);
});

test("an empty turn is retried instead of silently completing", async () => {
  const s = await setup([turn({ thinking: "thought only" }), turn({ text: "done" })]);
  const result = await s.runner.run(s.conv, "do it");
  assert.equal(result.reason, "completed");
  assert.equal(result.answer, "done");
  assert.equal(s.provider.requests.length, 2);
  assert.ok(s.events.some((e) => e.t === "notice" && /no text and no tool calls/.test(e.message)));
});

test("repeated truncated turns stop with a clear error", async () => {
  const s = await setup([
    turn({ finishReason: "length" }),
    turn({ finishReason: "length" }),
    turn({ finishReason: "length" }),
  ]);
  const result = await s.runner.run(s.conv, "do it");
  assert.equal(result.reason, "error");
  assert.match(result.error ?? "", /--max-tokens/);
  assert.ok(s.events.some((e) => e.t === "done" && e.reason === "error"));
});

test("a tool call is executed and its result is sent back", async () => {
  const s = await setup([
    turn({ toolCalls: [{ id: "c1", name: "write", args: { path: "out.txt", content: "hello" } }] }),
    turn({ text: "wrote it" }),
  ]);
  const result = await s.runner.run(s.conv, "write a file");
  assert.equal(result.reason, "completed");
  assert.equal(await readFile(join(s.cwd, "out.txt"), "utf8"), "hello");
  const toolMsg = s.provider.requests[1].messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  assert.equal(toolMsg.ok, true);
  assert.match(toolMsg.content, /Created|Overwrote/);
  assert.equal(s.conv.messages.filter((m) => m.role === "tool").length, 1);
});

test("loop_set rewrites the loop and applies after the batch", async () => {
  const s = await setup([
    turn({
      toolCalls: [
        {
          id: "c1",
          name: "loop_set",
          args: { reason: "test", spec: { name: "custom", stages: [{ id: "solo", goal: "only" }] } },
        },
      ],
    }),
    turn({ text: "done" }),
  ]);
  const result = await s.runner.run(s.conv, "change your loop");
  assert.equal(result.reason, "completed");
  assert.equal(s.conv.spec.name, "custom");
  assert.equal(s.conv.spec.stages.length, 1);
  assert.equal(s.conv.spec.stages[0].id, "solo");
  const state = lastState(s.provider.requests[1]);
  assert.match(state, /custom/);
  assert.match(state, /solo/);
  assert.equal(s.provider.requests[1].system, s.provider.requests[0].system);
  const ev = s.events.find((e) => e.t === "loop.spec");
  assert.ok(ev && ev.t === "loop.spec");
  assert.equal(ev.by, "model");
});

test("a failing finish predicate nudges the model and continues", async () => {
  const s = await setup([
    turn({ text: "not yet" }),
    turn({ toolCalls: [{ id: "c1", name: "write", args: { path: "done.txt", content: "ok" } }] }),
    turn({ text: "all done" }),
  ]);
  s.conv.spec = normalizeSpec(
    { maxSteps: 6, stages: [{ id: "work", goal: "" }], finish: { fileExists: "done.txt" } },
    limits(s.cfg),
    defaultSpec(limits(s.cfg)),
  );
  const result = await s.runner.run(s.conv, "finish only when the file exists");
  assert.equal(result.reason, "completed");
  assert.equal(result.answer, "all done");
  assert.equal(await readFile(join(s.cwd, "done.txt"), "utf8"), "ok");
  assert.ok(
    s.conv.messages.some(
      (m) => m.role === "user" && m.synthetic === true && m.content.includes("Finish condition is not met"),
    ),
  );
});

test("the step cap ends the run", async () => {
  const s = await setup([
    turn({ toolCalls: [{ id: "c1", name: "ls", args: { path: "." } }] }),
    turn({ toolCalls: [{ id: "c2", name: "ls", args: { path: "." } }] }),
  ]);
  s.conv.spec = normalizeSpec(
    { maxSteps: 2, stages: [{ id: "work", goal: "" }] },
    limits(s.cfg),
    defaultSpec(limits(s.cfg)),
  );
  const result = await s.runner.run(s.conv, "loop forever");
  assert.equal(result.reason, "max_steps");
  assert.ok(s.events.some((e) => e.t === "notice" && /step limit/.test(e.message)));
});

test("outside reads are denied without an interactive user", async () => {
  const outside = await mkdtemp(join(tmpdir(), "h2-out-"));
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "secret");
  const s = await setup([
    turn({ toolCalls: [{ id: "c1", name: "read", args: { path: secret } }] }),
    turn({ text: "understood" }),
  ]);
  const result = await s.runner.run(s.conv, "read the secret");
  assert.equal(result.reason, "completed");
  const toolMsg = s.provider.requests[1].messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  assert.equal(toolMsg.ok, false);
  assert.match(toolMsg.content, /^DENIED:/);
});

test("stage exit advances to the next stage", async () => {
  const s = await setup([
    turn({ toolCalls: [{ id: "c1", name: "todo", args: { action: "set", items: ["one"] } }] }),
    turn({ text: "planning done" }),
    turn({ text: "executed" }),
  ]);
  s.conv.spec = normalizeSpec(
    {
      maxSteps: 6,
      stages: [
        { id: "plan", goal: "plan", exitWhen: { toolCalled: "todo" } },
        { id: "execute", goal: "execute" },
      ],
    },
    limits(s.cfg),
    defaultSpec(limits(s.cfg)),
  );
  const result = await s.runner.run(s.conv, "plan then execute");
  assert.equal(result.reason, "completed");
  const stages = s.events.filter((e) => e.t === "loop.stage").map((e) => (e.t === "loop.stage" ? e.id : ""));
  assert.ok(stages.includes("plan"));
  assert.ok(stages.includes("execute"));
  assert.match(lastState(s.provider.requests[2]), /execute/);
});

test("loop_spawn runs a child conversation and returns its answer", async () => {
  const s = await setup([
    turn({ toolCalls: [{ id: "c1", name: "loop_spawn", args: { task: "child task", name: "kid" } }] }),
    turn({ text: "child answer" }),
    turn({ text: "parent answer" }),
  ]);
  const result = await s.runner.run(s.conv, "delegate");
  assert.equal(result.reason, "completed");
  assert.equal(result.answer, "parent answer");
  const toolMsg = s.provider.requests[2].messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  assert.match(toolMsg.content, /child answer/);
  assert.ok(s.events.some((e) => e.t === "loop.spawn" && e.stream === "main"));
  assert.ok(s.events.some((e) => e.t === "loop.spawn.result" && e.stream === "main"));
  assert.ok(s.events.some((e) => e.t === "done" && e.stream === "main.sub1"));
});

test("provider usage drives context tracking and auto-compacts near the limit", async () => {
  const s = await setup([
    turn({
      toolCalls: [{ id: "c1", name: "ls", args: { path: "." } }],
      usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 },
    }),
    turn({ text: "the summary", usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 } }),
    turn({ text: "finished", usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } }),
  ]);
  s.cfg.provider.contextWindow = 1024;
  s.cfg.loop.compactAtPct = 0.95;
  s.cfg.loop.keepRecentMessages = 2;
  const result = await s.runner.run(s.conv, "work");
  assert.equal(result.reason, "completed");
  assert.equal(s.provider.requests.length, 3);
  assert.match(s.provider.requests[1].system, /compress/);
  assert.ok(s.events.some((e) => e.t === "compaction"));
  assert.equal(s.conv.contextTokens, 100);
  assert.equal(s.conv.contextReported, true);
  const usage = s.events.find((e) => e.t === "usage" && e.stream === "main");
  assert.ok(usage && usage.t === "usage");
  assert.equal(usage.reported, true);
});

test("compaction replaces old history with a summary", async () => {
  const s = await setup([turn({ text: "the summary" })]);
  s.conv.messages = [
    { role: "user", content: "goal" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
  ];
  const msg = await s.runner.compact(s.conv, true, new AbortController().signal);
  assert.match(msg, /Compacted/);
  assert.ok(s.conv.messages.length < 6);
  assert.equal(s.conv.messages[0].role, "user");
  assert.match(String(s.conv.messages[0].content), /the summary/);
  assert.ok(s.events.some((e) => e.t === "compaction"));
});


test("the system prompt is stable and live state is appended per step", async () => {
  const s = await setup([
    turn({ toolCalls: [{ id: "c1", name: "ls", args: { path: "." } }] }),
    turn({ text: "done" }),
  ]);
  const result = await s.runner.run(s.conv, "check the cache");
  assert.equal(result.reason, "completed");
  assert.equal(s.provider.requests.length, 2);
  assert.equal(s.provider.requests[0].system, s.provider.requests[1].system);
  assert.ok(!s.provider.requests[0].system.includes("step 1/"));
  assert.match(lastState(s.provider.requests[0]), /^\[harness loop state\]\nstep 1\//);
  assert.match(lastState(s.provider.requests[1]), /^\[harness loop state\]\nstep 2\//);

  const first = s.provider.requests[0].messages;
  const second = s.provider.requests[1].messages;
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(s.provider.requests[0].tools.length, s.provider.requests[1].tools.length);
});
