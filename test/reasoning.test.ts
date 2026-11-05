import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REASONING_EFFORTS,
  effortChoices,
  effortMenuLines,
  isReasoningEffort,
  maxEffort,
  normalizeEfforts,
  parseReasoningEffort,
  supportsEffort,
} from "../src/reasoning.ts";

test("lists every reasoning effort", () => {
  assert.deepEqual(
    REASONING_EFFORTS.map((effort) => effort.value),
    ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.ok(REASONING_EFFORTS.every((effort) => effort.description.length > 0));
});

test("parses effort names and menu numbers", () => {
  assert.equal(parseReasoningEffort("HIGH"), "high");
  assert.equal(parseReasoningEffort("3"), "minimal");
  assert.equal(parseReasoningEffort("bogus"), null);
  assert.equal(parseReasoningEffort("3", false), null);
  assert.equal(isReasoningEffort("medium"), true);
  assert.equal(isReasoningEffort("max"), true);
  assert.equal(isReasoningEffort("xhigh"), true);
  assert.equal(isReasoningEffort("ultra"), true);
});

test("effort menu marks the current value", () => {
  const lines = effortMenuLines("medium");
  assert.match(lines[0], /current: medium/);
  assert.ok(lines.some((line) => line.includes("medium") && line.includes("*")));
});

test("normalizes per-model effort declarations", () => {
  assert.deepEqual(normalizeEfforts(["high", "low", "auto", "bogus"]), ["low", "high"]);
  assert.deepEqual(normalizeEfforts([]), []);
  assert.equal(normalizeEfforts(undefined), undefined);
  assert.equal(normalizeEfforts("high"), undefined);
});

test("max effort and choices respect a model's declared levels", () => {
  assert.equal(maxEffort(["low", "medium"]), "medium");
  assert.equal(maxEffort(["low", "high", "max"]), "max");
  assert.equal(maxEffort(["low", "high", "max", "ultra"]), "ultra");
  assert.equal(maxEffort([]), "auto");
  assert.deepEqual(
    effortChoices(["low", "high"]).map((effort) => effort.value),
    ["auto", "low", "high"],
  );
  assert.equal(supportsEffort("auto", []), true);
  assert.equal(supportsEffort("high", ["low", "high"]), true);
  assert.equal(supportsEffort("medium", ["low", "high"]), false);
});
