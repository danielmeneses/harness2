import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config.ts";
import { ChatProvider } from "../src/provider/chat.ts";
import { CompletionsProvider } from "../src/provider/completions.ts";
import { AutoProvider } from "../src/provider/index.ts";
import { startMock } from "./mock-server.ts";

async function cfgFor(url: string) {
  const cwd = await mkdtemp(join(tmpdir(), "h2-provider-"));
  const cfg = defaultConfig(cwd);
  cfg.provider.baseUrl = `${url}/v1`;
  cfg.provider.model = "mock";
  cfg.provider.retries = 0;
  cfg.provider.timeoutMs = 5000;
  cfg.provider.temperature = 0;
  return cfg;
}

test("chat streaming parses thinking, text, tool calls, and usage", async () => {
  const mock = await startMock([
    {
      thinking: "let me think",
      text: "hello",
      toolCalls: [{ name: "read", args: { path: "a.ts" } }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    },
  ]);
  try {
    const cfg = await cfgFor(mock.url);
    const provider = new ChatProvider(cfg);
    const thinking: string[] = [];
    const text: string[] = [];
    const result = await provider.stream({
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      reasoningEffort: "medium",
      onText: (t) => text.push(t),
      onThinking: (t) => thinking.push(t),
    });
    assert.equal(result.text, "hello");
    assert.equal(result.thinking, "let me think");
    assert.equal(thinking.join(""), "let me think");
    assert.equal(text.join(""), "hello");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "read");
    assert.deepEqual(result.toolCalls[0].args, { path: "a.ts" });
    assert.equal(result.usage?.promptTokens, 12);
    assert.equal(mock.requests[0].path, "/v1/chat/completions");
    const body = mock.requests[0].body;
    assert.equal((body.messages as Array<{ role: string }>)[0].role, "system");
    assert.equal(body.reasoning_effort, "medium");
    assert.ok(body.stream_options);
  } finally {
    await mock.close();
  }
});

test("completions streaming parses tags split across chunks", async () => {
  const mock = await startMock([
    {
      thinking: "quietly",
      text: "answer",
      toolCalls: [{ name: "write", args: { path: "x.txt", content: "hi" } }],
    },
  ]);
  try {
    const cfg = await cfgFor(mock.url);
    const provider = new CompletionsProvider(cfg);
    const result = await provider.stream({
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    assert.equal(result.text, "answer");
    assert.equal(result.thinking, "quietly");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "write");
    assert.deepEqual(result.toolCalls[0].args, { path: "x.txt", content: "hi" });
    assert.equal(mock.requests[0].path, "/v1/completions");
    assert.ok(mock.requests[0].body.stream_options);
    assert.match(String(mock.requests[0].body.prompt), /<\|im_start\|>system/);
  } finally {
    await mock.close();
  }
});

test("auto falls back to completions when chat is missing", async () => {
  const mock = await startMock([
    { errorStatus: 404, errorBody: '{"error":{"message":"chat not found"}}' },
    { text: "fallback answer" },
  ]);
  try {
    const cfg = await cfgFor(mock.url);
    cfg.provider.mode = "auto";
    const provider = new AutoProvider(cfg);
    const notices: string[] = [];
    const result = await provider.stream({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onNotice: (m) => notices.push(m),
    });
    assert.equal(result.text, "fallback answer");
    assert.equal(provider.mode, "completions");
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[0].path, "/v1/chat/completions");
    assert.equal(mock.requests[1].path, "/v1/completions");
    assert.ok(notices.some((n) => /falling back/.test(n)));
  } finally {
    await mock.close();
  }
});

test("auto does not fall back after producing output", async () => {
  const mock = await startMock([{ text: "chat works" }]);
  try {
    const cfg = await cfgFor(mock.url);
    cfg.provider.mode = "auto";
    const provider = new AutoProvider(cfg);
    const result = await provider.stream({
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    });
    assert.equal(result.text, "chat works");
    assert.equal(provider.mode, "chat");
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});
