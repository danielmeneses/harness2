import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { defaultConfig } from "../src/config.ts";
import { ResponsesProvider } from "../src/provider/responses.ts";

test("responses streaming parses reasoning, text, tool calls, and usage", async () => {
  let request: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      request = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (obj: unknown): void => void res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ type: "response.reasoning_summary_text.delta", delta: "thinking" });
      send({ type: "response.output_text.delta", delta: "hello" });
      send({
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
      });
      send({
        type: "response.completed",
        response: { usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const cfg = defaultConfig(process.cwd());
    cfg.provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    cfg.provider.mode = "responses";
    cfg.provider.model = "gpt-test";
    const text: string[] = [];
    const thinking: string[] = [];
    const provider = new ResponsesProvider(cfg);
    const result = await provider.stream({
      system: "system prompt",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "earlier" },
        { role: "tool", toolCallId: "old", name: "ls", content: "ok", ok: true },
      ],
      tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
      reasoningEffort: "high",
      onText: (chunk) => text.push(chunk),
      onThinking: (chunk) => thinking.push(chunk),
    });
    assert.equal(result.text, "hello");
    assert.equal(result.thinking, "thinking");
    assert.deepEqual(text, ["hello"]);
    assert.deepEqual(thinking, ["thinking"]);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "read");
    assert.deepEqual(result.toolCalls[0].args, { path: "a.txt" });
    assert.equal(result.usage?.promptTokens, 12);
    assert.equal(result.usage?.completionTokens, 7);
    assert.equal(request.model, "gpt-test");
    assert.equal(request.instructions, "system prompt");
    assert.ok(Array.isArray(request.input));
    assert.ok(Array.isArray(request.tools));
    assert.deepEqual(request.reasoning, { effort: "high", summary: "auto" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("responses emits thinking from a final reasoning item when there are no summary deltas", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (obj: unknown): void => void res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        type: "response.output_item.done",
        item: { type: "reasoning", summary: [{ type: "summary_text", text: "considered the problem" }] },
      });
      send({ type: "response.output_text.delta", delta: "answer" });
      send({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2 } } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const cfg = defaultConfig(process.cwd());
    cfg.provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    cfg.provider.mode = "responses";
    const result = await new ResponsesProvider(cfg).stream({
      system: "s",
      messages: [{ role: "user", content: "q" }],
      tools: [],
    });
    assert.equal(result.thinking, "considered the problem");
    assert.equal(result.text, "answer");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("responses reports an incomplete max-output response as length", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (obj: unknown): void => void res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({ type: "response.output_text.delta", delta: "partial" });
      send({
        type: "response.incomplete",
        response: {
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 5, output_tokens: 9, total_tokens: 14 },
        },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const cfg = defaultConfig(process.cwd());
    cfg.provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    cfg.provider.mode = "responses";
    const result = await new ResponsesProvider(cfg).stream({
      system: "s",
      messages: [{ role: "user", content: "q" }],
      tools: [],
    });
    assert.equal(result.text, "partial");
    assert.equal(result.finishReason, "length");
    assert.equal(result.usage?.completionTokens, 9);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
