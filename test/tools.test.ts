import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { defaultConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { Approvals } from "../src/safety/approvals.ts";
import { PathGuard } from "../src/safety/paths.ts";
import { newConversation } from "../src/loop/state.ts";
import { RunBudget } from "../src/loop/budget.ts";
import { defaultSpec } from "../src/loop/spec.ts";
import { TOOL_MAP } from "../src/tools/index.ts";
import type { ToolContext } from "../src/tools/types.ts";

process.env.HARNESS2_HOME = await mkdtemp(join(tmpdir(), "h2-tools-xdg-"));

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "h2-tools-"));
  const outside = await mkdtemp(join(tmpdir(), "h2-tools-out-"));
  const cfg = defaultConfig(cwd);
  cfg.safety.approvals = "on";
  const bus = new EventBus();
  const approvals = new Approvals(cfg, bus.emit);
  await approvals.init();
  const guard = new PathGuard(cfg, approvals);
  const conv = newConversation("test", "test", 0, defaultSpec({ maxStepsCap: 10, contextWindow: 32768 }), new RunBudget(cfg));
  const ctx: ToolContext = {
    cfg,
    guard,
    approvals,
    conv,
    signal: new AbortController().signal,
    emit: bus.emit,
  };
  return { cwd, outside, cfg, conv, ctx, bus };
}

function tool(name: string) {
  const t = TOOL_MAP.get(name);
  assert.ok(t, `missing tool ${name}`);
  return t;
}

test("write, read, and edit work inside the cwd", async () => {
  const s = await setup();
  const w = await tool("write").execute({ path: "a.ts", content: "hello\nworld\n" }, s.ctx, "c1");
  assert.equal(w.ok, true);
  assert.equal(await readFile(join(s.cwd, "a.ts"), "utf8"), "hello\nworld\n");
  assert.match(String(w.meta?.diff), /\+hello/);

  const r = await tool("read").execute({ path: "a.ts" }, s.ctx, "c2");
  assert.equal(r.ok, true);
  assert.match(r.output, /1\| hello/);
  assert.match(r.output, /2\| world/);

  const e = await tool("edit").execute(
    { path: "a.ts", edits: [{ oldText: "world", newText: "there" }] },
    s.ctx,
    "c3",
  );
  assert.equal(e.ok, true);
  assert.match(String(e.meta?.diff), /-world/);
  assert.equal(await readFile(join(s.cwd, "a.ts"), "utf8"), "hello\nthere\n");

  const amb = await tool("edit").execute(
    { path: "a.ts", edits: [{ oldText: "l", newText: "L" }] },
    s.ctx,
    "c4",
  );
  assert.equal(amb.ok, false);
  assert.match(amb.output, /matches/);
});

test("glob and grep find files", async () => {
  const s = await setup();
  await writeFile(join(s.cwd, "a.ts"), "hello\nneedle\n");
  await writeFile(join(s.cwd, "b.txt"), "needle elsewhere\n");
  const g = await tool("glob").execute({ pattern: "**/*.ts" }, s.ctx, "c1");
  assert.equal(g.ok, true);
  assert.match(g.output, /a\.ts/);
  assert.ok(!g.output.includes("b.txt"));

  const gr = await tool("grep").execute({ pattern: "needle" }, s.ctx, "c2");
  assert.equal(gr.ok, true);
  assert.match(gr.output, /a\.ts:2:/);
  assert.match(gr.output, /b\.txt:1:/);
});

test("bash runs a command and reports the exit code", async () => {
  const s = await setup();
  const ok = await tool("bash").execute({ command: "printf 'hi\\n'" }, s.ctx, "c1");
  assert.equal(ok.ok, true);
  assert.match(ok.output, /hi/);
  assert.equal(ok.meta?.exitCode, 0);

  const bad = await tool("bash").execute({ command: "echo oops >&2; exit 3" }, s.ctx, "c2");
  assert.equal(bad.ok, false);
  assert.equal(bad.meta?.exitCode, 3);
  assert.match(bad.output, /oops/);
  assert.match(bad.output, /exit code 3/);
});

test("bash outside-file access is denied without a handler", async () => {
  const s = await setup();
  const secret = join(s.outside, "secret.txt");
  await writeFile(secret, "secret");
  const r = await tool("bash").execute({ command: `cat ${secret}` }, s.ctx, "c1");
  assert.equal(r.ok, false);
  assert.match(r.output, /^DENIED:/);
  assert.ok(!r.output.includes("secret"));
});

test("todo updates the shared list", async () => {
  const s = await setup();
  const set = await tool("todo").execute({ action: "set", items: ["one", "two"] }, s.ctx, "c1");
  assert.equal(set.ok, true);
  assert.match(set.output, /1\. \[ \] one/);
  const done = await tool("todo").execute({ action: "done", index: 1 }, s.ctx, "c2");
  assert.match(done.output, /1\. \[x\] one/);
  assert.equal(s.conv.todos[0].done, true);
});

test("loop_set validates and stashes a pending spec", async () => {
  const s = await setup();
  const r = await tool("loop_set").execute(
    { reason: "test", spec: { name: "mine", stages: [{ id: "one", goal: "g" }] } },
    s.ctx,
    "c1",
  );
  assert.equal(r.ok, true);
  assert.equal(s.conv.pendingMutations.length, 1);
  const staged = s.conv.pendingMutations[0];
  assert.equal(staged.kind, "spec");
  if (staged.kind === "spec") {
    assert.equal(staged.spec.name, "mine");
    assert.equal(staged.spec.stages[0].id, "one");
  }
  const inspect = await tool("loop_inspect").execute({}, s.ctx, "c2");
  assert.match(inspect.output, /pendingMutations/);

  const bad = await tool("loop_set").execute({ spec: { stages: [] } }, s.ctx, "c3");
  assert.equal(bad.ok, false);
  assert.match(bad.output, /invalid loop spec/);
});


const hasBwrap = spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;

test("the bash sandbox blocks writes outside the cwd", { skip: !hasBwrap }, async () => {
  const s = await setup();
  s.cfg.safety.bashSandbox = true;
  s.cfg.safety.sandboxNetwork = false;
  const ok = await tool("bash").execute({ command: "echo hi" }, s.ctx, "c1");
  assert.equal(ok.ok, true);
  assert.match(ok.output, /hi/);
  const target = join(s.outside, "nope.txt");
  const bad = await tool("bash").execute({ command: `echo x > ${target}` }, s.ctx, "c2");
  assert.equal(bad.ok, false);
  assert.match(bad.output, /Read-only|Permission denied|not permitted|No such file/i);
  assert.equal(bad.meta?.sandbox, true);
  await assert.rejects(readFile(target, "utf8"));
});


test("bash timeout kills the command", async () => {
  const s = await setup();
  const r = await tool("bash").execute({ command: "sleep 3", timeoutMs: 1000 }, s.ctx, "c1");
  assert.equal(r.ok, false);
  assert.equal(r.meta?.timedOut, true);
  assert.match(r.output, /timed out/);
});
