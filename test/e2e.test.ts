import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startMock, type MockServer } from "./mock-server.ts";

const execFileAsync = promisify(execFile);
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

type CliResult = { code: number; stdout: string; stderr: string; events: Array<Record<string, unknown>> };

async function runCli(cwd: string, xdg: string, config: string, args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [MAIN, "--config", config, "--no-session", ...args], {
      cwd,
      env: { ...process.env, HARNESS2_HOME: xdg, NO_COLOR: "1", TERM: "dumb" },
      timeout: 20_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const events = stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { code: 0, stdout, stderr, events };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    const stdout = err.stdout ?? "";
    const events: Array<Record<string, unknown>> = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // keep going; the caller will see the raw stdout
      }
    }
    return { code: err.code ?? 1, stdout, stderr: err.stderr ?? err.message ?? "", events };
  }
}

async function fixture(turns: Parameters<typeof startMock>[0]) {
  const mock: MockServer = await startMock(turns);
  const cwd = await mkdtemp(join(tmpdir(), "h2-e2e-"));
  const xdg = await mkdtemp(join(tmpdir(), "h2-e2e-xdg-"));
  const config = join(cwd, "config.json");
  await writeFile(config, "{}\n");
  return { mock, cwd, xdg, config };
}

test("chat e2e: tool call writes a file, final answer is printed as events", async () => {
  const f = await fixture([
    { toolCalls: [{ name: "write", args: { path: "hello.txt", content: "hi" } }] },
    { text: "wrote hello.txt" },
  ]);
  try {
    const result = await runCli(f.cwd, f.xdg, f.config, [
      "-p",
      "--json",
      "--mode",
      "chat",
      "--base-url",
      f.mock.url,
      "--model",
      "mock",
      "write hello.txt with hi",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(f.cwd, "hello.txt"), "utf8"), "hi");
    const types = result.events.map((e) => e.t);
    assert.ok(types.includes("session.start"));
    assert.ok(types.includes("tool.call"));
    assert.ok(types.includes("tool.result"));
    const toolResult = result.events.find((e) => e.t === "tool.result");
    assert.equal(toolResult?.ok, true);
    const done = result.events.find((e) => e.t === "done");
    assert.equal(done?.reason, "completed");
    assert.equal(done?.answer, "wrote hello.txt");
    assert.equal(result.events.filter((e) => e.t === "done").length, 1);
    const messagesOf = (i: number): Array<{ role: string; content: string }> =>
      f.mock.requests[i].body.messages as Array<{ role: string; content: string }>;
    const system0 = messagesOf(0)[0].content;
    const system1 = messagesOf(1)[0].content;
    assert.equal(system0, system1);
    assert.match(messagesOf(1).at(-1)?.content ?? "", /^\[harness loop state\]/);
    assert.deepEqual(messagesOf(1).slice(0, messagesOf(0).length), messagesOf(0));
    assert.ok(
      !result.events.some(
        (e) => e.t === "notice" && /system prompt changed/.test(String(e.message ?? "")),
      ),
      "system prompt changed during a normal run",
    );
  } finally {
    await f.mock.close();
  }
});

test("completions e2e: thinking and tool tags are parsed from raw text", async () => {
  const f = await fixture([
    {
      thinking: "plan the write",
      text: "writing now",
      toolCalls: [{ name: "write", args: { path: "hello2.txt", content: "from completions" } }],
    },
    { text: "finished" },
  ]);
  try {
    const result = await runCli(f.cwd, f.xdg, f.config, [
      "-p",
      "--json",
      "--mode",
      "completions",
      "--base-url",
      f.mock.url,
      "--model",
      "mock",
      "write hello2.txt",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(f.cwd, "hello2.txt"), "utf8"), "from completions");
    const thinking = result.events
      .filter((e) => e.t === "assistant.thinking.delta")
      .map((e) => String(e.text))
      .join("");
    assert.equal(thinking, "plan the write");
    const done = result.events.find((e) => e.t === "done");
    assert.equal(done?.answer, "finished");
    const firstPrompt = String(f.mock.requests[0].body.prompt);
    const secondPrompt = String(f.mock.requests[1].body.prompt);
    assert.ok(secondPrompt.startsWith(firstPrompt), "second completions prompt must extend the first");
  } finally {
    await f.mock.close();
  }
});

test("e2e: reading outside the cwd is denied without approvals", async () => {
  const outside = await mkdtemp(join(tmpdir(), "h2-e2e-outside-"));
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "top secret");
  const f = await fixture([
    { toolCalls: [{ name: "read", args: { path: secret } }] },
    { text: "ok, staying inside" },
  ]);
  try {
    const result = await runCli(f.cwd, f.xdg, f.config, [
      "-p",
      "--json",
      "--mode",
      "chat",
      "--base-url",
      f.mock.url,
      "--model",
      "mock",
      "read the secret",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const toolResult = result.events.find((e) => e.t === "tool.result");
    assert.equal(toolResult?.ok, false);
    assert.match(String(toolResult?.output), /^DENIED:/);
    assert.ok(!result.stdout.includes("top secret"));
  } finally {
    await f.mock.close();
  }
});

test("e2e: --approve-all allows an outside read", async () => {
  const outside = await mkdtemp(join(tmpdir(), "h2-e2e-outside-"));
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "top secret");
  const f = await fixture([
    { toolCalls: [{ name: "read", args: { path: secret } }] },
    { text: "read it" },
  ]);
  try {
    const result = await runCli(f.cwd, f.xdg, f.config, [
      "-p",
      "--json",
      "--approve-all",
      "--mode",
      "chat",
      "--base-url",
      f.mock.url,
      "--model",
      "mock",
      "read the secret",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const toolResult = result.events.find((e) => e.t === "tool.result");
    assert.equal(toolResult?.ok, true);
    assert.match(String(toolResult?.output), /top secret/);
  } finally {
    await f.mock.close();
  }
});

test("e2e: bash runs inside the cwd", async () => {
  const f = await fixture([
    { toolCalls: [{ name: "bash", args: { command: "printf hi > bash.txt" } }] },
    { text: "bash done" },
  ]);
  try {
    const result = await runCli(f.cwd, f.xdg, f.config, [
      "-p",
      "--json",
      "--mode",
      "chat",
      "--base-url",
      f.mock.url,
      "--model",
      "mock",
      "run a command",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(f.cwd, "bash.txt"), "utf8"), "hi");
    const toolResult = result.events.find((e) => e.t === "tool.result");
    assert.equal(toolResult?.ok, true);
    assert.equal((toolResult?.meta as Record<string, unknown> | undefined)?.exitCode, 0);
  } finally {
    await f.mock.close();
  }
});

test("e2e: auto mode falls back to completions", async () => {
  const f = await fixture([
    { errorStatus: 404, errorBody: '{"error":{"message":"no chat endpoint"}}' },
    { text: "auto fallback answer" },
  ]);
  try {
    const result = await runCli(f.cwd, f.xdg, f.config, [
      "-p",
      "--json",
      "--mode",
      "auto",
      "--base-url",
      f.mock.url,
      "--model",
      "mock",
      "try chat first",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const done = result.events.find((e) => e.t === "done");
    assert.equal(done?.answer, "auto fallback answer");
    assert.ok(result.events.some((e) => e.t === "notice" && /falling back/.test(String(e.message))));
    assert.equal(f.mock.requests.length, 2);
    assert.ok(f.mock.requests[0].path.includes("/chat/completions"));
    assert.ok(f.mock.requests[1].path.includes("/completions"));
  } finally {
    await f.mock.close();
  }
});

test("chat e2e: a truncated turn is retried instead of completing", async () => {
  const f = await fixture([
    { thinking: "long reasoning", finishReason: "length" },
    { text: "finished after retry" },
  ]);
  try {
    const result = await runCli(f.cwd, f.xdg, f.config, [
      "-p",
      "--json",
      "--mode",
      "chat",
      "--base-url",
      f.mock.url,
      "--model",
      "mock",
      "do the task",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const done = result.events.find((e) => e.t === "done");
    assert.equal(done?.reason, "completed");
    assert.equal(done?.answer, "finished after retry");
    assert.ok(result.events.some((e) => e.t === "notice" && /output limit/.test(String(e.message))));
    assert.equal(f.mock.requests.length, 2);
  } finally {
    await f.mock.close();
  }
});
