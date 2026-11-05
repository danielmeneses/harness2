import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReasoningEffort } from "./types.ts";
import { isReasoningEffort, normalizeEfforts } from "./reasoning.ts";
import { expandHome } from "./util.ts";
import { harnessHome } from "./home.ts";

export type Config = {
  cwd: string;
  provider: {
    baseUrl: string;
    apiKey: string;
    mode: "auto" | "chat" | "completions" | "responses";
    model: string;
    temperature: number;
    maxTokens: number;
    contextWindow: number;
    /** True when contextWindow came from /v1/models rather than a configured fallback. */
    contextWindowReported: boolean;
    /** Config/flags value to restore when a selected provider reports no window. */
    contextWindowFallback: number;
    timeoutMs: number;
    retries: number;
    headers: Record<string, string>;
    extraBody: Record<string, unknown>;
    /** Manual effort capabilities for servers that do not expose them in /v1/models. */
    modelEfforts: Record<string, ReasoningEffort[]>;
    /** Hard cap on prompt+completion tokens for the whole run tree. 0 disables. */
    totalTokenBudget: number;
    /** Hard cap on cumulative prompt tokens for the whole run tree. 0 disables. */
    promptTokenBudget: number;
  };
  reasoning: { effort: ReasoningEffort };
  prompt: {
    template: "chatml" | "plain";
    stop: string[];
    thinkingTags: Array<[string, string]>;
    thinkingControl: "none" | "qwen";
    systemSuffix: string;
  };
  loop: {
    maxStepsCap: number;
    defaultMaxSteps: number;
    maxToolCallsPerStep: number;
    compactAtPct: number;
    keepRecentMessages: number;
    changes: "auto" | "approve";
    defaultSpec: Record<string, unknown>;
    maxSubagentDepth: number;
    maxParallelSubagents: number;
    /** Hard cap on child conversations created in one run tree. 0 disables children. */
    maxChildAgents: number;
    /** Wall-clock budget for one run tree; 0 disables. */
    runTimeBudgetMs: number;
  };
  safety: {
    approvals: "on" | "off";
    approveAll: boolean;
    readRoots: string[];
    writeRoots: string[];
    allowedPaths: string[];
    network: "ask" | "allow" | "deny";
    bashSandbox: boolean;
    sandboxNetwork: boolean;
    bashTimeoutMs: number;
    toolOutputChars: number;
    readMaxBytes: number;
    /** Extra host environment variables passed to tool subprocesses. */
    envAllowlist: string[];
  };
  ui: { showThinking: boolean; color: boolean };
  session: { enabled: boolean; dir: string };
};

export type LoadConfigOptions = {
  /** Highest-precedence values (CLI flags). These may change host policy. */
  patch?: Record<string, unknown>;
  /** Trusted host values, merged after the project file. May set host-owned fields. */
  hostConfig?: unknown;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Host-owned fields. A project config can never change these: the model can write
 * project files, so treating them as project configuration would let it grant
 * itself capabilities. Only the user config, environment, or CLI may set them.
 */
export const HOST_OWNED_PATHS = [
  "safety",
  "loop.maxStepsCap",
  "loop.defaultMaxSteps",
  "loop.maxToolCallsPerStep",
  "loop.maxSubagentDepth",
  "loop.maxParallelSubagents",
  "loop.maxChildAgents",
  "loop.runTimeBudgetMs",
  "loop.compactAtPct",
  "loop.keepRecentMessages",
  "provider.baseUrl",
  "provider.apiKey",
  "provider.headers",
  "provider.contextWindow",
  "provider.totalTokenBudget",
  "provider.promptTokenBudget",
  "session.dir",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isRecord(base) || !isRecord(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isRecord(v) && isRecord(out[k]) ? merge(out[k], v) : v;
  }
  return out as T;
}

export function defaultConfig(cwd: string, home = harnessHome()): Config {
  return {
    cwd,
    provider: {
      baseUrl: "http://127.0.0.1:8080/v1",
      apiKey: "",
      mode: "auto",
      model: "default",
      temperature: 0.2,
      maxTokens: 16384,
      contextWindow: 32768,
      contextWindowReported: false,
      contextWindowFallback: 32768,
      timeoutMs: 600_000,
      retries: 2,
      headers: {},
      extraBody: {},
      modelEfforts: {},
      totalTokenBudget: 0,
      promptTokenBudget: 0,
    },
    reasoning: { effort: "auto" },
    prompt: {
      template: "chatml",
      stop: [],
      thinkingTags: [
        ["<thinking>", "</thinking>"],
        [" thinking", " response"],
      ],
      thinkingControl: "none",
      systemSuffix: "",
    },
    loop: {
      maxStepsCap: 100,
      defaultMaxSteps: 40,
      maxToolCallsPerStep: 16,
      compactAtPct: 0.95,
      keepRecentMessages: 10,
      changes: "auto",
      defaultSpec: {},
      maxSubagentDepth: 2,
      maxParallelSubagents: 2,
      maxChildAgents: 8,
      runTimeBudgetMs: 0,
    },
    safety: {
      approvals: "on",
      approveAll: false,
      readRoots: [],
      writeRoots: [],
      allowedPaths: [],
      network: "ask",
      bashSandbox: false,
      sandboxNetwork: false,
      bashTimeoutMs: 120_000,
      toolOutputChars: 30_000,
      readMaxBytes: 400_000,
      envAllowlist: [],
    },
    ui: { showThinking: false, color: true },
    session: { enabled: true, dir: join(home, "sessions") },
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`config: ${name} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
  }
  return value as T;
}

function num(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`config: ${name} must be a number`);
  }
  return Math.min(max, Math.max(min, value));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function strArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`config: ${name} must be an array of strings`);
  }
  return value as string[];
}

export function normalizeBaseUrl(input: string): string {
  let u = input.trim();
  if (!u) throw new Error("config: provider.baseUrl is empty");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/+$/, "");
  u = u.replace(/\/v1\/(chat\/completions|completions)$/i, "");
  // Codex is not an OpenAI `/v1` API; its Responses endpoint lives under
  // /backend-api/codex/responses.
  if (/\/backend-api(?:\/codex)?$/i.test(u)) return u;
  if (!/\/v\d+$/i.test(u)) {
    u = u.replace(/\/(chat\/completions|completions)$/i, "");
    u = `${u}/v1`;
  }
  return u;
}

export function stopSequences(cfg: Config): string[] {
  if (cfg.prompt.stop.length > 0) return cfg.prompt.stop;
  return cfg.prompt.template === "chatml"
    ? ["<|im_end|>", "<|im_start|>"]
    : ["\n### User", "\n### System", "\n### Tool"];
}

function normalize(cfg: Config, cwd: string, home = harnessHome()): Config {
  cfg.cwd = cwd;
  cfg.provider.baseUrl = normalizeBaseUrl(str(cfg.provider.baseUrl, ""));
  cfg.provider.apiKey = str(cfg.provider.apiKey, "");
  cfg.provider.mode = oneOf(cfg.provider.mode, ["auto", "chat", "completions", "responses"] as const, "provider.mode");
  cfg.provider.model = str(cfg.provider.model, "default") || "default";
  cfg.provider.temperature = num(cfg.provider.temperature, "provider.temperature", 0, 2, 0.2);
  cfg.provider.maxTokens = Math.floor(num(cfg.provider.maxTokens, "provider.maxTokens", 1, 1_000_000, 16384));
  cfg.provider.contextWindow = Math.floor(num(cfg.provider.contextWindow, "provider.contextWindow", 1024, 10_000_000, 32768));
  cfg.provider.contextWindowReported = false;
  cfg.provider.contextWindowFallback = cfg.provider.contextWindow;
  cfg.provider.timeoutMs = Math.floor(num(cfg.provider.timeoutMs, "provider.timeoutMs", 1000, 3_600_000, 600_000));
  cfg.provider.retries = Math.floor(num(cfg.provider.retries, "provider.retries", 0, 8, 2));
  if (!isRecord(cfg.provider.headers)) throw new Error("config: provider.headers must be an object");
  if (!isRecord(cfg.provider.extraBody)) throw new Error("config: provider.extraBody must be an object");
  if (!isRecord(cfg.provider.modelEfforts)) throw new Error("config: provider.modelEfforts must be an object");
  const modelEfforts: Record<string, ReasoningEffort[]> = {};
  for (const [model, value] of Object.entries(cfg.provider.modelEfforts)) {
    if (!model.trim()) throw new Error("config: provider.modelEfforts keys must be model names");
    if (!Array.isArray(value) || value.some((effort) => typeof effort !== "string" || !isReasoningEffort(effort))) {
      throw new Error(`config: provider.modelEfforts.${model} must be an array of effort values`);
    }
    modelEfforts[model] = normalizeEfforts(value) ?? [];
  }
  cfg.provider.modelEfforts = modelEfforts;
  cfg.provider.totalTokenBudget = Math.floor(num(cfg.provider.totalTokenBudget, "provider.totalTokenBudget", 0, 1_000_000_000, 0));
  cfg.provider.promptTokenBudget = Math.floor(num(cfg.provider.promptTokenBudget, "provider.promptTokenBudget", 0, 1_000_000_000, 0));

  cfg.reasoning.effort = oneOf(
    cfg.reasoning.effort,
    ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const,
    "reasoning.effort",
  );

  cfg.prompt.template = oneOf(cfg.prompt.template, ["chatml", "plain"] as const, "prompt.template");
  cfg.prompt.thinkingControl = oneOf(cfg.prompt.thinkingControl, ["none", "qwen"] as const, "prompt.thinkingControl");
  cfg.prompt.systemSuffix = str(cfg.prompt.systemSuffix, "");
  cfg.prompt.stop = strArray(cfg.prompt.stop, "prompt.stop");
  if (
    !Array.isArray(cfg.prompt.thinkingTags) ||
    cfg.prompt.thinkingTags.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((x) => typeof x !== "string" || !x))
  ) {
    throw new Error("config: prompt.thinkingTags must be [[start, end], ...]");
  }

  cfg.loop.maxStepsCap = Math.floor(num(cfg.loop.maxStepsCap, "loop.maxStepsCap", 1, 10_000, 100));
  cfg.loop.defaultMaxSteps = Math.floor(num(cfg.loop.defaultMaxSteps, "loop.defaultMaxSteps", 1, cfg.loop.maxStepsCap, 40));
  cfg.loop.maxToolCallsPerStep = Math.floor(num(cfg.loop.maxToolCallsPerStep, "loop.maxToolCallsPerStep", 1, 64, 16));
  cfg.loop.compactAtPct = num(cfg.loop.compactAtPct, "loop.compactAtPct", 0.3, 0.95, 0.95);
  cfg.loop.keepRecentMessages = Math.floor(num(cfg.loop.keepRecentMessages, "loop.keepRecentMessages", 2, 100, 10));
  cfg.loop.changes = oneOf(cfg.loop.changes, ["auto", "approve"] as const, "loop.changes");
  cfg.loop.maxSubagentDepth = Math.floor(num(cfg.loop.maxSubagentDepth, "loop.maxSubagentDepth", 0, 4, 2));
  cfg.loop.maxParallelSubagents = Math.floor(num(cfg.loop.maxParallelSubagents, "loop.maxParallelSubagents", 1, 8, 2));
  cfg.loop.maxChildAgents = Math.floor(num(cfg.loop.maxChildAgents, "loop.maxChildAgents", 0, 1000, 8));
  cfg.loop.runTimeBudgetMs = Math.floor(num(cfg.loop.runTimeBudgetMs, "loop.runTimeBudgetMs", 0, 86_400_000, 0));
  if (!isRecord(cfg.loop.defaultSpec)) throw new Error("config: loop.defaultSpec must be an object");

  cfg.safety.approvals = oneOf(cfg.safety.approvals, ["on", "off"] as const, "safety.approvals");
  cfg.safety.approveAll = bool(cfg.safety.approveAll, false);
  cfg.safety.network = oneOf(cfg.safety.network, ["ask", "allow", "deny"] as const, "safety.network");
  cfg.safety.bashSandbox = bool(cfg.safety.bashSandbox, false);
  cfg.safety.sandboxNetwork = bool(cfg.safety.sandboxNetwork, false);
  cfg.safety.bashTimeoutMs = Math.floor(num(cfg.safety.bashTimeoutMs, "safety.bashTimeoutMs", 1000, 3_600_000, 120_000));
  cfg.safety.toolOutputChars = Math.floor(num(cfg.safety.toolOutputChars, "safety.toolOutputChars", 1000, 1_000_000, 30_000));
  cfg.safety.readMaxBytes = Math.floor(num(cfg.safety.readMaxBytes, "safety.readMaxBytes", 1000, 50_000_000, 400_000));
  cfg.safety.readRoots = strArray(cfg.safety.readRoots, "safety.readRoots").map((p) => resolve(cwd, expandHome(p)));
  cfg.safety.writeRoots = strArray(cfg.safety.writeRoots, "safety.writeRoots").map((p) => resolve(cwd, expandHome(p)));
  cfg.safety.allowedPaths = strArray(cfg.safety.allowedPaths, "safety.allowedPaths").map((p) => resolve(cwd, expandHome(p)));
  cfg.safety.envAllowlist = strArray(cfg.safety.envAllowlist, "safety.envAllowlist") as string[];

  cfg.ui.showThinking = bool(cfg.ui.showThinking, false);
  cfg.ui.color = bool(cfg.ui.color, true) && !process.env.NO_COLOR;

  cfg.session.enabled = bool(cfg.session.enabled, true);
  const configuredSessionDir = str(cfg.session.dir, join(home, "sessions"));
  // Treat the old project-local default as the new central default.
  const sessionDir = configuredSessionDir === ".harness2/sessions" ? join(home, "sessions") : configuredSessionDir;
  cfg.session.dir = resolve(cwd, expandHome(sessionDir));

  return cfg;
}

function envPatch(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const prov: Record<string, unknown> = {};
  const loop: Record<string, unknown> = {};
  const safety: Record<string, unknown> = {};
  const provider: Record<string, unknown> = {};
  if (env.HARNESS2_BASE_URL || env.OPENAI_BASE_URL) provider.baseUrl = env.HARNESS2_BASE_URL || env.OPENAI_BASE_URL;
  if (env.HARNESS2_API_KEY || env.OPENAI_API_KEY) provider.apiKey = env.HARNESS2_API_KEY || env.OPENAI_API_KEY;
  if (env.HARNESS2_MODEL) provider.model = env.HARNESS2_MODEL;
  if (env.HARNESS2_MODE) provider.mode = env.HARNESS2_MODE;
  if (env.HARNESS2_TEMPERATURE) provider.temperature = Number(env.HARNESS2_TEMPERATURE);
  if (env.HARNESS2_MAX_TOKENS) provider.maxTokens = Number(env.HARNESS2_MAX_TOKENS);
  if (env.HARNESS2_CONTEXT_WINDOW) provider.contextWindow = Number(env.HARNESS2_CONTEXT_WINDOW);
  if (Object.keys(provider).length) prov.provider = provider;
  if (env.HARNESS2_REASONING_EFFORT) patch.reasoning = { effort: env.HARNESS2_REASONING_EFFORT };
  if (env.HARNESS2_MAX_STEPS) loop.maxStepsCap = Number(env.HARNESS2_MAX_STEPS);
  if (Object.keys(loop).length) prov.loop = loop;
  if (env.HARNESS2_SANDBOX) safety.bashSandbox = /^(1|true|yes)$/i.test(env.HARNESS2_SANDBOX);
  if (env.HARNESS2_SANDBOX_NETWORK) safety.sandboxNetwork = /^(1|true|yes)$/i.test(env.HARNESS2_SANDBOX_NETWORK);
  if (env.HARNESS2_NETWORK) safety.network = env.HARNESS2_NETWORK;
  if (Object.keys(safety).length) prov.safety = safety;
  return { ...prov, ...patch };
}

function readConfigFile(path: string): unknown | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read config ${path}: ${(e as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch (e) {
    throw new Error(`invalid JSON in config ${path}: ${(e as Error).message}`);
  }
}

/** Remove host-owned fields from an untrusted (project) config. */
export function withoutHostOwned(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const out = structuredClone(input) as Record<string, unknown>;
  for (const path of HOST_OWNED_PATHS) {
    const parts = path.split(".");
    let obj: Record<string, unknown> | undefined = out;
    for (const part of parts.slice(0, -1)) {
      const next: unknown = obj?.[part];
      obj = isRecord(next) ? next : undefined;
      if (!obj) break;
    }
    if (obj) delete obj[parts[parts.length - 1]];
  }
  return out;
}

function trustedConfigPaths(cwd: string, opts: LoadConfigOptions, env: NodeJS.ProcessEnv): string[] {
  if (opts.configPath) return [resolve(cwd, expandHome(opts.configPath))];
  return [join(harnessHome(env), "config.json")];
}

export async function loadConfig(cwd: string, opts: LoadConfigOptions = {}): Promise<Config> {
  const env = opts.env ?? process.env;
  const home = harnessHome(env);
  const projectPath = join(cwd, ".harness2", "config.json");
  let cfg = defaultConfig(cwd, home);

  for (const path of trustedConfigPaths(cwd, opts, env)) {
    const parsed = readConfigFile(path);
    if (parsed === undefined) {
      if (opts.configPath) throw new Error(`config not found: ${path}`);
      continue;
    }
    cfg = merge(cfg, parsed);
  }

  if (!opts.configPath) {
    // A project file overrides the shared ~/.harness2/config.json for workflow
    // preferences. Safety and hard caps remain host-owned and cannot be
    // granted by a project the model can write.
    const project = readConfigFile(projectPath);
    if (project !== undefined) cfg = merge(cfg, withoutHostOwned(project));
  }

  cfg = merge(cfg, opts.hostConfig);
  cfg = merge(cfg, envPatch(env));
  cfg = merge(cfg, opts.patch ?? {});
  return normalize(cfg, cwd, home);
}
