import { test } from "node:test";
import assert from "node:assert/strict";
import { Editor } from "../src/ui/editor.ts";
import type { Key, Terminal } from "../src/ui/terminal.ts";

function fakeTerm(keys: Key[]): { term: Terminal; writes: string[] } {
  const writes: string[] = [];
  let index = 0;
  const term = {
    width: 80,
    height: 24,
    write: (text: string) => writes.push(text),
    moveTo: () => {},
    clearLine: () => {},
    saveCursor: () => {},
    restoreCursor: () => {},
    readKey: async () => keys[index++] ?? null,
  } as unknown as Terminal;
  return { term, writes };
}

const options = [
  { value: "alpha", label: "alpha", description: "first" },
  { value: "beta", label: "beta", description: "second" },
  { value: "gamma", label: "gamma", description: "third" },
];

test("select filters by typed query and returns the highlighted value", async () => {
  const { term, writes } = fakeTerm([{ type: "char", ch: "g" }, { type: "char", ch: "a" }, { type: "enter" }]);
  const editor = new Editor(term, [], { color: false });
  const selected = await editor.select(options, "choose a value");
  assert.equal(selected, "gamma");
  assert.match(writes.join(""), /gamma/);
});

test("select navigates with arrows and cancels with ctrl-c", async () => {
  const first = fakeTerm([{ type: "down" }, { type: "enter" }]);
  const editor = new Editor(first.term, [], { color: false });
  assert.equal(await editor.select(options, "choose"), "beta");

  const second = fakeTerm([{ type: "ctrl", ch: "c" }]);
  const cancelling = new Editor(second.term, [], { color: false });
  assert.equal(await cancelling.select(options, "choose"), null);

  const third = fakeTerm([{ type: "escape" }]);
  const escaped = new Editor(third.term, [], { color: false });
  assert.equal(await escaped.select(options, "choose"), null);
});

test("escape dismisses the slash command menu", async () => {
  const { term } = fakeTerm([{ type: "char", ch: "/" }, { type: "char", ch: "m" }, { type: "escape" }, { type: "enter" }]);
  const editor = new Editor(term, [], { color: false });
  assert.equal(await editor.read(), "");
});

test("select prefers label matches over description matches", async () => {
  const modes = [
    { value: "auto", label: "auto", description: "try chat, fall back to completions" },
    { value: "completions", label: "completions", description: "prompt-rendered text tool calls" },
  ];
  const keys: Key[] = [
    { type: "char", ch: "c" },
    { type: "char", ch: "o" },
    { type: "char", ch: "m" },
    { type: "char", ch: "p" },
    { type: "enter" },
  ];
  const { term } = fakeTerm(keys);
  const editor = new Editor(term, [], { color: false });
  assert.equal(await editor.select(modes, "mode"), "completions");
});

test("renders the control panel below the input", async () => {
  const { term, writes } = fakeTerm([{ type: "enter" }]);
  const editor = new Editor(term, [], { color: false });
  editor.setControl(() => ({
    model: "mock-model",
    effort: "high",
    completionTokens: 456,
    promptTokens: 12_300,
    contextTokens: 12_300,
    contextWindow: 32_768,
    contextReported: true,
  }));
  assert.equal(await editor.read(), "");
  const output = writes.join("");
  assert.match(output, /model mock-model · effort high/);
  assert.match(output, /in 456 from model · out 12\.3k to model · context 12\.3k\/32\.8k 38%/);
});

test("enter with no matches does not close the selector", async () => {
  const { term } = fakeTerm([{ type: "char", ch: "z" }, { type: "enter" }, { type: "backspace" }, { type: "enter" }]);
  const editor = new Editor(term, [], { color: false });
  assert.equal(await editor.select(options, "choose"), "alpha");
});
