import type { Msg, TodoItem } from "../types.ts";
import type { RunBudget } from "./budget.ts";
import type { LoopSpec } from "./spec.ts";

export type LoopMutation =
  | {
      kind: "spec";
      spec: LoopSpec;
      reason: string;
      by: "model" | "user";
      /** Version observed when the mutation was staged. */
      expectedVersion: number;
    }
  | { kind: "stage"; stage: string; expectedVersion: number };

export type StageToolRecord = { name: string; ok: boolean; output: string };

export type Conversation = {
  id: string;
  name: string;
  depth: number;
  messages: Msg[];
  spec: LoopSpec;
  stageIndex: number;
  runStep: number;
  stageSteps: number;
  notes: string[];
  todos: TodoItem[];
  changedFiles: Set<string>;
  stageTools: StageToolRecord[];
  lastToolOutput: string;
  usage: { prompt: number; completion: number };
  /** Provider-reported prompt tokens for the most recent request. */
  contextTokens: number;
  /** Whether contextTokens came from provider usage rather than an estimate. */
  contextReported: boolean;
  /** Validated loop changes staged by tools; committed once after the batch. */
  pendingMutations: LoopMutation[];
  /** Mutation counter bumped whenever a committed spec/stage changes. */
  specVersion: number;
  /** Root conversation shares this ledger with every descendant. */
  budget: RunBudget;
  halt?: { answer: string };
  createdAt: number;
};

export function newConversation(
  id: string,
  name: string,
  depth: number,
  spec: LoopSpec,
  budget: RunBudget,
): Conversation {
  return {
    id,
    name,
    depth,
    messages: [],
    spec,
    stageIndex: 0,
    runStep: 0,
    stageSteps: 0,
    notes: [],
    todos: [],
    changedFiles: new Set(),
    stageTools: [],
    lastToolOutput: "",
    usage: { prompt: 0, completion: 0 },
    contextTokens: 0,
    contextReported: false,
    pendingMutations: [],
    specVersion: 0,
    budget,
    createdAt: Date.now(),
  };
}
