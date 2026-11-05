import type { ReasoningEffort } from "./types.ts";

export const REASONING_EFFORTS: Array<{ value: ReasoningEffort; description: string }> = [
  { value: "auto", description: "omit the parameter; use the model default" },
  { value: "none", description: "disable reasoning where supported" },
  { value: "minimal", description: "minimal extra thinking" },
  { value: "low", description: "light reasoning" },
  { value: "medium", description: "balanced reasoning" },
  { value: "high", description: "high reasoning" },
  { value: "xhigh", description: "extra-high reasoning" },
  { value: "max", description: "maximum reasoning" },
  { value: "ultra", description: "ultra reasoning" },
];

export const EXPLICIT_EFFORTS: ReasoningEffort[] = REASONING_EFFORTS
  .map((effort) => effort.value)
  .filter((effort) => effort !== "auto");

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return REASONING_EFFORTS.some((effort) => effort.value === value);
}

/** Normalize a declared effort list; undefined means the model did not declare support. */
export function normalizeEfforts(value: unknown): ReasoningEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const declared = new Set<ReasoningEffort>();
  for (const item of value) {
    if (typeof item === "string" && isReasoningEffort(item) && item !== "auto") declared.add(item);
  }
  return EXPLICIT_EFFORTS.filter((effort) => declared.has(effort));
}

export function effortChoices(available: readonly ReasoningEffort[]): typeof REASONING_EFFORTS {
  return REASONING_EFFORTS.filter((effort) => effort.value === "auto" || available.includes(effort.value));
}

export function supportsEffort(effort: ReasoningEffort, available: readonly ReasoningEffort[]): boolean {
  return effort === "auto" || available.includes(effort);
}

export function maxEffort(available: readonly ReasoningEffort[]): ReasoningEffort {
  for (let i = EXPLICIT_EFFORTS.length - 1; i >= 0; i--) {
    if (available.includes(EXPLICIT_EFFORTS[i])) return EXPLICIT_EFFORTS[i];
  }
  return "auto";
}

export function effortMenuLines(current: ReasoningEffort): string[] {
  return [
    `thinking efforts (current: ${current}):`,
    ...REASONING_EFFORTS.map(
      (effort, index) => `  ${index + 1}. ${effort.value.padEnd(8)} ${effort.description}${effort.value === current ? "  *" : ""}`,
    ),
  ];
}

export function parseReasoningEffort(input: string, allowNumber = true): ReasoningEffort | null {
  const value = input.trim().toLowerCase();
  if (allowNumber && /^\d+$/.test(value)) {
    const index = Number(value) - 1;
    return REASONING_EFFORTS[index]?.value ?? null;
  }
  return isReasoningEffort(value) ? value : null;
}
