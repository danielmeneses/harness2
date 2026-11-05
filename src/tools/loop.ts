import type { ToolContext, ToolImpl } from "./types.ts";
import { capOutput, denied, failure } from "./types.ts";
import { optString, reqString } from "./args.ts";
import type { SpecLimits } from "../loop/limits.ts";
import { formatSpec, normalizeSpec, presetNames, presetSpec, defaultSpec, type LoopSpec } from "../loop/spec.ts";
import { describePredicate } from "../loop/spec.ts";
import type { Conversation, LoopMutation } from "../loop/state.ts";
import { errorMessage } from "../util.ts";

/** The spec as it will look after already-staged changes in this batch. */
function effectiveSpec(conv: Conversation): LoopSpec {
  for (let i = conv.pendingMutations.length - 1; i >= 0; i--) {
    const m = conv.pendingMutations[i];
    if (m.kind === "spec") return m.spec;
  }
  return conv.spec;
}

function limits(ctx: ToolContext): SpecLimits {
  return { maxStepsCap: ctx.cfg.loop.maxStepsCap, contextWindow: ctx.cfg.provider.contextWindow };
}

function summary(spec: LoopSpec, ctx: ToolContext): string {
  const current = ctx.conv.spec.stages[ctx.conv.stageIndex];
  const stage = (current && spec.stages.find((s) => s.id === current.id)) ?? spec.stages[ctx.conv.stageIndex] ?? spec.stages[0];
  return [
    `Loop now: ${spec.name} (applies after this tool batch)`,
    `maxSteps: ${spec.maxSteps}/${ctx.cfg.loop.maxStepsCap}`,
    `stages: ${spec.stages.map((s) => s.id).join(" → ")}`,
    `current stage stays: ${stage?.id ?? "?"}`,
    `finish: ${describePredicate(spec.finish)}`,
    `tools: ${spec.toolPolicy.parallel ? "parallel" : "serial"}${spec.toolPolicy.allow?.length ? `, allow=${spec.toolPolicy.allow.join(",")}` : ""}${spec.toolPolicy.deny?.length ? `, deny=${spec.toolPolicy.deny.join(",")}` : ""}`,
    "Call loop_inspect after the batch to see the live spec.",
  ].join("\n");
}

const set: ToolImpl = {
  spec: {
    name: "loop_set",
    description:
      "Rewrite the agent loop. Provide a partial spec (merged into the current spec by default) or a preset. Changes apply after this tool batch. Safety (path jail, approvals, network, hard caps) is not part of the spec and cannot be changed. Spec: {name?, maxSteps, startStage?, stages:[{id, goal, tools?, systemAddendum?, exitWhen?, maxSteps?}], toolPolicy:{parallel, allow?, deny?}, onToolError:\"retry\"|\"continue\"|\"halt\", compactAtPct?, sampling?:{temperature?,topP?,maxTokens?}, finish}. Predicates: all/any/not, modelStopped, toolCalled, toolOk, toolFailed, fileExists, filesChanged, stepsAtLeast, lastOutputMatches, command. Presets: " +
      presetNames().join(", "),
    parameters: {
      type: "object",
      properties: {
        spec: { type: "object", description: "Loop spec or partial spec." },
        preset: { type: "string", description: "Base the spec on a preset." },
        reason: { type: "string", description: "Why the loop is changing (shown to the user)." },
        merge: { type: "boolean", description: "Merge into the current spec (default true)." },
      },
    },
  },
  async execute(args, ctx) {
    const patch = args.spec;
    const preset = optString(args, "preset");
    const merge = args.merge !== false;
    if (patch === undefined && !preset) return failure("provide spec and/or preset");

    const base = preset ? presetSpec(preset, limits(ctx)) : merge ? effectiveSpec(ctx.conv) : defaultSpec(limits(ctx));
    let next: LoopSpec;
    try {
      next = patch === undefined ? base : normalizeSpec(patch, limits(ctx), base);
    } catch (e) {
      return failure(`invalid loop spec: ${errorMessage(e)}`);
    }

    if (ctx.cfg.loop.changes === "approve") {
      const res = await ctx.approvals.request({
        kind: "loop",
        title: "the model wants to change the loop",
        detail: formatSpec(next),
        key: `loop:${JSON.stringify(next)}`,
      });
      if (res.decision === "deny") return denied(res.reason || "the user denied this loop change");
    }

    ctx.conv.pendingMutations.push({
      kind: "spec",
      spec: next,
      reason: (optString(args, "reason") ?? "model requested a loop change").slice(0, 2000),
      by: "model",
      expectedVersion: ctx.conv.specVersion,
    });
    return { ok: true, output: summary(next, ctx), meta: { spec: next, staged: ctx.conv.pendingMutations.length } };
  },
};

const inspect: ToolImpl = {
  spec: {
    name: "loop_inspect",
    description: "Show the live loop spec, current stage, step budgets, notes, todos, and recent tool outcomes.",
    parameters: { type: "object", properties: {} },
  },
  async execute(_args, ctx) {
    const conv = ctx.conv;
    const data = {
      spec: conv.spec,
      stage: { index: conv.stageIndex, current: conv.spec.stages[conv.stageIndex] },
      steps: { used: conv.runStep, max: conv.spec.maxSteps, inStage: conv.stageSteps },
      notes: conv.notes,
      todos: conv.todos,
      changedFiles: [...conv.changedFiles],
      recentTools: conv.stageTools.slice(-20).map((t) => ({ name: t.name, ok: t.ok, output: t.output.slice(0, 300) })),
      usage: conv.usage,
      specVersion: conv.specVersion,
      pendingMutations: conv.pendingMutations.map((m) => (m.kind === "spec" ? { kind: m.kind, reason: m.reason } : { kind: m.kind, stage: m.stage })),
      budget: conv.budget.snapshot(),
    };
    return { ok: true, output: JSON.stringify(data, null, 2) };
  },
};

const stage: ToolImpl = {
  spec: {
    name: "loop_stage",
    description: "Move the loop to another stage. action: next (default), restart, or enter with a stage id. Applies after this tool batch.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["next", "restart", "enter"] },
        stage: { type: "string", description: "Stage id for action=enter." },
      },
    },
  },
  async execute(args, ctx) {
    const action = optString(args, "action") ?? "next";
    const spec = effectiveSpec(ctx.conv);
    let target = ctx.conv.stageIndex;
    if (action === "next") target += 1;
    else if (action === "restart") target = 0;
    else if (action === "enter") {
      const id = optString(args, "stage");
      if (!id) return failure("stage id is required for action=enter");
      target = spec.stages.findIndex((s) => s.id === id);
      if (target < 0) return failure(`unknown stage "${id}" (stages: ${spec.stages.map((s) => s.id).join(", ")})`);
    } else return failure(`unknown action "${action}"`);

    if (target < 0 || target >= spec.stages.length) {
      return failure(`no stage at index ${target} (${spec.stages.length} stages); the run will finish if conditions are met`);
    }
    const next = spec.stages[target];
    ctx.conv.pendingMutations.push({ kind: "stage", stage: next.id, expectedVersion: ctx.conv.specVersion });
    return { ok: true, output: `Will enter stage "${next.id}" after this batch. Goal: ${next.goal || "(none)"}` };
  },
};

const halt: ToolImpl = {
  spec: {
    name: "loop_halt",
    description: "Stop the loop after this tool batch and return the given answer. Use sparingly; normally a reply with no tool calls finishes.",
    parameters: {
      type: "object",
      properties: { answer: { type: "string", description: "Final answer to return." } },
      required: ["answer"],
    },
  },
  async execute(args, ctx) {
    const answer = reqString(args, "answer").slice(0, 20_000);
    ctx.conv.halt = { answer };
    return { ok: true, output: "The loop will stop after this batch. The answer is recorded." };
  },
};

const note: ToolImpl = {
  spec: {
    name: "loop_note",
    description: "Store a durable note (decisions, constraints, findings) that survives context compaction and is shown to you every step.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  async execute(args, ctx) {
    const text = reqString(args, "text");
    ctx.conv.notes.push(text.slice(0, 4000));
    if (ctx.conv.notes.length > 50) ctx.conv.notes = ctx.conv.notes.slice(-50);
    ctx.emit(ctx.conv.id, { t: "loop.note", text });
    return { ok: true, output: `Noted. ${ctx.conv.notes.length} note(s) stored.` };
  },
};

const ask: ToolImpl = {
  spec: {
    name: "loop_ask",
    description: "Ask the human a question and wait for the answer. Returns the answer as the tool result. If no interactive user is available, returns a note instead of blocking.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, description: "Optional suggested answers." },
      },
      required: ["question"],
    },
  },
  async execute(args, ctx) {
    const question = reqString(args, "question");
    const options = Array.isArray(args.options) ? (args.options as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
    const answer = await ctx.approvals.ask(question, options, ctx.conv.id);
    if (answer === null) {
      return {
        ok: true,
        output: "No interactive user is available to answer. Proceed with your best judgment and state your assumptions in the final answer.",
      };
    }
    return { ok: true, output: `User answered: ${answer || "(empty answer)"}` };
  },
};

const spawn: ToolImpl = {
  spec: {
    name: "loop_spawn",
    description:
      "Run a child conversation with its own loop and return its final answer. The child streams to the UI as a separate conversation. Limited by depth/concurrency caps. Give it a self-contained task.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Self-contained task for the child." },
        spec: { type: "object", description: "Optional loop spec for the child." },
        name: { type: "string", description: "Short label for the child stream." },
      },
      required: ["task"],
    },
  },
  async execute(args, ctx) {
    if (!ctx.spawn) return failure("subagents are not available in this mode");
    const task = reqString(args, "task");
    const spec = typeof args.spec === "object" && args.spec !== null && !Array.isArray(args.spec) ? (args.spec as Record<string, unknown>) : undefined;
    const name = optString(args, "name");
    try {
      const answer = await ctx.spawn(task, spec, name);
      return { ok: true, output: capOutput(`Child finished. Final answer:\n${answer}`, ctx.cfg.safety.toolOutputChars) };
    } catch (e) {
      return failure(`subagent failed: ${errorMessage(e)}`);
    }
  },
};

export const loopTools: ToolImpl[] = [set, inspect, stage, halt, note, ask, spawn];

export type CommitResult = {
  spec?: LoopSpec;
  reason?: string;
  by?: "model" | "user";
  stage?: string;
  /** Whole transaction was dropped because the spec changed since staging. */
  conflict?: string;
};

/**
 * Commit all staged loop mutations atomically, in call order.
 *
 * - Every mutation records the version it was validated against. If the live
 *   spec moved on (for example a future async writer), the whole transaction is
 *   rejected rather than applying half of it.
 * - Replacing the spec preserves the current stage by id when possible, so a
 *   rewrite does not silently move the model to an unrelated stage.
 */
export function commitMutations(conv: Conversation): CommitResult {
  const queue = conv.pendingMutations;
  conv.pendingMutations = [];
  if (!queue.length) return {};

  const version = conv.specVersion;
  const stale = queue.filter((m) => m.expectedVersion !== version);
  if (stale.length) {
    return { conflict: `loop changed since the mutation was staged (expected v${stale[0].expectedVersion}, now v${version})` };
  }

  let lastSpec: LoopMutation & { kind: "spec" } | undefined;
  let stage: string | undefined;
  for (const mutation of queue) {
    if (mutation.kind === "spec") {
      const current = conv.spec.stages[conv.stageIndex];
      conv.spec = mutation.spec;
      const preserved = current ? conv.spec.stages.findIndex((s) => s.id === current.id) : -1;
      conv.stageIndex = preserved >= 0 ? preserved : Math.min(conv.stageIndex, conv.spec.stages.length - 1);
      lastSpec = mutation;
      stage = conv.spec.stages[conv.stageIndex]?.id;
    } else {
      const idx = conv.spec.stages.findIndex((s) => s.id === mutation.stage);
      if (idx >= 0) {
        conv.stageIndex = idx;
        stage = conv.spec.stages[idx].id;
      }
    }
  }

  conv.specVersion++;
  return {
    spec: lastSpec?.spec,
    reason: lastSpec?.reason,
    by: lastSpec?.by,
    stage,
  };
}
