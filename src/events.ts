import type { LoopSpec } from "./loop/spec.ts";
import type { TodoItem, ToolCall, Usage } from "./types.ts";

export type ApprovalKind = "read" | "write" | "network" | "bash" | "loop" | "ask";

export type EventPayload =
  | { t: "session.start"; id: string; cwd: string; model: string; mode: string; version: string }
  | { t: "session.resume"; path: string }
  | { t: "session.clear" }
  | { t: "user.message"; text: string; synthetic?: boolean }
  | { t: "assistant.thinking.delta"; text: string }
  | { t: "assistant.text.delta"; text: string }
  | { t: "assistant.message"; text: string; thinking: string; toolCalls: ToolCall[]; synthetic?: boolean }
  | { t: "tool.call"; id: string; name: string; args: Record<string, unknown> }
  | { t: "tool.output.delta"; id: string; name: string; text: string }
  | { t: "tool.result"; id: string; name: string; ok: boolean; output: string; meta?: Record<string, unknown> }
  | { t: "loop.spec"; spec: LoopSpec; by: "model" | "user"; reason: string }
  | { t: "loop.stage"; id: string; index: number; total: number; step: number }
  | { t: "loop.note"; text: string }
  | { t: "loop.nudge"; text: string }
  | { t: "loop.spawn"; child: string; name: string; task: string }
  | { t: "loop.spawn.result"; child: string; ok: boolean; output: string }
  | { t: "todo"; items: TodoItem[] }
  | { t: "compaction"; beforeMessages: number; afterMessages: number; beforeTokens: number; afterTokens: number; summary: string }
  | { t: "approval.request"; id: string; kind: ApprovalKind; title: string; detail?: string }
  | { t: "approval.result"; id: string; decision: string; reason?: string }
  | { t: "usage"; usage: Usage; tokensPerSec?: number; elapsedMs: number; step: number; reported?: boolean }
  | { t: "provider"; mode: string; detail?: string }
  | { t: "notice"; message: string; level?: "info" | "warn" }
  | { t: "error"; message: string; retryable?: boolean }
  | { t: "done"; reason: "completed" | "halted" | "max_steps" | "aborted" | "error"; answer?: string };

export type Event = EventPayload & {
  seq: number;
  ts: string;
  stream: string;
};

export type Emit = (stream: string, payload: EventPayload) => void;

export class EventBus {
  #seq = 0;
  #subs = new Set<(ev: Event) => void>();

  emit: Emit = (stream, payload) => {
    const ev = {
      seq: ++this.#seq,
      ts: new Date().toISOString(),
      stream,
      ...payload,
    } as Event;
    for (const fn of this.#subs) {
      try {
        fn(ev);
      } catch {
        // a broken subscriber must not break the agent
      }
    }
  };

  subscribe(fn: (ev: Event) => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }
}

export const DELTA_EVENTS = new Set(["assistant.thinking.delta", "assistant.text.delta", "tool.output.delta"]);
