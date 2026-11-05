import type { Config } from "../config.ts";
import type { Emit } from "../events.ts";
import { buildStateMessage, buildSystemPrompt } from "../prompt/system.ts";
import type { Msg, Provider, ToolCall, TurnResult, Usage } from "../types.ts";
import type { Approvals } from "../safety/approvals.ts";
import type { PathGuard } from "../safety/paths.ts";
import { newConversation, type Conversation } from "./state.ts";
import { RunBudget } from "./budget.ts";
import { defaultSpec, describePredicate, normalizeSpec, stageIndex, type LoopSpec } from "./spec.ts";
import { commitMutations } from "../tools/loop.ts";
import type { SpecLimits } from "./limits.ts";
import { evalPredicate, type PredicateCtx } from "./predicates.ts";
import { ALL_TOOL_SPECS, dispatchTool, isToolAllowed, toolSpecsFor } from "../tools/index.ts";
import { bashTool } from "../tools/bash.ts";

import { capOutput, failure, type ToolContext, type ToolOutcome } from "../tools/types.ts";
import { errorMessage, estimateTokens, hashString, isAbortError, truncateMiddle } from "../util.ts";

export type RunReason = "completed" | "halted" | "max_steps" | "aborted" | "error";

export type RunResult = {
  answer: string;
  reason: RunReason;
  error?: string;
  usage: { prompt: number; completion: number };
  conversation: Conversation;
};

export type RunnerDeps = {
  cfg: Config;
  provider: Provider;
  approvals: Approvals;
  guard: PathGuard;
  emit: Emit;
  agentsMd: string;
};

const RETRY_SAFE = new Set(["read", "ls", "glob", "grep", "fetch"]);
/** Hard safety net: never let the next request start above 95% of the context window. */
const COMPACT_CEILING = 0.95;
/** Consecutive truncated/empty turns before stopping with a clear error. */
const MAX_STALLS = 3;

const SUMMARY_SYSTEM = [
  "You compress a coding-agent transcript so the work can continue in a fresh context.",
  "Preserve: the user's goal, the current plan, decisions and their reasons, files created or changed, commands run and their relevant outcomes, open problems, and anything the next step must not forget.",
  "Drop: small talk, redundant tool output, and thinking that led nowhere.",
  "Be concrete and concise. Use short sections. Do not invent anything.",
].join("\n");

function transcript(messages: Msg[], maxChars: number): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.synthetic && m.content.startsWith("[harness loop state]")) continue;
    if (m.role === "user") parts.push(`[user]\n${m.content}`);
    else if (m.role === "assistant") {
      parts.push(
        `[assistant]\n${m.content}${m.toolCalls?.length ? `\n(tool calls: ${m.toolCalls.map((c) => c.name).join(", ")})` : ""}`,
      );
    } else {
      parts.push(`[tool ${m.name} ${m.ok ? "ok" : "failed"}]\n${m.content.slice(0, 3000)}`);
    }
  }
  return truncateMiddle(parts.join("\n\n"), maxChars);
}

function readHalt(conv: Conversation): { answer: string } | undefined {
  return conv.halt;
}

export class Runner {
  #cfg: Config;
  #provider: Provider;
  #approvals: Approvals;
  #guard: PathGuard;
  #emit: Emit;
  #agentsMd: string;
  #running = new Set<string>();
  #lastSystemHash = "";
  #childSeq = 0;
  #activeChildren = 0;

  constructor(deps: RunnerDeps) {
    this.#cfg = deps.cfg;
    this.#provider = deps.provider;
    this.#approvals = deps.approvals;
    this.#guard = deps.guard;
    this.#emit = deps.emit;
    this.#agentsMd = deps.agentsMd;
  }

  get provider(): Provider {
    return this.#provider;
  }

  setProvider(provider: Provider): void {
    this.#provider = provider;
  }

  #limits(): SpecLimits {
    return { maxStepsCap: this.#cfg.loop.maxStepsCap, contextWindow: this.#cfg.provider.contextWindow };
  }

  createConversation(id = "main", name = "main", depth = 0): Conversation {
    let spec = defaultSpec(this.#limits());
    spec.maxSteps = Math.min(this.#cfg.loop.defaultMaxSteps, this.#cfg.loop.maxStepsCap);
    if (Object.keys(this.#cfg.loop.defaultSpec).length) {
      spec = normalizeSpec(this.#cfg.loop.defaultSpec, this.#limits(), spec);
    }
    const conv = newConversation(id, name, depth, spec, new RunBudget(this.#cfg));
    conv.stageIndex = stageIndex(spec, spec.startStage);
    return conv;
  }

  async run(conv: Conversation, prompt?: string, opts: { signal?: AbortSignal } = {}): Promise<RunResult> {
    if (this.#running.has(conv.id)) throw new Error(`conversation ${conv.id} is already running`);
    this.#running.add(conv.id);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await this.#loop(conv, prompt, ac.signal);
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      this.#running.delete(conv.id);
    }
  }

  async #loop(conv: Conversation, prompt: string | undefined, signal: AbortSignal): Promise<RunResult> {
    const cfg = this.#cfg;
    if (!conv.spec.stages.length) conv.spec = defaultSpec(this.#limits());
    if (conv.stageIndex < 0 || conv.stageIndex >= conv.spec.stages.length) conv.stageIndex = 0;
    conv.runStep = 0;
    conv.stageSteps = 0;
    conv.stageTools = [];
    conv.lastToolOutput = "";
    conv.halt = undefined;
    conv.pendingMutations = [];

    let stage = conv.spec.stages[conv.stageIndex];
    this.#emit(conv.id, { t: "loop.stage", id: stage.id, index: conv.stageIndex, total: conv.spec.stages.length, step: 0 });

    if (prompt && prompt.trim()) {
      conv.messages.push({ role: "user", content: prompt });
      this.#emit(conv.id, { t: "user.message", text: prompt });
    }

    let lastText = "";
    let stalls = 0;
    for (conv.runStep = 1; conv.runStep <= conv.spec.maxSteps; conv.runStep++) {
      if (signal.aborted) return this.#done(conv, "aborted", lastText);

      conv.stageSteps++;
      stage = conv.spec.stages[conv.stageIndex] ?? conv.spec.stages[0];
      if (stage.maxSteps && conv.stageSteps > stage.maxSteps) {
        if (conv.stageIndex < conv.spec.stages.length - 1) {
          conv.stageIndex++;
          conv.stageSteps = 0;
          conv.stageTools = [];
          stage = conv.spec.stages[conv.stageIndex];
          this.#emit(conv.id, { t: "loop.stage", id: stage.id, index: conv.stageIndex, total: conv.spec.stages.length, step: conv.runStep });
          continue;
        }
        this.#emit(conv.id, { t: "notice", message: `stage "${stage.id}" reached its step limit`, level: "warn" });
        return this.#done(conv, "max_steps", lastText);
      }

      try {
        await this.#maybeCompact(conv, signal);
      } catch (e) {
        if (signal.aborted || isAbortError(e)) return this.#done(conv, "aborted", lastText);
        this.#emit(conv.id, { t: "notice", message: `compaction skipped: ${errorMessage(e)}`, level: "warn" });
      }
      if (signal.aborted) return this.#done(conv, "aborted", lastText);
      if (conv.budget.blocked) {
        const reason = conv.budget.reason;
        this.#emit(conv.id, { t: "error", message: `run budget exhausted: ${reason}` });
        return this.#done(conv, "max_steps", lastText, `budget exhausted: ${reason}`);
      }
      const activeTools = toolSpecsFor(conv).map((t) => t.name);
      const state = buildStateMessage(conv, activeTools);
      conv.messages.push({ role: "user", content: state, synthetic: true });
      this.#emit(conv.id, { t: "user.message", text: state, synthetic: true });

      const tools = ALL_TOOL_SPECS;
      const system = buildSystemPrompt({ cfg, tools, agentsMd: this.#agentsMd });
      const systemHash = hashString(system);
      if (this.#lastSystemHash && this.#lastSystemHash !== systemHash) {
        this.#emit(conv.id, {
          t: "notice",
          message: "system prompt changed; this step starts a new cache prefix",
          level: "info",
        });
      }
      this.#lastSystemHash = systemHash;
      const promptTokens =
        estimateTokens(system) +
        estimateTokens(JSON.stringify(tools)) +
        estimateTokens(JSON.stringify(conv.messages));
      const started = Date.now();
      const sampling = conv.spec.sampling ?? {};
      const configuredMax = sampling.maxTokens ?? cfg.provider.maxTokens;
      const reserve = Math.max(512, Math.floor(cfg.provider.contextWindow * 0.05));
      const maxOutputTokens = Math.max(1, Math.min(configuredMax, cfg.provider.contextWindow - promptTokens - reserve));

      let turn: TurnResult;
      try {
        turn = await this.#provider.stream({
          system,
          messages: conv.messages,
          tools,
          reasoningEffort: cfg.reasoning.effort,
          temperature: sampling.temperature,
          topP: sampling.topP,
          maxTokens: maxOutputTokens,
          signal,
          onText: (text) => this.#emit(conv.id, { t: "assistant.text.delta", text }),
          onThinking: (text) => this.#emit(conv.id, { t: "assistant.thinking.delta", text }),
          onNotice: (message) => this.#emit(conv.id, { t: "notice", message }),
        });
      } catch (e) {
        if (signal.aborted || isAbortError(e)) return this.#done(conv, "aborted", lastText);
        const message = errorMessage(e);
        this.#emit(conv.id, { t: "error", message });
        return this.#done(conv, "error", lastText, message);
      }

      if (signal.aborted) return this.#done(conv, "aborted", lastText);

      const finishReason = (turn.finishReason ?? "").toLowerCase();
      const truncated = finishReason === "length" || finishReason === "max_tokens";
      const blocked = finishReason === "content_filter" || finishReason === "sensitive" || finishReason === "refusal";
      // Never execute arguments from a response cut off by the token limit.
      const toolCalls = truncated ? [] : turn.toolCalls;
      if (turn.text.trim()) lastText = turn.text;
      conv.messages.push({
        role: "assistant",
        content: turn.text,
        thinking: turn.thinking || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      });
      this.#emit(conv.id, {
        t: "assistant.message",
        text: turn.text,
        thinking: turn.thinking,
        toolCalls,
      });

      const completionTokens = turn.usage?.completionTokens ?? estimateTokens(turn.text + turn.thinking);
      const usage: Usage = turn.usage ?? {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
      conv.usage.prompt += usage.promptTokens ?? promptTokens;
      conv.usage.completion += usage.completionTokens ?? completionTokens;
      conv.budget.recordTurn(usage.promptTokens ?? promptTokens, completionTokens);
      conv.contextTokens = usage.promptTokens ?? promptTokens;
      conv.contextReported = turn.usage?.promptTokens !== undefined;
      const elapsedMs = Math.max(1, Date.now() - started);
      this.#emit(conv.id, {
        t: "usage",
        usage,
        tokensPerSec: completionTokens / (elapsedMs / 1000),
        elapsedMs,
        step: conv.runStep,
        reported: conv.contextReported,
      });

      if (blocked) {
        const message = `model stopped with finish_reason "${finishReason}"`;
        this.#emit(conv.id, { t: "error", message });
        return this.#done(conv, "error", lastText, message);
      }
      if (truncated || (!turn.text.trim() && !toolCalls.length)) {
        stalls++;
        const why = truncated
          ? `response hit the ${maxOutputTokens}-token output limit`
          : "response contained no text and no tool calls";
        if (stalls >= MAX_STALLS) {
          const message = `model made no progress for ${stalls} turns (${why}); raise --max-tokens (currently ${maxOutputTokens}) or lower the reasoning effort`;
          this.#emit(conv.id, { t: "error", message });
          return this.#done(conv, "error", lastText, message);
        }
        this.#emit(conv.id, { t: "notice", message: `${why}; asking the model to continue`, level: "warn" });
        this.#nudge(
          conv,
          truncated
            ? "The previous response was cut off at the output token limit. Continue exactly where it stopped, taking a smaller next step if needed. Do not repeat work that is already done."
            : "The previous turn produced no visible answer and no tool calls. Continue the task now with a tool call or a complete final answer.",
        );
        continue;
      }
      stalls = 0;

      if (toolCalls.length) {
        const results = await this.#executeBatch(conv, toolCalls, signal);
        // Mutations were validated and staged by the tools; commit them once,
        // deterministically, after the whole batch has finished.
        const applied = commitMutations(conv);
        if (applied.spec) {
          this.#emit(conv.id, {
            t: "loop.spec",
            spec: conv.spec,
            by: applied.by ?? "model",
            reason: applied.reason ?? "loop change",
          });
        }
        if (applied.spec || applied.stage) {
          conv.stageSteps = 0;
          conv.stageTools = [];
          const s = conv.spec.stages[conv.stageIndex];
          if (s) this.#emit(conv.id, { t: "loop.stage", id: s.id, index: conv.stageIndex, total: conv.spec.stages.length, step: conv.runStep });
        }

        if (signal.aborted) return this.#done(conv, "aborted", lastText);
        const halted = readHalt(conv);
        if (halted) {
          const answer = halted.answer;
          conv.messages.push({ role: "assistant", content: answer, synthetic: true });
          this.#emit(conv.id, { t: "assistant.message", text: answer, thinking: "", toolCalls: [], synthetic: true });
          return this.#done(conv, "halted", answer);
        }
        if (conv.spec.onToolError === "halt") {
          const failed = results.find((r) => !r.ok);
          if (failed) {
            this.#emit(conv.id, { t: "error", message: `tool failed; stopping because onToolError=halt: ${failed.output.slice(0, 500)}` });
            return this.#done(conv, "error", lastText, "tool failed");
          }
        }
        continue;
      }

      const predCtx = this.#predicateCtx(conv, true, signal);
      const exitOk = await evalPredicate(stage.exitWhen ?? { modelStopped: true }, predCtx);
      if (!exitOk) {
        this.#nudge(conv, `Stage exit condition is not met: ${describePredicate(stage.exitWhen)}. Continue working.`);
        continue;
      }

      if (conv.stageIndex < conv.spec.stages.length - 1) {
        conv.stageIndex++;
        conv.stageSteps = 0;
        conv.stageTools = [];
        const next = conv.spec.stages[conv.stageIndex];
        this.#emit(conv.id, { t: "loop.stage", id: next.id, index: conv.stageIndex, total: conv.spec.stages.length, step: conv.runStep });
        this.#nudge(conv, `Stage "${next.id}" begins. Goal: ${next.goal || "(none)"}`);
        continue;
      }

      const finishOk = await evalPredicate(conv.spec.finish, predCtx);
      if (finishOk) {
        return this.#done(conv, "completed", turn.text || lastText);
      }
      this.#nudge(conv, `Finish condition is not met: ${describePredicate(conv.spec.finish)}. Continue working.`);
    }

    this.#emit(conv.id, { t: "notice", message: `step limit reached (${conv.spec.maxSteps})`, level: "warn" });
    return this.#done(conv, "max_steps", lastText);
  }

  #nudge(conv: Conversation, text: string): void {
    conv.messages.push({ role: "user", content: text, synthetic: true });
    this.#emit(conv.id, { t: "loop.nudge", text });
    this.#emit(conv.id, { t: "user.message", text, synthetic: true });
  }

  #predicateCtx(conv: Conversation, modelStopped: boolean, signal: AbortSignal): PredicateCtx {
    const shellCtx: ToolContext = {
      cfg: this.#cfg,
      guard: this.#guard,
      approvals: this.#approvals,
      conv,
      signal,
      emit: this.#emit,
    };
    return {
      cwd: this.#cfg.cwd,
      modelStopped,
      stageTools: conv.stageTools,
      stageSteps: conv.stageSteps,
      changedFiles: conv.changedFiles,
      lastToolOutput: conv.lastToolOutput,
      runCommand: async (command, timeoutMs) => {
        return this.#predicateCommand(conv, command, timeoutMs, shellCtx);
      },
    };
  }

  /**
   * Predicate commands are model-authored operations: they go through the same
   * loop policy, approval gate, output cap, and event stream as a `bash` tool
   * call instead of running as an unlogged side channel.
   */
  async #predicateCommand(
    conv: Conversation,
    command: string,
    timeoutMs: number,
    ctx: ToolContext,
  ): Promise<{ exitCode: number; output: string }> {
    const allowed = isToolAllowed(conv, "bash");
    const callId = `predicate:${conv.runStep}:${conv.specVersion}:${Math.random().toString(36).slice(2, 8)}`;
    const call: ToolCall = { id: callId, name: "bash", args: { command, timeoutMs } };
    this.#emit(conv.id, { t: "tool.call", id: callId, name: "bash", args: { command, timeoutMs, predicate: true } });
    let outcome: ToolOutcome;
    if (!allowed) {
      outcome = failure(`tool "bash" is not allowed by the current loop spec; predicate command skipped`);
    } else {
      outcome = await bashTool.execute(call.args, ctx, callId);
    }
    const capped = capOutput(outcome.output, this.#cfg.safety.toolOutputChars);
    conv.stageTools.push({ name: "bash", ok: outcome.ok, output: capped.slice(0, 2000) });
    conv.lastToolOutput = capped;
    conv.messages.push({ role: "tool", toolCallId: callId, name: "bash", content: capped, ok: outcome.ok });
    this.#emit(conv.id, { t: "tool.result", id: callId, name: "bash", ok: outcome.ok, output: capped, meta: { ...outcome.meta, predicate: true } });
    const exitCode = typeof outcome.meta?.exitCode === "number" ? outcome.meta.exitCode : outcome.ok ? 0 : 1;
    return { exitCode, output: capped };
  }

  async #executeBatch(conv: Conversation, calls: ToolCall[], signal: AbortSignal): Promise<ToolOutcome[]> {
    const cfg = this.#cfg;
    const max = cfg.loop.maxToolCallsPerStep;
    const keep = calls.slice(0, max);
    const dropped = calls.slice(max);
    for (const call of [...keep, ...dropped]) {
      this.#emit(conv.id, { t: "tool.call", id: call.id, name: call.name, args: call.args });
    }

    const base: ToolContext = {
      cfg,
      guard: this.#guard,
      approvals: this.#approvals,
      conv,
      signal,
      emit: this.#emit,
      spawn: (task, spec, name) => this.#spawn(conv, task, spec, name, signal),
    };

    const runOne = async (call: ToolCall): Promise<{ call: ToolCall; outcome: ToolOutcome }> => {
      let outcome = await dispatchTool(call, base);
      if (
        !outcome.ok &&
        conv.spec.onToolError === "retry" &&
        RETRY_SAFE.has(call.name) &&
        !outcome.output.startsWith("DENIED")
      ) {
        this.#emit(conv.id, { t: "notice", message: `retrying ${call.name} once after a failure` });
        outcome = await dispatchTool(call, base);
      }
      return { call, outcome };
    };

    const pairs: Array<{ call: ToolCall; outcome: ToolOutcome }> = [];
    if (conv.spec.toolPolicy.parallel && keep.length > 1) {
      pairs.push(...(await Promise.all(keep.map(runOne))));
    } else {
      for (const call of keep) pairs.push(await runOne(call));
    }

    const results: ToolOutcome[] = [];
    for (const { call, outcome } of pairs) {
      const capped: ToolOutcome = {
        ok: outcome.ok,
        output: capOutput(outcome.output, cfg.safety.toolOutputChars),
        meta: outcome.meta,
      };
      results.push(capped);
      conv.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: capped.output, ok: capped.ok });
      conv.stageTools.push({ name: call.name, ok: capped.ok, output: capped.output.slice(0, 2000) });
      conv.lastToolOutput = capped.output;
      this.#emit(conv.id, {
        t: "tool.result",
        id: call.id,
        name: call.name,
        ok: capped.ok,
        output: capped.output,
        meta: capped.meta,
      });
    }

    for (const call of dropped) {
      const output = `not executed: too many tool calls in one turn (limit ${max})`;
      results.push({ ok: false, output });
      conv.messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: output, ok: false });
      this.#emit(conv.id, { t: "tool.result", id: call.id, name: call.name, ok: false, output });
    }

    return results;
  }

  async #spawn(
    parent: Conversation,
    task: string,
    specPatch: Record<string, unknown> | undefined,
    name: string | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const cfg = this.#cfg;
    if (parent.depth + 1 > cfg.loop.maxSubagentDepth) {
      throw new Error(`subagent depth limit reached (max ${cfg.loop.maxSubagentDepth})`);
    }
    if (this.#activeChildren >= cfg.loop.maxParallelSubagents) {
      throw new Error(`too many concurrent subagents (max ${cfg.loop.maxParallelSubagents})`);
    }

    let spec: LoopSpec = defaultSpec(this.#limits());
    spec.maxSteps = Math.min(cfg.loop.defaultMaxSteps, cfg.loop.maxStepsCap);
    if (specPatch) spec = normalizeSpec(specPatch, this.#limits(), spec);
    const n = ++this.#childSeq;
    const childName = (name ?? `sub${n}`).replace(/[^\w.-]/g, "-").slice(0, 40) || `sub${n}`;
    if (!parent.budget.reserveChild()) {
      throw new Error(parent.budget.reason);
    }
    const child = newConversation(`${parent.id}.sub${n}`, childName, parent.depth + 1, spec, parent.budget);
    child.specVersion = parent.specVersion;
    child.stageIndex = stageIndex(spec, spec.startStage);
    this.#emit(parent.id, { t: "loop.spawn", child: child.id, name: childName, task });

    this.#activeChildren++;
    try {
      const res = await this.run(child, task, { signal });
      const ok = res.reason === "completed" || res.reason === "halted";
      this.#emit(parent.id, {
        t: "loop.spawn.result",
        child: child.id,
        ok,
        output: res.answer.slice(0, 2000),
      });
      if (res.reason === "error") return `Child failed: ${res.error ?? res.answer}`;
      if (res.reason === "aborted") return "Child was aborted.";
      if (res.reason === "max_steps") return `Child reached its step limit. Partial answer:\n${res.answer}`;
      return res.answer || "(child produced no final answer)";
    } finally {
      this.#activeChildren--;
    }
  }

  #done(conv: Conversation, reason: RunReason, answer: string, error?: string): RunResult {
    this.#emit(conv.id, { t: "done", reason, answer: answer || undefined });
    return { answer, reason, error, usage: { ...conv.usage }, conversation: conv };
  }

  #estimateContextTokens(conv: Conversation): number {
    const system = buildSystemPrompt({
      cfg: this.#cfg,
      tools: ALL_TOOL_SPECS,
      agentsMd: this.#agentsMd,
    });
    return (
      estimateTokens(system) +
      estimateTokens(JSON.stringify(ALL_TOOL_SPECS)) +
      estimateTokens(JSON.stringify(conv.messages))
    );
  }

  async #maybeCompact(conv: Conversation, signal: AbortSignal): Promise<void> {
    const pct = Math.min(conv.spec.compactAtPct ?? this.#cfg.loop.compactAtPct, COMPACT_CEILING);
    const threshold = pct * this.#cfg.provider.contextWindow;
    // Provider usage is authoritative for the last request; the estimate covers
    // messages appended after that request (tool results, nudges).
    const context = Math.max(conv.contextTokens, this.#estimateContextTokens(conv));
    if (context < threshold) return;
    await this.compact(conv, false, signal);
  }

  async compact(conv: Conversation, force: boolean, signal: AbortSignal): Promise<string> {
    const cfg = this.#cfg;
    if (!force && conv.messages.length <= cfg.loop.keepRecentMessages + 1) return "not enough history to compact";
    if (conv.messages.length <= 3) return "not enough history to compact";
    const beforeMessages = conv.messages.length;
    const beforeTokens = estimateTokens(JSON.stringify(conv.messages));
    const maxChars = Math.max(4000, Math.floor(cfg.provider.contextWindow * 4 * 0.5));
    const text = transcript(conv.messages, maxChars);

    if (conv.budget.blocked) throw new Error(conv.budget.reason);
    let summary = "";
    try {
      const res = await this.#provider.stream({
        system: SUMMARY_SYSTEM,
        messages: [{ role: "user", content: text }],
        tools: [],
        reasoningEffort: "auto",
        signal,
        onNotice: (message) => this.#emit(conv.id, { t: "notice", message }),
      });
      conv.budget.recordTurn(
        res.usage?.promptTokens ?? estimateTokens(text),
        res.usage?.completionTokens ?? estimateTokens(res.text),
      );
      summary = res.text.trim();
    } catch (e) {
      if (signal.aborted || isAbortError(e)) throw e;
      const message = `compaction failed: ${errorMessage(e)}`;
      this.#emit(conv.id, { t: "error", message });
      return message;
    }
    if (!summary) {
      this.#emit(conv.id, { t: "error", message: "compaction produced an empty summary; keeping history" });
      return "compaction produced no summary";
    }

    const keepCount = Math.min(cfg.loop.keepRecentMessages, Math.max(2, conv.messages.length - 2));
    const keep = conv.messages.slice(-keepCount);
    while (keep.length && keep[0].role === "tool") keep.shift();
    const summaryMsg: Msg = {
      role: "user",
      content: `[Compacted history summary]\n${summary}\n\nContinue from here.`,
      synthetic: true,
    };
    conv.messages = [summaryMsg, ...keep];
    const afterTokens = estimateTokens(JSON.stringify(conv.messages));
    conv.contextTokens = this.#estimateContextTokens(conv);
    conv.contextReported = false;
    this.#emit(conv.id, {
      t: "compaction",
      beforeMessages,
      afterMessages: conv.messages.length,
      beforeTokens,
      afterTokens,
      summary,
    });
    return `Compacted ${beforeMessages} → ${conv.messages.length} messages (~${beforeTokens} → ${afterTokens} tokens)`;
  }
}
