import { stat } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";
import type { Predicate } from "./spec.ts";

export type PredicateCtx = {
  cwd: string;
  modelStopped: boolean;
  stageTools: Array<{ name: string; ok: boolean; output: string }>;
  stageSteps: number;
  changedFiles: Set<string>;
  lastToolOutput: string;
  /** Runs through normal tool authorization, caps, and events. */
  runCommand: (cmd: string, timeoutMs: number) => Promise<{ exitCode: number; output: string }>;
};

function normRel(cwd: string, p: string): string {
  return normalize(isAbsolute(p) ? p : resolve(cwd, p));
}

export async function evalPredicate(p: Predicate | undefined, ctx: PredicateCtx): Promise<boolean> {
  if (!p) return true;
  try {
    if ("all" in p) {
      for (const sub of p.all) if (!(await evalPredicate(sub, ctx))) return false;
      return true;
    }
    if ("any" in p) {
      for (const sub of p.any) if (await evalPredicate(sub, ctx)) return true;
      return false;
    }
    if ("not" in p) return !(await evalPredicate(p.not, ctx));
    if ("modelStopped" in p) return ctx.modelStopped;
    if ("toolCalled" in p) return ctx.stageTools.some((t) => t.name === p.toolCalled);
    if ("toolOk" in p) return ctx.stageTools.some((t) => t.name === p.toolOk && t.ok);
    if ("toolFailed" in p) return ctx.stageTools.some((t) => t.name === p.toolFailed && !t.ok);
    if ("fileExists" in p) {
      const abs = normRel(ctx.cwd, p.fileExists);
      const s = await stat(abs).catch(() => null);
      return !!s && !s.isDirectory();
    }
    if ("filesChanged" in p) {
      return p.filesChanged.some((f) => ctx.changedFiles.has(normRel(ctx.cwd, f)));
    }
    if ("stepsAtLeast" in p) return ctx.stageSteps >= p.stepsAtLeast;
    if ("lastOutputMatches" in p) {
      try {
        return new RegExp(p.lastOutputMatches).test(ctx.lastToolOutput);
      } catch {
        return false;
      }
    }
    if ("command" in p) {
      const r = await ctx.runCommand(p.command, p.timeoutMs ?? 120_000);
      return r.exitCode === p.expectExit;
    }
  } catch {
    return false;
  }
  return false;
}
