import type { Conversation } from "../loop/state.ts";
import type { ToolCall, ToolSpec } from "../types.ts";
import { errorMessage } from "../util.ts";
import { fsTools } from "./fs.ts";
import { bashTools } from "./bash.ts";
import { fetchTools } from "./fetch.ts";
import { todoTools } from "./todo.ts";
import { loopTools } from "./loop.ts";
import type { ToolContext, ToolImpl, ToolOutcome } from "./types.ts";
import { failure } from "./types.ts";

const ALWAYS_AVAILABLE = new Set(["loop_inspect", "loop_set", "loop_halt", "loop_stage", "loop_note"]);

export const ALL_TOOLS: ToolImpl[] = [...fsTools, ...bashTools, ...fetchTools, ...todoTools, ...loopTools];

export const TOOL_MAP: Map<string, ToolImpl> = new Map(ALL_TOOLS.map((t) => [t.spec.name, t]));
export const ALL_TOOL_SPECS: ToolSpec[] = ALL_TOOLS.map((t) => t.spec);

function stageTools(conv: Conversation): Set<string> | null {
  const stage = conv.spec.stages[conv.stageIndex];
  return stage?.tools ? new Set(stage.tools) : null;
}

export function isToolAllowed(conv: Conversation, name: string): boolean {
  const policy = conv.spec.toolPolicy;
  if (policy.deny?.includes(name)) return false;
  if (!TOOL_MAP.has(name)) return false;
  if (ALWAYS_AVAILABLE.has(name)) return true;
  if (policy.allow?.length && !policy.allow.includes(name)) return false;
  const stage = stageTools(conv);
  if (stage && !stage.has(name)) return false;
  return true;
}

export function toolSpecsFor(conv: Conversation): ToolSpec[] {
  return ALL_TOOLS.filter((t) => isToolAllowed(conv, t.spec.name)).map((t) => t.spec);
}

export async function dispatchTool(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  if (call.argError) return failure(`invalid tool call: ${call.argError}`);
  const tool = TOOL_MAP.get(call.name);
  if (!tool) {
    const available = ALL_TOOLS.filter((t) => isToolAllowed(ctx.conv, t.spec.name)).map((t) => t.spec.name);
    return failure(`unknown tool "${call.name}". Available: ${available.join(", ")}`);
  }
  if (!isToolAllowed(ctx.conv, call.name)) {
    return failure(`tool "${call.name}" is not allowed by the current loop spec`);
  }
  try {
    return await tool.execute(call.args, ctx, call.id);
  } catch (e) {
    return failure(`tool ${call.name} failed: ${errorMessage(e)}`);
  }
}
