import type { ModelInfo } from "./models.ts";

/** Codex model metadata used when the account catalog is unavailable or incomplete. */
export const OPENAI_CODEX_FALLBACK_MODELS: ModelInfo[] = [
  { id: "gpt-6-astra", contextWindow: 272000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6.1-sol", contextWindow: 500000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6.1-terra", contextWindow: 500000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-sol", contextWindow: 272000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-6-luna", contextWindow: 272000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-sol", contextWindow: 272000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-terra", contextWindow: 272000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.6-luna", contextWindow: 272000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-daybreak-blue-latest", contextWindow: 272000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-daybreak-red-latest", contextWindow: 372000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.5", contextWindow: 272000, efforts: ["low", "medium", "high", "xhigh"] },
];

export function mergeOpenAIModels(apiModels: ModelInfo[]): ModelInfo[] {
  const models = new Map<string, ModelInfo>();
  for (const model of OPENAI_CODEX_FALLBACK_MODELS) {
    models.set(model.id, { ...model, efforts: model.efforts ? [...model.efforts] : undefined });
  }
  for (const model of apiModels) {
    const previous = models.get(model.id);
    if (!previous) {
      models.set(model.id, model);
    } else {
      models.set(model.id, {
        id: model.id,
        contextWindow: model.contextWindow ?? previous.contextWindow,
        efforts: model.efforts ?? previous.efforts,
      });
    }
  }
  return [...models.values()];
}
