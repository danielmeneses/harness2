import type { ProviderRequest, ToolCall, TurnResult } from "../types.ts";
import { TagSplitter } from "../prompt/split.ts";

/** Shared streaming accumulator for both transports. */
export class TurnAccumulator {
  text = "";
  thinking = "";
  toolCalls: ToolCall[] = [];
  #splitter: TagSplitter;
  #req: ProviderRequest;

  constructor(req: ProviderRequest, tags: Array<[string, string]>) {
    this.#req = req;
    this.#splitter = new TagSplitter(tags);
  }

  feedText(chunk: string): void {
    if (!chunk) return;
    for (const item of this.#splitter.feed(chunk)) this.#apply(item);
  }

  feedThinking(chunk: string): void {
    if (!chunk) return;
    this.thinking += chunk;
    this.#req.onThinking?.(chunk);
  }

  addToolCall(call: ToolCall): void {
    this.toolCalls.push(call);
  }

  finish(): Pick<TurnResult, "text" | "thinking" | "toolCalls"> {
    for (const item of this.#splitter.flush()) this.#apply(item);
    return { text: this.text, thinking: this.thinking, toolCalls: this.toolCalls };
  }

  #apply(item: ReturnType<TagSplitter["feed"]>[number]): void {
    if (item.kind === "text") {
      this.text += item.text;
      this.#req.onText?.(item.text);
    } else if (item.kind === "thinking") {
      this.thinking += item.text;
      this.#req.onThinking?.(item.text);
    } else {
      this.toolCalls.push(item.call);
    }
  }
}
