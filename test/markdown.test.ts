import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkdownRenderer, stripAnsi } from "../src/ui/markdown.ts";

function plain() {
  return new MarkdownRenderer({ color: false });
}

test("renders inline markdown", () => {
  const md = plain();
  const lines = md.render("**bold** and *italic* and ~~gone~~ and `code` and [docs](https://x.dev)", 80);
  assert.deepEqual(lines, ["bold and italic and gone and code and docs (https://x.dev)"]);
});

test("does not italicize underscores inside words", () => {
  const md = plain();
  assert.deepEqual(md.render("file_name and _real_ and __strong__", 80), ["file_name and real and strong"]);
});

test("renders headings with surrounding space", () => {
  const md = plain();
  assert.deepEqual(md.render("## Title ##", 80), ["Title", ""]);
  assert.deepEqual(md.render("body", 80), ["body"]);
});

test("collapses duplicate blank lines", () => {
  const md = plain();
  assert.deepEqual(md.render("a", 80), ["a"]);
  assert.deepEqual(md.render("", 80), [""]);
  assert.deepEqual(md.render("", 80), []);
  assert.deepEqual(md.render("b", 80), ["b"]);
});

test("renders bullets, tasks, numbered lists, and quotes", () => {
  const md = plain();
  assert.deepEqual(md.render("- one", 80), ["• one"]);
  assert.deepEqual(md.render("  - two", 80), ["  • two"]);
  assert.deepEqual(md.render("- [x] done", 80), ["☑ done"]);
  assert.deepEqual(md.render("- [ ] todo", 80), ["☐ todo"]);
  assert.deepEqual(md.render("1. first", 80), ["1. first"]);
  assert.deepEqual(md.render("> quoted **bold**", 80), ["│ quoted bold"]);
});

test("renders a horizontal rule", () => {
  const md = plain();
  const lines = md.render("---", 60);
  assert.ok(lines[0].startsWith("─"));
  assert.ok(lines[0].length >= 20);
});

test("renders fenced code with a gutter and closes it at the end", () => {
  const md = plain();
  assert.deepEqual(md.render("```ts", 80), ["┌─ ts"]);
  assert.deepEqual(md.render("const x = 1;", 80), ["│ const x = 1;"]);
  assert.deepEqual(md.render("```", 80), ["└─", ""]);

  const open = plain();
  assert.deepEqual(open.render("```", 80), ["┌─"]);
  assert.deepEqual(open.finish(80), ["└─", ""]);
});

test("buffers and aligns tables", () => {
  const md = plain();
  assert.deepEqual(md.render("| Name | Value |", 80), []);
  assert.deepEqual(md.render("|:---|---:|", 80), []);
  assert.deepEqual(md.render("| alpha | 1 |", 80), []);
  const lines = md.render("after", 80);
  assert.match(lines[0], /Name\s+│\s+Value/);
  assert.match(lines[1], /┼/);
  assert.match(lines[2], /alpha/);
  assert.equal(lines.at(-1), "after");
  assert.ok(lines.includes(""));
});

test("flushes an unfinished table at finish", () => {
  const md = plain();
  md.render("| a | b |", 80);
  md.render("|---|---|", 80);
  const lines = md.finish(80);
  assert.match(lines[0], /a/);
  assert.match(lines[1], /┼/);
});

test("color mode uses bold and never a background", () => {
  const md = new MarkdownRenderer({ color: true });
  const lines = md.render("**bold**", 80);
  assert.ok(lines[0].includes("\x1b[1m"));
  assert.equal(stripAnsi(lines[0]), "bold");
  assert.ok(!lines[0].includes("\x1b[48;"));
});
