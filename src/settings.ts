import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import type { ReasoningEffort } from "./types.ts";
import { isReasoningEffort } from "./reasoning.ts";
import { harnessPath } from "./home.ts";

export type Settings = {
  model?: string;
  effort?: ReasoningEffort;
  mode?: "auto" | "chat" | "completions" | "responses";
  contextWindow?: number;
  approvals?: "on" | "off";
  network?: "ask" | "allow" | "deny";
  bashSandbox?: boolean;
  loopChanges?: "auto" | "approve";
  showThinking?: boolean;
};

export function settingsPath(): string {
  return harnessPath("settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettings(path: string): Promise<Settings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const settings: Settings = {};
  if (typeof parsed.model === "string" && parsed.model) settings.model = parsed.model;
  if (typeof parsed.effort === "string" && isReasoningEffort(parsed.effort)) settings.effort = parsed.effort;
  if (parsed.mode === "auto" || parsed.mode === "chat" || parsed.mode === "completions" || parsed.mode === "responses") settings.mode = parsed.mode;
  if (typeof parsed.contextWindow === "number" && Number.isFinite(parsed.contextWindow) && parsed.contextWindow >= 1) {
    settings.contextWindow = Math.floor(parsed.contextWindow);
  }
  if (parsed.approvals === "on" || parsed.approvals === "off") settings.approvals = parsed.approvals;
  if (parsed.network === "ask" || parsed.network === "allow" || parsed.network === "deny") settings.network = parsed.network;
  if (typeof parsed.bashSandbox === "boolean") settings.bashSandbox = parsed.bashSandbox;
  if (parsed.loopChanges === "auto" || parsed.loopChanges === "approve") settings.loopChanges = parsed.loopChanges;
  if (typeof parsed.showThinking === "boolean") settings.showThinking = parsed.showThinking;
  return settings;
}

/** Project settings may override workflow preferences, never safety policy. */
function projectSettings(settings: Settings): Settings {
  const out: Settings = {};
  if (settings.model !== undefined) out.model = settings.model;
  if (settings.effort !== undefined) out.effort = settings.effort;
  if (settings.mode !== undefined) out.mode = settings.mode;
  if (settings.contextWindow !== undefined) out.contextWindow = settings.contextWindow;
  if (settings.showThinking !== undefined) out.showThinking = settings.showThinking;
  return out;
}

export async function loadSettings(cwd = process.cwd()): Promise<Settings> {
  const shared = await readSettings(settingsPath());
  const project = await readSettings(join(cwd, ".harness2", "settings.json"));
  return { ...shared, ...projectSettings(project) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const current = await readSettings(settingsPath());
  await saveSettings({ ...current, ...patch });
}

export function applySettings(
  cfg: Config,
  settings: Settings,
  skip: Partial<Record<keyof Settings, boolean>> = {},
): void {
  if (!skip.model && settings.model) cfg.provider.model = settings.model;
  if (!skip.effort && settings.effort) cfg.reasoning.effort = settings.effort;
  if (!skip.mode && settings.mode) cfg.provider.mode = settings.mode;
  if (!skip.contextWindow && settings.contextWindow) cfg.provider.contextWindow = settings.contextWindow;
  if (!skip.approvals && settings.approvals) cfg.safety.approvals = settings.approvals;
  if (!skip.network && settings.network) cfg.safety.network = settings.network;
  if (!skip.bashSandbox && settings.bashSandbox !== undefined) cfg.safety.bashSandbox = settings.bashSandbox;
  if (!skip.loopChanges && settings.loopChanges) cfg.loop.changes = settings.loopChanges;
  if (!skip.showThinking && settings.showThinking !== undefined) cfg.ui.showThinking = settings.showThinking;
}
