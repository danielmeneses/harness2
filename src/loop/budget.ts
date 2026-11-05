import type { Config } from "../config.ts";

export type BudgetSnapshot = {
  /** Prompt+completion tokens spent by every turn in this run tree. */
  tokens: number;
  tokenLimit: number;
  /** Cumulative prompt tokens reported (or estimated) by every turn. */
  promptTokens: number;
  promptLimit: number;
  requests: number;
  /** Model turns, including compaction calls, across the tree. */
  agentTurns: number;
  children: number;
  childLimit: number;
  elapsedMs: number;
  deadlineMs: number;
  exhausted?: "tokens" | "prompt_tokens" | "deadline" | "children";
};

/**
 * A single host-owned ledger shared by a conversation and all of its children.
 * The model can allocate work within it, but cannot raise it.
 */
export class RunBudget {
  tokens = 0;
  promptTokens = 0;
  requests = 0;
  agentTurns = 0;
  children = 0;
  readonly tokenLimit: number;
  readonly promptLimit: number;
  readonly childLimit: number;
  readonly startedAt = Date.now();
  readonly deadlineMs: number;
  exhausted?: BudgetSnapshot["exhausted"];

  constructor(cfg: Config) {
    this.tokenLimit = cfg.provider.totalTokenBudget;
    this.promptLimit = cfg.provider.promptTokenBudget;
    this.childLimit = cfg.loop.maxChildAgents;
    this.deadlineMs = cfg.loop.runTimeBudgetMs;
  }

  /** Record one provider turn. */
  recordTurn(promptTokens: number, completionTokens: number): void {
    this.agentTurns++;
    this.requests++;
    this.promptTokens += Math.max(0, promptTokens);
    this.tokens += Math.max(0, promptTokens) + Math.max(0, completionTokens);
    if (!this.exhausted) {
      if (this.tokenLimit > 0 && this.tokens > this.tokenLimit) this.exhausted = "tokens";
      else if (this.promptLimit > 0 && this.promptTokens > this.promptLimit) this.exhausted = "prompt_tokens";
    }
  }

  /** Reserve a child slot; returns false when the tree's child cap is reached. */
  reserveChild(): boolean {
    if (this.childLimit > 0 && this.children >= this.childLimit) {
      this.exhausted ??= "children";
      return false;
    }
    this.children++;
    return true;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  get deadlineExceeded(): boolean {
    return this.deadlineMs > 0 && this.elapsedMs >= this.deadlineMs;
  }

  /** The tree cannot start another model turn. */
  get blocked(): boolean {
    return this.exhausted !== undefined || this.deadlineExceeded;
  }

  get reason(): string {
    if (this.exhausted === "tokens") return `token budget exhausted (${this.tokens}/${this.tokenLimit})`;
    if (this.exhausted === "prompt_tokens") return `prompt-token budget exhausted (${this.promptTokens}/${this.promptLimit})`;
    if (this.exhausted === "children") return `child-agent budget exhausted (${this.children}/${this.childLimit})`;
    if (this.deadlineExceeded) return `time budget exhausted (${this.deadlineMs}ms)`;
    return "budget available";
  }

  snapshot(): BudgetSnapshot {
    return {
      tokens: this.tokens,
      tokenLimit: this.tokenLimit,
      promptTokens: this.promptTokens,
      promptLimit: this.promptLimit,
      requests: this.requests,
      agentTurns: this.agentTurns,
      children: this.children,
      childLimit: this.childLimit,
      elapsedMs: this.elapsedMs,
      deadlineMs: this.deadlineMs,
      exhausted: this.exhausted,
    };
  }
}
