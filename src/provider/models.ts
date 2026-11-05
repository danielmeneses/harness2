import { EXPLICIT_EFFORTS, normalizeEfforts } from "../reasoning.ts";
import type { ReasoningEffort } from "../types.ts";

export type ModelListOptions = {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ModelInfo = {
  id: string;
  contextWindow?: number;
  /** Explicit effort levels the model declares; undefined means not reported. */
  efforts?: ReasoningEffort[];
};

function declaredEfforts(entry: Record<string, unknown>): ReasoningEffort[] | undefined {
  const reasoning = isRecord(entry.reasoning) ? entry.reasoning : undefined;
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
  const capReasoning = capabilities && isRecord(capabilities.reasoning) ? capabilities.reasoning : undefined;
  const candidates = [
    entry.reasoning_efforts,
    entry.supported_reasoning_efforts,
    entry.thinking_efforts,
    entry.supported_efforts,
    Array.isArray(entry.reasoning_effort) ? entry.reasoning_effort : undefined,
    reasoning?.supported_efforts,
    reasoning?.efforts,
    capabilities?.reasoning_efforts,
    capReasoning?.supported_efforts,
    capReasoning?.efforts,
  ];
  for (const candidate of candidates) {
    const efforts = normalizeEfforts(candidate);
    if (efforts !== undefined) return efforts;
  }

  const params = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters.filter((value): value is string => typeof value === "string")
    : [];
  const explicitNo =
    entry.reasoning === false ||
    entry.supports_reasoning === false ||
    entry.supports_reasoning_effort === false ||
    capabilities?.reasoning === false ||
    capabilities?.reasoning_effort === false ||
    reasoning?.supports_effort === false ||
    capReasoning?.supports_effort === false;
  if (explicitNo) return [];

  const supportsEffortParameter =
    params.includes("reasoning_effort") ||
    entry.reasoning_effort === true ||
    entry.supports_reasoning_effort === true ||
    capabilities?.reasoning_effort === true ||
    reasoning?.supports_effort === true ||
    capReasoning?.supports_effort === true;
  if (supportsEffortParameter) return [...EXPLICIT_EFFORTS];

  const reasoningOnly =
    params.includes("reasoning") ||
    entry.reasoning === true ||
    entry.supports_reasoning === true ||
    capabilities?.reasoning === true ||
    reasoning !== undefined ||
    capReasoning !== undefined;
  if (reasoningOnly) return [];
  return undefined;
}

function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  const meta = isRecord(entry.meta) ? entry.meta : undefined;
  const modelMeta = isRecord(entry.model_meta) ? entry.model_meta : undefined;
  const candidates = [
    entry.context_window,
    entry.context_length,
    entry.max_context_length,
    entry.max_model_len,
    entry.n_ctx,
    meta?.n_ctx,
    meta?.context_length,
    meta?.max_model_len,
    modelMeta?.n_ctx,
    modelMeta?.context_length,
    meta?.n_ctx_train,
    entry.n_ctx_train,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

export async function listModelInfo(opts: ModelListOptions): Promise<ModelInfo[]> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  const hasAuth = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
  if (opts.apiKey && !hasAuth) headers.Authorization = `Bearer ${opts.apiKey}`;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`cannot reach ${url}: ${message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}${body ? `: ${body.replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
  }
  const json: unknown = await res.json();
  const raw = isRecord(json) && Array.isArray(json.data) ? json.data : isRecord(json) && Array.isArray(json.models) ? json.models : [];
  const models = new Map<string, ModelInfo>();
  for (const entry of raw) {
    const record = isRecord(entry) ? entry : undefined;
    const id = (typeof entry === "string" ? entry : record && typeof record.id === "string" ? record.id : "").trim();
    if (!id) continue;
    const contextWindow = record ? contextWindowOf(record) : undefined;
    const efforts = record ? declaredEfforts(record) : undefined;
    const previous = models.get(id);
    if (!previous) {
      const info: ModelInfo = { id };
      if (contextWindow) info.contextWindow = contextWindow;
      if (efforts !== undefined) info.efforts = efforts;
      models.set(id, info);
    } else {
      if (!previous.contextWindow && contextWindow) previous.contextWindow = contextWindow;
      if (previous.efforts === undefined && efforts !== undefined) previous.efforts = efforts;
    }
  }
  return [...models.values()];
}

export async function listModels(opts: ModelListOptions): Promise<string[]> {
  return (await listModelInfo(opts)).map((model) => model.id);
}
