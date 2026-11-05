import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultSpec,
  describePredicate,
  normalizeSpec,
  presetNames,
  presetSpec,
  SpecError,
  stageIndex,
} from "../src/loop/spec.ts";
import type { SpecLimits } from "../src/loop/limits.ts";

const LIMITS: SpecLimits = { maxStepsCap: 10, contextWindow: 4096 };

test("default spec is a single react stage", () => {
  const spec = defaultSpec(LIMITS);
  assert.equal(spec.stages.length, 1);
  assert.equal(spec.maxSteps, 10);
  assert.deepEqual(spec.finish, { modelStopped: true });
});

test("maxSteps is clamped to the human cap", () => {
  const spec = normalizeSpec({ maxSteps: 1000, stages: [{ id: "a", goal: "" }] }, LIMITS);
  assert.equal(spec.maxSteps, 10);
});

test("merges a partial patch into the base spec", () => {
  const base = defaultSpec(LIMITS);
  const spec = normalizeSpec({ name: "custom", toolPolicy: { parallel: true } }, LIMITS, base);
  assert.equal(spec.name, "custom");
  assert.equal(spec.toolPolicy.parallel, true);
  assert.equal(spec.stages.length, 1);
  assert.equal(spec.maxSteps, base.maxSteps);
});

test("validates flat command predicates", () => {
  const spec = normalizeSpec(
    {
      stages: [{ id: "a", goal: "", exitWhen: { command: "true", expectExit: 0, timeoutMs: 5000 } }],
    },
    LIMITS,
  );
  assert.equal(describePredicate(spec.stages[0].exitWhen).includes("true"), true);
  assert.throws(
    () => normalizeSpec({ stages: [{ id: "a", goal: "", exitWhen: { command: "true", expectExit: 0, foo: 1 } }] }, LIMITS),
    SpecError,
  );
});

test("rejects invalid predicates and duplicate stages", () => {
  assert.throws(() => normalizeSpec({ stages: [{ id: "a", goal: "", exitWhen: { wat: true } }] }, LIMITS), SpecError);
  assert.throws(
    () => normalizeSpec({ stages: [{ id: "a", goal: "" }, { id: "a", goal: "" }] }, LIMITS),
    SpecError,
  );
  assert.throws(() => normalizeSpec({ stages: [] }, LIMITS), SpecError);
});

test("command predicates keep expectExit", () => {
  const spec = normalizeSpec({ stages: [{ id: "a", goal: "", exitWhen: { command: "npm test", expectExit: 0 } }] }, LIMITS);
  assert.deepEqual(spec.stages[0].exitWhen, { command: "npm test", expectExit: 0 });
  assert.equal(describePredicate(spec.stages[0].exitWhen), 'command "npm test" exits 0');
});

test("presets exist and are valid", () => {
  assert.deepEqual(presetNames().sort(), ["plan-execute", "react", "tdd"]);
  for (const name of presetNames()) {
    const spec = presetSpec(name, LIMITS);
    assert.ok(spec.stages.length >= 1);
    assert.ok(spec.maxSteps <= LIMITS.maxStepsCap);
  }
});

test("stageIndex resolves startStage", () => {
  const spec = normalizeSpec({ stages: [{ id: "a", goal: "" }, { id: "b", goal: "" }], startStage: "b" }, LIMITS);
  assert.equal(stageIndex(spec, spec.startStage), 1);
  assert.equal(stageIndex(spec, "missing"), 0);
});
