import type { Config } from "../config.ts";
import type { Msg, Provider, ProviderRequest, ToolCall, TurnResult, Usage } from "../types.ts";
import { TurnAccumulator } from "./accum.ts";
import { requestHeaders } from "./headers.ts";
import { postSSE, readSSE } from "./http.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputItems(messages: Msg[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      });
    } else if (message.role === "assistant") {
      if (message.content) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
        });
      }
    } else {
      items.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
    }
  }
  return items;
}

function mapUsage(usage: unknown): Usage | undefined {
  if (!isRecord(usage)) return undefined;
  const prompt =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : undefined;
  const completion =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined;
  const total =
    typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : prompt !== undefined || completion !== undefined
        ? (prompt ?? 0) + (completion ?? 0)
        : undefined;
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function parseToolCall(item: Record<string, unknown>): ToolCall | null {
  if (item.type !== "function_call" && item.type !== "custom_tool_call") return null;
  const id =
    typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "";
  const name = typeof item.name === "string" ? item.name : "";
  const raw = typeof item.arguments === "string" ? item.arguments : typeof item.input === "string" ? item.input : "{}";
  let args: Record<string, unknown> = {};
  let argError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!isRecord(parsed)) throw new Error("arguments must be a JSON object");
    args = parsed;
  } catch (e) {
    argError = e instanceof Error ? e.message : String(e);
    args = { raw: raw.slice(0, 2000) };
  }
  return { id: id || `call_${Math.random().toString(36).slice(2)}`, name: name || "invalid_tool_call", args, argError };
}

export class ResponsesProvider implements Provider {
  readonly mode = "responses" as const;
  #cfg: Config;

  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  async stream(req: ProviderRequest): Promise<TurnResult> {
    const cfg = this.#cfg;
    const body: Record<string, unknown> = {
      model: cfg.provider.model,
      instructions: req.system,
      input: inputItems(req.messages),
      tools: req.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      })),
      tool_choice: "auto",
      parallel_tool_calls: true,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: req.maxTokens ?? cfg.provider.maxTokens,
    };
    if (req.reasoningEffort && req.reasoningEffort !== "auto") {
      body.reasoning = { effort: req.reasoningEffort, summary: "auto" };
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const base = cfg.provider.baseUrl.replace(/\/+$/, "");
    const endpoint = /\/codex$/.test(base)
      ? `${base}/responses`
      : /\/backend-api$/.test(base)
        ? `${base}/codex/responses`
        : `${base}/responses`;
    const res = await postSSE(endpoint, {
      headers: requestHeaders(cfg),
      body,
      signal: req.signal,
      timeoutMs: cfg.provider.timeoutMs,
      retries: cfg.provider.retries,
      onRetry: (attempt, delay, reason) =>
        req.onNotice?.(`retrying Responses request (${attempt}) in ${Math.round(delay)}ms: ${reason}`),
    });

    const acc = new TurnAccumulator(req, []);
    const calls: ToolCall[] = [];
    const completedOutput = new Set<string>();
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    let thinkingFromDeltas = false;

    const reasoningText = (item: Record<string, unknown>): string => {
      const parts: string[] = [];
      const add = (value: unknown): void => {
        if (typeof value === "string" && value) parts.push(value);
      };
      if (Array.isArray(item.summary)) {
        for (const part of item.summary) {
          if (isRecord(part)) add(part.text);
        }
      }
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (isRecord(part)) add(part.text);
        }
      }
      add(item.text);
      return parts.join("\n").trim();
    };

    const handleItem = (item: unknown, allowThinking = true): void => {
      if (!isRecord(item)) return;
      if (allowThinking && item.type === "reasoning" && !thinkingFromDeltas) {
        const text = reasoningText(item);
        if (text) {
          thinkingFromDeltas = true;
          acc.feedThinking(text);
        }
      }
      const call = parseToolCall(item);
      if (call) {
        const key = `${call.id}:${call.name}`;
        if (!completedOutput.has(key)) {
          completedOutput.add(key);
          calls.push(call);
        }
      }
    };

    const handle = (event: Record<string, unknown>): void => {
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        acc.feedText(event.delta);
      } else if (
        (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") &&
        typeof event.delta === "string"
      ) {
        thinkingFromDeltas = true;
        acc.feedThinking(event.delta);
      } else if (type === "response.reasoning_summary_part.done") {
        if (thinkingFromDeltas) acc.feedThinking("\n");
      } else if (type === "response.reasoning_summary_text.done" && !thinkingFromDeltas) {
        if (typeof event.text === "string") {
          thinkingFromDeltas = true;
          acc.feedThinking(event.text);
        }
      } else if (type === "response.output_item.done") {
        handleItem(event.item);
      } else if (type === "response.completed" || type === "response.incomplete") {
        const response = isRecord(event.response) ? event.response : undefined;
        const details = response && isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
        const incomplete = type === "response.incomplete";
        finishReason = incomplete
          ? details?.reason === "max_output_tokens" ? "length" : "incomplete"
          : "stop";
        const u = mapUsage(response?.usage ?? event.usage);
        if (u) usage = u;
        if (response && Array.isArray(response.output)) for (const item of response.output) handleItem(item);
      } else if (type === "response.failed" || type === "error") {
        const response = isRecord(event.response) ? event.response : undefined;
        const error = response && isRecord(response.error) ? response.error.message : event.message;
        throw new Error(typeof error === "string" ? error : "Responses request failed");
      }
    };

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && !ct.includes("text/event-stream")) {
      handle(await res.json() as Record<string, unknown>);
    } else {
      for await (const data of readSSE(res)) {
        if (data === "[DONE]") break;
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (isRecord(json)) handle(json);
      }
    }

    for (const call of calls) acc.addToolCall(call);
    const result = acc.finish();
    return { ...result, usage, finishReason };
  }
}
