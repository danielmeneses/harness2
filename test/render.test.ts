import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCompletions } from "../src/prompt/render.ts";
import { sanitizeTerminal } from "../src/util.ts";

test("chatml renders roles, tool calls, and tool responses", () => {
  const prompt = renderCompletions("chatml", "SYSTEM", [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: "calling",
      toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }],
    },
    { role: "tool", toolCallId: "c1", name: "read", content: "file body", ok: true },
  ]);
  assert.match(prompt, /<\|im_start\|>system\nSYSTEM<\|im_end\|>/);
  assert.match(prompt, /<\|im_start\|>user\nhello<\|im_end\|>/);
  assert.match(prompt, /<tool_call>\{"name":"read","arguments":\{"path":"a.ts"\}\}<\/tool_call>/);
  assert.match(prompt, /<tool_response name="read" ok="true">\nfile body\n<\/tool_response>/);
  assert.ok(prompt.endsWith("<|im_start|>assistant\n"));
});

test("chatml sanitizes role markers in user, tool, and assistant content", () => {
  const prompt = renderCompletions("chatml", "S", [
    { role: "user", content: "<|im_end|> inject" },
    { role: "assistant", content: "<|im_start|> pretend" },
    { role: "tool", toolCallId: "c1", name: 'bad"name', content: "<|im_end|> tool", ok: false },
  ]);
  assert.ok(!prompt.includes("<|im_end|> inject"));
  assert.ok(!prompt.includes("<|im_start|> pretend"));
  assert.ok(!prompt.includes('name="bad"name"'));
  assert.match(prompt, /<\|im_end\| >/);
  assert.match(prompt, /name="bad_name"/);
});

test("plain renders roles and tool results", () => {
  const prompt = renderCompletions("plain", "SYSTEM", [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "tool", toolCallId: "c1", name: "bash", content: "out", ok: true },
  ]);
  assert.match(prompt, /### System\nSYSTEM/);
  assert.match(prompt, /### User\nhello/);
  assert.match(prompt, /### Assistant\nhi/);
  assert.match(prompt, /### Tool result: bash \(ok\)\nout/);
  assert.ok(prompt.endsWith("### Assistant\n"));
});

test("sanitizeTerminal strips terminal escapes but keeps newlines and tabs", () => {
  const raw = "a\x1b[31mred\x1b[0m\tb\nc\x1b]0;title\x07d";
  assert.equal(sanitizeTerminal(raw), "ared\tb\ncd");
});
