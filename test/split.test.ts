import { test } from "node:test";
import assert from "node:assert/strict";
import { TagSplitter } from "../src/prompt/split.ts";

const TAGS: Array<[string, string]> = [
  ["<thinking>", "</thinking>"],
  [" thinking", " response"],
];

function collect(chunks: string[]): ReturnType<TagSplitter["feed"]> {
  const splitter = new TagSplitter(TAGS);
  const out: ReturnType<TagSplitter["feed"]> = [];
  for (const c of chunks) out.push(...splitter.feed(c));
  out.push(...splitter.flush());
  return out;
}

function joined(items: ReturnType<TagSplitter["feed"]>, kind: "text" | "thinking"): string {
  return items.filter((i) => i.kind === kind).map((i) => (i.kind === kind ? i.text : "")).join("");
}

test("splits thinking and text across arbitrary chunks", () => {
  const items = collect(["hello ", "<thin", "king>why", " not</thi", "nking> world"]);
  assert.equal(joined(items, "text"), "hello  world");
  assert.equal(joined(items, "thinking"), "why not");
});

test("supports the qwen thinking tag", () => {
  const items = collect([" thinking", "hmm", " response", "answer"]);
  assert.equal(joined(items, "thinking"), "hmm");
  assert.equal(joined(items, "text"), "answer");
});

test("extracts tool calls and surrounding text", () => {
  const items = collect([
    "before ",
    '<tool_call>{"name":"read","arguments":{"path":"a.ts"}}',
    "</tool_call> middle ",
    '<tool_call>{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}</tool_call>',
    " after",
  ]);
  const calls = items.filter((i) => i.kind === "tool").map((i) => (i.kind === "tool" ? i.call : null));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.name, "read");
  assert.deepEqual(calls[0]?.args, { path: "a.ts" });
  assert.equal(calls[1]?.name, "bash");
  assert.deepEqual(calls[1]?.args, { command: "ls" });
  assert.equal(joined(items, "text"), "before  middle  after");
});

test("unterminated tool call becomes an error call", () => {
  const items = collect(['<tool_call>{"name":"read"']);
  const tool = items.find((i) => i.kind === "tool");
  assert.ok(tool && tool.kind === "tool");
  assert.ok(tool.call.argError);
});

test("malformed JSON becomes an error call", () => {
  const items = collect(["<tool_call>not json</tool_call>"]);
  const tool = items.find((i) => i.kind === "tool");
  assert.ok(tool && tool.kind === "tool");
  assert.equal(tool.call.name, "invalid_tool_call");
  assert.ok(tool.call.argError);
});

test("does not leak partial markers", () => {
  const items = collect(["hello <", "tool_ca", 'll>{"name":"ls","arguments":{}}</tool_call>']);
  assert.equal(joined(items, "text"), "hello ");
});
