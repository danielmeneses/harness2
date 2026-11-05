import type { Config } from "../config.ts";
import type { Emit } from "../events.ts";
import type { Conversation } from "../loop/state.ts";
import type { ToolSpec } from "../types.ts";
import type { Approvals } from "../safety/approvals.ts";
import type { PathGuard } from "../safety/paths.ts";
import { truncateMiddle } from "../util.ts";

export type ToolOutcome = {
  ok: boolean;
  output: string;
  meta?: Record<string, unknown>;
};

export type ToolContext = {
  cfg: Config;
  guard: PathGuard;
  approvals: Approvals;
  conv: Conversation;
  signal: AbortSignal;
  emit: Emit;
  spawn?: (task: string, spec?: Record<string, unknown>, name?: string) => Promise<string>;
  runCommand?: (command: string, timeoutMs: number) => Promise<{ exitCode: number; output: string }>;
};

export type ToolImpl = {
  spec: ToolSpec;
  execute(args: Record<string, unknown>, ctx: ToolContext, callId: string): Promise<ToolOutcome>;
};

export function capOutput(text: string, max: number): string {
  return truncateMiddle(text, max);
}

export function denied(reason: string): ToolOutcome {
  return { ok: false, output: `DENIED: ${reason}` };
}

export function failure(message: string): ToolOutcome {
  return { ok: false, output: message };
}
