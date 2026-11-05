export type ReasoningEffort = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argError?: string;
};

export type Msg =
  | { role: "user"; content: string; synthetic?: boolean }
  | { role: "assistant"; content: string; thinking?: string; toolCalls?: ToolCall[]; synthetic?: boolean }
  | { role: "tool"; toolCallId: string; name: string; content: string; ok: boolean };

export type Usage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolSpec = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ProviderMode = "chat" | "completions" | "auto" | "responses";

export type ProviderRequest = {
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onNotice?: (message: string) => void;
};

export type TurnResult = {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
};

export interface Provider {
  /** Current transport. An auto provider reports "auto" until it falls back. */
  readonly mode: ProviderMode;
  stream(req: ProviderRequest): Promise<TurnResult>;
}

export type TodoItem = {
  text: string;
  done: boolean;
};
