import type { Provider, ProviderRequest, TurnResult, Usage } from "../types.ts";
import type { Config } from "../config.ts";
import { stopSequences } from "../config.ts";
import { renderCompletions } from "../prompt/render.ts";
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

function stripTrailingStops(text: string, stops: string[]): string {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const stop of stops) {
      if (stop && out.endsWith(stop)) {
        out = out.slice(0, -stop.length);
        changed = true;
      }
    }
  }
  return out.trimEnd();
}

export class CompletionsProvider implements Provider {
  readonly mode = "completions" as const;
  #cfg: Config;

  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  async stream(req: ProviderRequest): Promise<TurnResult> {
    const cfg = this.#cfg;
    const prompt = renderCompletions(cfg.prompt.template, req.system, req.messages);
    const stops = stopSequences(cfg);
    const body: Record<string, unknown> = {
      model: cfg.provider.model,
      prompt,
      stream: true,
      stream_options: { include_usage: true },
      temperature: req.temperature ?? cfg.provider.temperature,
      max_tokens: req.maxTokens ?? cfg.provider.maxTokens,
      stop: stops,
      ...cfg.provider.extraBody,
    };
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.reasoningEffort && req.reasoningEffort !== "auto") body.reasoning_effort = req.reasoningEffort;

    const res = await postSSE(`${cfg.provider.baseUrl}/completions`, {
      headers: requestHeaders(cfg),
      body,
      signal: req.signal,
      timeoutMs: cfg.provider.timeoutMs,
      retries: cfg.provider.retries,
      onRetry: (attempt, delay, reason) => req.onNotice?.(`retrying completions request (${attempt}) in ${Math.round(delay)}ms: ${reason}`),
    });

    const acc = new TurnAccumulator(req, cfg.prompt.thinkingTags);
    let finishReason: string | undefined;
    let usage: Usage | undefined;

    const handleChunk = async (json: unknown): Promise<void> => {
      if (!isRecord(json)) return;
      const u = mapUsage(json.usage);
      if (u) usage = u;
      const choices = Array.isArray(json.choices) ? json.choices : [];
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        let piece = "";
        if (typeof choice.text === "string") piece = choice.text;
        else if (isRecord(choice.delta) && typeof choice.delta.text === "string") piece = choice.delta.text;
        else if (isRecord(choice.message) && typeof choice.message.content === "string") piece = choice.message.content;
        if (piece) await feedAnimated(acc, piece, req.signal, !!req.onText);
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

    const result = acc.finish();
    result.text = stripTrailingStops(result.text, stops);
    result.thinking = stripTrailingStops(result.thinking, stops);
    return { ...result, usage, finishReason };
  }
}
