import type { Msg, Provider, ProviderRequest, TurnResult, Usage } from "../types.ts";
import type { Config } from "../config.ts";
import { randomId } from "../util.ts";
import { postSSE, readSSE } from "./http.ts";
import { requestHeaders } from "./headers.ts";
import { TurnAccumulator } from "./accum.ts";
import { feedAnimated } from "./anim.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mapUsage(u: unknown): Usage | undefined {
  if (!isRecord(u)) return undefined;
  return {
    promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
    completionTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
    totalTokens: typeof u.total_tokens === "number" ? u.total_tokens : undefined,
  };
}

function toChatMessage(m: Msg): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === "user") {
    return { role: "user", content: m.content };
  }
  const out: Record<string, unknown> = { role: "assistant", content: m.content || "" };
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
  }
  return out;
}

function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

export class ChatProvider implements Provider {
  readonly mode = "chat" as const;
  #cfg: Config;

  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  async stream(req: ProviderRequest): Promise<TurnResult> {
    const cfg = this.#cfg;
    const body: Record<string, unknown> = {
      model: cfg.provider.model,
      messages: [{ role: "system", content: req.system }, ...req.messages.map(toChatMessage)],
      stream: true,
      temperature: req.temperature ?? cfg.provider.temperature,
      max_tokens: req.maxTokens ?? cfg.provider.maxTokens,
      stream_options: { include_usage: true },
      ...cfg.provider.extraBody,
    };
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.reasoningEffort && req.reasoningEffort !== "auto") body.reasoning_effort = req.reasoningEffort;
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const res = await postSSE(`${cfg.provider.baseUrl}/chat/completions`, {
      headers: requestHeaders(cfg),
      body,
      signal: req.signal,
      timeoutMs: cfg.provider.timeoutMs,
      retries: cfg.provider.retries,
      onRetry: (attempt, delay, reason) => req.onNotice?.(`retrying chat request (${attempt}) in ${Math.round(delay)}ms: ${reason}`),
    });

    const acc = new TurnAccumulator(req, cfg.prompt.thinkingTags);
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | undefined;
    let usage: Usage | undefined;

    const addNative = (c: unknown): void => {
      if (!isRecord(c)) return;
      const idx = typeof c.index === "number" ? c.index : 0;
      const cur = pending.get(idx) ?? { id: "", name: "", args: "" };
      if (typeof c.id === "string" && c.id) cur.id = c.id;
      const fn = isRecord(c.function) ? c.function : c;
      if (typeof fn.name === "string" && fn.name) cur.name = fn.name;
      if (typeof fn.arguments === "string") cur.args += fn.arguments;
      else if (isRecord(fn.arguments)) cur.args = JSON.stringify(fn.arguments);
      pending.set(idx, cur);
    };

    const handleChunk = async (json: unknown): Promise<void> => {
      if (!isRecord(json)) return;
      const u = mapUsage(json.usage);
      if (u) usage = u;
      const choices = Array.isArray(json.choices) ? json.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
        const content = textParts(delta.content);
        if (content) await feedAnimated(acc, content, req.signal, !!req.onText);
        const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
        const thinking = textParts(reasoning);
        if (thinking) acc.feedThinking(thinking);
        const calls = delta.tool_calls;
        if (Array.isArray(calls)) for (const c of calls) addNative(c);
        else if (isRecord(delta.function_call)) addNative({ index: 0, id: delta.id, function: delta.function_call });
      }
    };

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json") && !ct.includes("text/event-stream")) {
      await handleChunk(await res.json());
    } else {
      for await (const data of readSSE(res)) {
        if (data === "[DONE]") break;
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        await handleChunk(json);
      }
    }

    for (const [, c] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      let args: Record<string, unknown> = {};
      let argError: string | undefined;
      if (c.args.trim()) {
        try {
          const parsed = JSON.parse(c.args);
          if (!isRecord(parsed)) throw new Error("arguments must be a JSON object");
          args = parsed;
        } catch (e) {
          argError = e instanceof Error ? e.message : String(e);
          args = { raw: c.args.slice(0, 2000) };
        }
      }
      acc.addToolCall({
        id: c.id || randomId("call_"),
        name: c.name || "invalid_tool_call",
        args,
        argError: c.name ? argError : "tool call without a name",
      });
    }

    const result = acc.finish();
    return { ...result, usage, finishReason };
  }
}
