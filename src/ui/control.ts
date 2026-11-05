import { fmtTokens, sanitizeTerminal } from "../util.ts";

/** Live values for the input footer and the running status line. */
export type ControlPanel = {
  model: string;
  effort: string;
  /** Cumulative completion tokens returned by the model. */
  completionTokens: number;
  /** Cumulative prompt tokens sent to the model. */
  promptTokens: number;
  contextTokens: number;
  contextWindow: number;
  contextReported: boolean;
  /** Undefined/false means the window is a configured fallback, not API metadata. */
  contextWindowReported?: boolean;
};

function clean(value: string): string {
  return sanitizeTerminal(value).replace(/\s+/g, " ").trim();
}

function contextText(panel: ControlPanel): string {
  const max =
    panel.contextWindow > 0
      ? `${fmtTokens(panel.contextWindow)}${panel.contextWindowReported === false ? "*" : ""}`
      : "?";
  if (panel.contextTokens <= 0) return `—/${max}`;
  const prefix = panel.contextReported ? "" : "~";
  let percent = "";
  if (panel.contextWindow > 0) {
    const ratio = panel.contextTokens / panel.contextWindow;
    percent = ratio > 0 && ratio < 0.01 ? " <1%" : ` ${Math.round(ratio * 100)}%`;
  }
  return `${prefix}${fmtTokens(panel.contextTokens)}/${max}${percent}`;
}

export function controlLines(panel: ControlPanel): [string, string] {
  return [
    `model ${clean(panel.model) || "?"} · effort ${clean(panel.effort) || "auto"}`,
    `in ${fmtTokens(panel.completionTokens)} from model · out ${fmtTokens(panel.promptTokens)} to model · context ${contextText(panel)}`,
  ];
}

export function controlStatus(panel: ControlPanel): string {
  return [
    clean(panel.model) || "?",
    clean(panel.effort) || "auto",
    `ctx ${contextText(panel)}`,
    `in ${fmtTokens(panel.completionTokens)}`,
    `out ${fmtTokens(panel.promptTokens)}`,
  ].join(" · ");
}
