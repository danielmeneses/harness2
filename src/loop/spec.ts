import type { SpecLimits } from "./limits.ts";

export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { modelStopped: true }
  | { toolCalled: string }
  | { toolOk: string }
  | { toolFailed: string }
  | { fileExists: string }
  | { filesChanged: string[] }
  | { stepsAtLeast: number }
  | { lastOutputMatches: string }
  | { command: string; expectExit: number; timeoutMs?: number };

export type Stage = {
  id: string;
  goal: string;
  tools?: string[];
  systemAddendum?: string;
  exitWhen?: Predicate;
  maxSteps?: number;
};

export type LoopSpec = {
  name: string;
  maxSteps: number;
  startStage?: string;
  stages: Stage[];
  toolPolicy: { parallel: boolean; allow?: string[]; deny?: string[] };
  onToolError: "retry" | "continue" | "halt";
  compactAtPct?: number;
  sampling?: { temperature?: number; topP?: number; maxTokens?: number };
  finish: Predicate;
};

export class SpecError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "SpecError";
    this.issues = issues;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function defaultSpec(limits: SpecLimits): LoopSpec {
  const max = Math.min(limits.maxStepsCap, 40);
  return {
    name: "react",
    maxSteps: max,
    stages: [{ id: "work", goal: "", exitWhen: { modelStopped: true } }],
    toolPolicy: { parallel: false },
    onToolError: "continue",
    finish: { modelStopped: true },
  };
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length ? [...new Set(out)] : [];
}

function validatePredicate(v: unknown, path: string, depth: number, issues: string[], counter: { n: number } = { n: 0 }): void {
  counter.n++;
  if (counter.n > 256) {
    issues.push(`${path}: too many predicate nodes (max 256)`);
    return;
  }
  if (depth > 8) {
    issues.push(`${path}: predicate nesting too deep`);
    return;
  }
  if (!isRecord(v)) {
    issues.push(`${path}: predicate must be an object`);
    return;
  }
  const keys = Object.keys(v);
  const known = ["all", "any", "not", "modelStopped", "toolCalled", "toolOk", "toolFailed", "fileExists", "filesChanged", "stepsAtLeast", "lastOutputMatches", "command"];
  const key = known.find((k) => k in v);
  if (!key) {
    issues.push(`${path}: unknown predicate ${keys.length ? JSON.stringify(keys[0]) : "(empty object)"}`);
    return;
  }
  const extra = keys.filter((k) => k !== key && !(key === "command" && (k === "expectExit" || k === "timeoutMs")));
  if (extra.length) issues.push(`${path}: unexpected keys ${extra.join(", ")}`);
  const val = v[key];
  switch (key) {
    case "all":
    case "any": {
      if (!Array.isArray(val)) return void issues.push(`${path}.${key}: must be an array`);
      if (val.length > 20) issues.push(`${path}.${key}: at most 20 predicates`);
      val.forEach((p, i) => validatePredicate(p, `${path}.${key}[${i}]`, depth + 1, issues, counter));
      return;
    }
    case "not":
      return validatePredicate(val, `${path}.not`, depth + 1, issues, counter);
    case "modelStopped":
      if (val !== true) issues.push(`${path}.modelStopped: must be true`);
      return;
    case "toolCalled":
    case "toolOk":
    case "toolFailed":
      if (typeof val !== "string" || !val.trim() || val.length > 200) issues.push(`${path}.${key}: must be a non-empty string (max 200 chars)`);
      return;
    case "fileExists":
      if (typeof val !== "string" || !val.trim() || val.length > 4096) issues.push(`${path}.fileExists: must be a non-empty path (max 4096 chars)`);
      return;
    case "lastOutputMatches":
      if (typeof val !== "string" || !val.trim() || val.length > 500) issues.push(`${path}.lastOutputMatches: must be a non-empty regex (max 500 chars)`);
      return;
    case "filesChanged":
      if (!Array.isArray(val) || val.length > 32 || val.some((x) => typeof x !== "string" || !x || x.length > 4096)) {
        issues.push(`${path}.filesChanged: must be an array of at most 32 non-empty strings`);
      }
      return;
    case "stepsAtLeast":
      if (typeof val !== "number" || !Number.isInteger(val) || val < 1) issues.push(`${path}.stepsAtLeast: must be an integer >= 1`);
      return;
    case "command": {
      if (typeof val !== "string" || !val.trim() || val.length > 4000) issues.push(`${path}.command: must be a non-empty string (max 4000 chars)`);
      if (typeof v.expectExit !== "number" || !Number.isInteger(v.expectExit) || v.expectExit < 0) {
        issues.push(`${path}.command.expectExit: must be an integer >= 0`);
      }
      if (v.timeoutMs !== undefined && (typeof v.timeoutMs !== "number" || v.timeoutMs < 1000 || v.timeoutMs > 600_000)) {
        issues.push(`${path}.command.timeoutMs: must be between 1000 and 600000`);
      }
      return;
    }
    default:
      issues.push(`${path}: unknown predicate "${key}"`);
  }
}

function mergeSpec(base: LoopSpec, patch: unknown): Record<string, unknown> {
  if (!isRecord(patch)) throw new SpecError(["spec must be an object"]);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "toolPolicy" && isRecord(v) && isRecord(base.toolPolicy)) out[k] = { ...base.toolPolicy, ...v };
    else if (k === "sampling" && isRecord(v) && isRecord(base.sampling)) out[k] = { ...base.sampling, ...v };
    else out[k] = v;
  }
  return out;
}

export function normalizeSpec(input: unknown, limits: SpecLimits, base?: LoopSpec): LoopSpec {
  const raw = base ? mergeSpec(base, input) : input;
  if (!isRecord(raw)) throw new SpecError(["spec must be an object"]);
  const issues: string[] = [];
  if (raw.maxSteps !== undefined && (typeof raw.maxSteps !== "number" || !Number.isInteger(raw.maxSteps) || raw.maxSteps < 1)) {
    issues.push("maxSteps must be an integer >= 1");
  }
  if (!Array.isArray(raw.stages)) {
    issues.push("stages must be a non-empty array");
  } else if (raw.stages.length === 0) {
    issues.push("stages must not be empty");
  } else if (raw.stages.length > 12) {
    issues.push("at most 12 stages are supported");
  }

  const stages: Stage[] = [];
  if (Array.isArray(raw.stages)) {
    raw.stages.forEach((s, i) => {
      if (!isRecord(s)) return void issues.push(`stages[${i}] must be an object`);
      if (typeof s.id !== "string" || !s.id.trim()) return void issues.push(`stages[${i}].id must be a non-empty string`);
      if (typeof s.goal !== "string") issues.push(`stages[${i}].goal must be a string`);
      if (s.tools !== undefined && stringList(s.tools) === undefined) issues.push(`stages[${i}].tools must be an array of strings`);
      if (s.systemAddendum !== undefined && typeof s.systemAddendum !== "string") issues.push(`stages[${i}].systemAddendum must be a string`);
      if (s.exitWhen !== undefined) validatePredicate(s.exitWhen, `stages[${i}].exitWhen`, 0, issues);
      const maxSteps = s.maxSteps === undefined ? undefined : clampInt(s.maxSteps, 1, 1, limits.maxStepsCap);
      stages.push({
        id: s.id.trim().slice(0, 80),
        goal: (typeof s.goal === "string" ? s.goal : "").slice(0, 4000),
        tools: stringList(s.tools)?.slice(0, 64),
        systemAddendum: typeof s.systemAddendum === "string" ? s.systemAddendum.slice(0, 8000) : undefined,
        exitWhen: s.exitWhen as Predicate | undefined,
        maxSteps,
      });
    });
    const ids = stages.map((s) => s.id);
    if (new Set(ids).size !== ids.length) issues.push("stage ids must be unique");
  }

  const toolPolicyRaw = isRecord(raw.toolPolicy) ? raw.toolPolicy : {};
  const toolPolicy = {
    parallel: toolPolicyRaw.parallel === true,
    allow: stringList(toolPolicyRaw.allow)?.slice(0, 64),
    deny: stringList(toolPolicyRaw.deny)?.slice(0, 64),
  };

  if (raw.finish !== undefined) validatePredicate(raw.finish, "finish", 0, issues);
  if (raw.onToolError !== undefined && !["retry", "continue", "halt"].includes(String(raw.onToolError))) {
    issues.push("onToolError must be retry, continue, or halt");
  }
  if (raw.startStage !== undefined && (typeof raw.startStage !== "string" || !stages.some((s) => s.id === raw.startStage))) {
    issues.push("startStage must name a stage");
  }
  if (raw.compactAtPct !== undefined) {
    if (typeof raw.compactAtPct !== "number" || raw.compactAtPct < 0.3 || raw.compactAtPct > 0.95) {
      issues.push("compactAtPct must be between 0.3 and 0.95");
    }
  }

  const samplingRaw = isRecord(raw.sampling) ? raw.sampling : undefined;
  if (samplingRaw) {
    if (samplingRaw.temperature !== undefined && (typeof samplingRaw.temperature !== "number" || samplingRaw.temperature < 0 || samplingRaw.temperature > 2)) {
      issues.push("sampling.temperature must be between 0 and 2");
    }
    if (samplingRaw.topP !== undefined && (typeof samplingRaw.topP !== "number" || samplingRaw.topP < 0 || samplingRaw.topP > 1)) {
      issues.push("sampling.topP must be between 0 and 1");
    }
    if (samplingRaw.maxTokens !== undefined && (typeof samplingRaw.maxTokens !== "number" || !Number.isInteger(samplingRaw.maxTokens) || samplingRaw.maxTokens < 1)) {
      issues.push("sampling.maxTokens must be an integer >= 1");
    }
  }

  if (issues.length) throw new SpecError(issues);

  const maxSteps = Math.min(limits.maxStepsCap, clampInt(raw.maxSteps, 40, 1, limits.maxStepsCap));
  const sampling = samplingRaw
    ? {
        temperature: typeof samplingRaw.temperature === "number" ? samplingRaw.temperature : undefined,
        topP: typeof samplingRaw.topP === "number" ? samplingRaw.topP : undefined,
        maxTokens:
          typeof samplingRaw.maxTokens === "number"
            ? Math.min(limits.contextWindow, Math.max(1, Math.floor(samplingRaw.maxTokens)))
            : undefined,
      }
    : undefined;

  return {
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : (base?.name ?? "custom"),
    maxSteps,
    startStage: typeof raw.startStage === "string" ? raw.startStage : undefined,
    stages,
    toolPolicy,
    onToolError: (["retry", "continue", "halt"] as const).includes(raw.onToolError as never)
      ? (raw.onToolError as LoopSpec["onToolError"])
      : "continue",
    compactAtPct: typeof raw.compactAtPct === "number" ? raw.compactAtPct : undefined,
    sampling,
    finish: (raw.finish as Predicate | undefined) ?? { modelStopped: true },
  };
}

/**
 * Re-validate a persisted spec against the current host envelope.
 * Session files are model-writable data, so a resumed loop must be treated as
 * untrusted input rather than as a previously granted capability.
 */
export function clampToHost(spec: LoopSpec, limits: SpecLimits): LoopSpec {
  const safe = normalizeSpec(spec, limits, defaultSpec(limits));
  safe.maxSteps = Math.min(safe.maxSteps, limits.maxStepsCap);
  return safe;
}

export function stageIndex(spec: LoopSpec, id?: string): number {
  if (!id) return 0;
  const i = spec.stages.findIndex((s) => s.id === id);
  return i >= 0 ? i : 0;
}

export function describePredicate(p: Predicate | undefined): string {
  if (!p) return "true (no condition)";
  if ("all" in p) return `(${p.all.map(describePredicate).join(" AND ")})`;
  if ("any" in p) return `(${p.any.map(describePredicate).join(" OR ")})`;
  if ("not" in p) return `NOT (${describePredicate(p.not)})`;
  if ("modelStopped" in p) return "the model stops (a reply with no tool calls)";
  if ("toolCalled" in p) return `tool "${p.toolCalled}" has been called in this stage`;
  if ("toolOk" in p) return `tool "${p.toolOk}" succeeded in this stage`;
  if ("toolFailed" in p) return `tool "${p.toolFailed}" failed in this stage`;
  if ("fileExists" in p) return `file "${p.fileExists}" exists`;
  if ("filesChanged" in p) return `files changed: ${p.filesChanged.join(", ")}`;
  if ("stepsAtLeast" in p) return `at least ${p.stepsAtLeast} steps in this stage`;
  if ("lastOutputMatches" in p) return `last tool output matches /${p.lastOutputMatches}/`;
  if ("command" in p) return `command "${p.command}" exits ${p.expectExit}`;
  return "unknown condition";
}

export function formatSpec(spec: LoopSpec): string {
  return JSON.stringify(spec, null, 2);
}

type PresetBuilder = (limits: SpecLimits) => LoopSpec;

const PRESETS: Record<string, PresetBuilder> = {
  react: (limits) => defaultSpec(limits),
  "plan-execute": (limits) => {
    const base = defaultSpec(limits);
    return {
      ...base,
      name: "plan-execute",
      stages: [
        {
          id: "plan",
          goal: "Inspect the workspace, then record a concrete plan with the todo tool. Do not implement yet.",
          tools: ["read", "ls", "glob", "grep", "todo", "bash", "loop_inspect", "loop_note", "loop_stage"],
          exitWhen: { toolCalled: "todo" },
        },
        {
          id: "execute",
          goal: "Implement the plan from the todo list, verifying each step.",
          exitWhen: { modelStopped: true },
        },
        {
          id: "review",
          goal: "Review the diff against the plan, run the relevant checks, and fix anything broken.",
          exitWhen: { modelStopped: true },
        },
      ],
    };
  },
  tdd: (limits) => {
    const base = defaultSpec(limits);
    return {
      ...base,
      name: "tdd",
      stages: [
        {
          id: "test",
          goal: "Find or write a failing test that captures the requested behavior. Run it and confirm it fails for the right reason.",
          tools: ["read", "ls", "glob", "grep", "write", "edit", "bash", "todo", "loop_note"],
          exitWhen: { any: [{ toolOk: "bash" }, { toolCalled: "edit" }] },
        },
        {
          id: "implement",
          goal: "Make the failing test pass with the smallest correct change.",
          exitWhen: { toolOk: "bash" },
        },
        {
          id: "verify",
          goal: "Run the full relevant test suite and check for regressions.",
          exitWhen: { modelStopped: true },
        },
      ],
    };
  },
};

export function presetSpec(name: string, limits: SpecLimits): LoopSpec {
  const build = PRESETS[name];
  if (!build) throw new SpecError([`unknown preset "${name}" (available: ${Object.keys(PRESETS).join(", ")})`]);
  return build(limits);
}

export function presetNames(): string[] {
  return Object.keys(PRESETS);
}
