import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config.ts";
import { EventBus, type Event } from "../src/events.ts";
import { Approvals, type ApprovalRequest } from "../src/safety/approvals.ts";
import { PathGuard } from "../src/safety/paths.ts";
import { RunBudget } from "../src/loop/budget.ts";
import { commitMutations } from "../src/tools/loop.ts";
import { newConversation } from "../src/loop/state.ts";
import { defaultSpec, normalizeSpec } from "../src/loop/spec.ts";
import { TOOL_MAP } from "../src/tools/index.ts";
import type { ToolContext } from "../src/tools/types.ts";

process.env.HARNESS2_HOME = await mkdtemp(join(tmpdir(), "h2-trust-xdg-"));

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "h2-trust-"));
  const outside = await mkdtemp(join(tmpdir(), "h2-trust-out-"));
  const cfg = defaultConfig(cwd);
  const bus = new EventBus();
  const events: Event[] = [];
  bus.subscribe((ev) => events.push(ev));
  const approvals = new Approvals(cfg, bus.emit);
  await approvals.init();
  const guard = new PathGuard(cfg, approvals);
  const conv = newConversation("main", "main", 0, defaultSpec({ maxStepsCap: 10, contextWindow: 32768 }), new RunBudget(cfg));
  const ctx: ToolContext = { cfg, guard, approvals, conv, signal: new AbortController().signal, emit: bus.emit };
  return { cwd, outside, cfg, bus, events, approvals, guard, conv, ctx };
}

test("grants are scoped to the requesting conversation stream", async () => {
  const s = await setup();
  const seen: string[] = [];
  s.approvals.setHandler(async () => {
    seen.push("asked");
    return { decision: "session" };
  });
  await s.approvals.request({ kind: "read", title: "read", key: "read:/x", stream: "main" });
  // A child conversation must not inherit the parent's session grant.
  await s.approvals.request({ kind: "read", title: "read", key: "read:/x", stream: "main.sub1" });
  assert.equal(seen.length, 2);
  assert.ok(s.events.some((e) => e.t === "approval.request" && e.stream === "main.sub1"));
});

test("a symlink swapped after approval cannot retarget a write", async () => {
  const s = await setup();
  const outsideFile = join(s.outside, "secret.txt");
  await writeFile(outsideFile, "original");
  const link = join(s.cwd, "link.txt");
  await symlink(join(s.cwd, "inside.txt"), link);
  await writeFile(join(s.cwd, "inside.txt"), "inside");
  s.approvals.setHandler(async () => ({ decision: "deny", reason: "outside" }));
  // Initially inside, so no prompt, and a normal write succeeds.
  const first = await TOOL_MAP.get("write")!.execute({ path: "link.txt", content: "one" }, s.ctx, "c1");
  assert.equal(first.ok, true);
  // Swap the link to an outside target; the guard must re-resolve and deny.
  const { unlink } = await import("node:fs/promises");
  await unlink(link);
  await symlink(outsideFile, link);
  const second = await TOOL_MAP.get("write")!.execute({ path: "link.txt", content: "two" }, s.ctx, "c2");
  assert.equal(second.ok, false);
  assert.equal(await readFile(outsideFile, "utf8"), "original");
});

test("cross-origin redirects require a fresh approval", async () => {
  const s = await setup();
  const requests: string[] = [];
  const target = createServer((req, res) => {
    requests.push(`target:${req.url}`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("target secret");
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetPort = (target.address() as { port: number }).port;
  const origin = createServer((req, res) => {
    requests.push(`origin:${req.url}`);
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/steal` });
    res.end();
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as { port: number }).port;
  try {
    const asked: ApprovalRequest[] = [];
    s.approvals.setHandler(async (req) => {
      asked.push(req);
      // The initial origin is allowed; the redirect to a different origin is not.
      return req.title.includes("redirect")
        ? { decision: "deny", reason: "no redirect" }
        : { decision: "once" };
    });
    const r = await TOOL_MAP.get("fetch")!.execute({ url: `http://127.0.0.1:${originPort}/start` }, s.ctx, "c1");
    assert.equal(r.ok, false);
    assert.match(r.output, /DENIED/);
    assert.equal(asked.length, 2, "origin and cross-origin redirect are approved separately");
    assert.ok(!requests.some((r) => r.startsWith("target:")));
  } finally {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("loop mutations commit in order and preserve the current stage by id", async () => {
  const s = await setup();
  s.conv.spec = normalizeSpec(
    { stages: [{ id: "a", goal: "" }, { id: "b", goal: "" }, { id: "c", goal: "" }], startStage: "b" },
    { maxStepsCap: 10, contextWindow: 4096 },
  );
  s.conv.stageIndex = 1;
  const spec = normalizeSpec(
    { stages: [{ id: "b", goal: "renamed b" }, { id: "d", goal: "" }] },
    { maxStepsCap: 10, contextWindow: 4096 },
  );
  s.conv.pendingMutations.push({ kind: "spec", spec, reason: "rewrite", by: "model", expectedVersion: 0 });
  s.conv.pendingMutations.push({ kind: "stage", stage: "d", expectedVersion: 0 });
  const committed = commitMutations(s.conv);
  assert.equal(committed.spec?.stages[0].id, "b");
  assert.equal(committed.stage, "d");
  assert.equal(s.conv.stageIndex, 1);
  assert.equal(s.conv.specVersion, 1);
  assert.equal(s.conv.pendingMutations.length, 0);
});

test("a stale mutation is rejected instead of applying partially", async () => {
  const s = await setup();
  const spec = normalizeSpec({ stages: [{ id: "x", goal: "" }] }, { maxStepsCap: 10, contextWindow: 4096 });
  s.conv.pendingMutations.push({ kind: "spec", spec, reason: "rewrite", by: "model", expectedVersion: 0 });
  s.conv.pendingMutations.push({ kind: "stage", stage: "x", expectedVersion: 3 });
  const before = s.conv.spec;
  const committed = commitMutations(s.conv);
  assert.match(committed.conflict ?? "", /loop changed/);
  assert.equal(s.conv.spec, before);
  assert.equal(s.conv.specVersion, 0);
});

test("a shared token budget stops every conversation in the tree", async () => {
  const s = await setup();
  s.cfg.provider.totalTokenBudget = 100;
  const budget = new RunBudget(s.cfg);
  budget.recordTurn(60, 10);
  assert.equal(budget.blocked, false);
  budget.recordTurn(60, 10);
  assert.equal(budget.blocked, true);
  assert.match(budget.reason, /token budget/);
  const child = newConversation("main.sub1", "sub1", 1, s.conv.spec, budget);
  assert.equal(child.budget, budget);
});

test("child agents consume the same child allowance", () => {
  const cfg = defaultConfig("/tmp");
  cfg.loop.maxChildAgents = 1;
  const budget = new RunBudget(cfg);
  assert.equal(budget.reserveChild(), true);
  assert.equal(budget.reserveChild(), false);
  assert.match(budget.reason, /child-agent budget/);
});

test("loop_ask approval events are attributed to the asking conversation", async () => {
  const s = await setup();
  s.approvals.setHandler(async () => ({ decision: "once", reason: "yes" }));
  s.conv.id = "main.sub7";
  const answer = await TOOL_MAP.get("loop_ask")!.execute({ question: "continue?" }, s.ctx, "c1");
  assert.equal(answer.ok, true);
  assert.match(answer.output, /yes/);
  const req = s.events.find((e) => e.t === "approval.request");
  const res = s.events.find((e) => e.t === "approval.result");
  assert.ok(req && req.t === "approval.request");
  assert.ok(res && res.t === "approval.result");
  assert.equal(req.stream, "main.sub7");
  assert.equal(res.stream, "main.sub7");
});

test("predicate commands obey the stage tool policy and are recorded", async () => {
  const s = await setup();
  const turns = [
    { text: "checking", thinking: "", toolCalls: [] },
    { text: "still checking", thinking: "", toolCalls: [] },
  ];
  const provider = {
    mode: "chat" as const,
    async stream() {
      const next = turns.shift();
      if (!next) throw new Error("provider exhausted");
      return next;
    },
  };
  const { Runner } = await import("../src/loop/kernel.ts");
  const runner = new Runner({ cfg: s.cfg, provider, approvals: s.approvals, guard: s.guard, emit: s.bus.emit, agentsMd: "" });
  const conv = runner.createConversation();
  conv.spec = normalizeSpec(
    {
      maxSteps: 2,
      stages: [{ id: "work", goal: "", tools: ["read"] }],
      finish: { all: [{ modelStopped: true }, { command: "touch predicate-ran.txt", expectExit: 0 }] },
    },
    { maxStepsCap: 10, contextWindow: 4096 },
  );
  const result = await runner.run(conv, "verify");
  assert.equal(result.reason, "max_steps");
  await assert.rejects(readFile(join(s.cwd, "predicate-ran.txt"), "utf8"));
  const called = s.events.find((e) => e.t === "tool.call" && e.args.predicate === true);
  const resultEv = s.events.find((e) => e.t === "tool.result" && e.name === "bash" && e.meta?.predicate === true);
  assert.ok(called, "predicate command should emit a tool.call");
  assert.ok(resultEv && resultEv.t === "tool.result");
  assert.equal(resultEv.ok, false);
  assert.match(resultEv.output, /not allowed/);
});
