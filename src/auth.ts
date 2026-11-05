import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { normalizeBaseUrl } from "./config.ts";
import { harnessPath } from "./home.ts";
import { isReasoningEffort } from "./reasoning.ts";
import type { ReasoningEffort } from "./types.ts";

export type AuthMode = "auto" | "chat" | "completions" | "responses";
export type NativeProviderId = "deepseek" | "llama-swap" | "openai";

export type AuthProfile = {
  baseUrl: string;
  apiKey: string;
  model?: string;
  effort?: ReasoningEffort;
  mode: AuthMode;
  /** Context window reported by the provider's API for this saved model. */
  contextWindow?: number;
  /** OAuth credentials for the OpenAI/ChatGPT provider. */
  oauth?: {
    refreshToken: string;
    expiresAt: number;
    accountId?: string;
  };
};

export type AuthFile = {
  active?: NativeProviderId;
  providers: Partial<Record<NativeProviderId, AuthProfile>>;
};

export type NativeProvider = {
  label: string;
  baseUrl: string;
  mode: AuthMode;
  needsBaseUrl: boolean;
  apiKey: "required" | "optional";
  /** Known effort levels for providers whose /v1/models omits capability metadata. */
  defaultEfforts?: ReasoningEffort[];
  /** OpenAI/ChatGPT OAuth instead of an API key. */
  oauth?: boolean;
  /** Provider-specific model catalog endpoint. */
  modelsUrl?: string;
};

export function isNativeProviderId(value: string): value is NativeProviderId {
  return nativeProviderIds().includes(value as NativeProviderId);
}

export const NATIVE_PROVIDERS: Record<NativeProviderId, NativeProvider> = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    mode: "chat",
    needsBaseUrl: false,
    apiKey: "required",
    defaultEfforts: ["low", "medium", "high", "max"],
  },
  "llama-swap": {
    label: "llama-swap",
    baseUrl: "http://127.0.0.1:8080/v1",
    mode: "auto",
    needsBaseUrl: true,
    apiKey: "optional",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    mode: "responses",
    needsBaseUrl: false,
    apiKey: "required",
    oauth: true,
    modelsUrl: "https://chatgpt.com/backend-api/codex/models",
  },
};

export function nativeProviderIds(): NativeProviderId[] {
  return Object.keys(NATIVE_PROVIDERS) as NativeProviderId[];
}

export function authPath(): string {
  return harnessPath("auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadAuth(): Promise<AuthFile> {
  let raw: string;
  try {
    raw = await readFile(authPath(), "utf8");
  } catch {
    return { providers: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { providers: {} };
  }
  if (!isRecord(parsed)) return { providers: {} };
  const providersRaw = isRecord(parsed.providers) ? parsed.providers : {};
  const providers: AuthFile["providers"] = {};
  for (const id of nativeProviderIds()) {
    const value = providersRaw[id];
    if (!isRecord(value)) continue;
    if (typeof value.baseUrl !== "string" || typeof value.apiKey !== "string") continue;
    providers[id] = {
      baseUrl: value.baseUrl,
      apiKey: value.apiKey,
      model: typeof value.model === "string" && value.model ? value.model : undefined,
      effort:
        typeof value.effort === "string" && isReasoningEffort(value.effort) ? value.effort : undefined,
      mode:
        value.mode === "chat" || value.mode === "completions" || value.mode === "auto" || value.mode === "responses"
          ? value.mode
          : NATIVE_PROVIDERS[id].mode,
      contextWindow:
        typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow) && value.contextWindow > 0
          ? Math.floor(value.contextWindow)
          : undefined,
      oauth:
        isRecord(value.oauth) &&
        typeof value.oauth.refreshToken === "string" &&
        typeof value.oauth.expiresAt === "number"
          ? {
              refreshToken: value.oauth.refreshToken,
              expiresAt: value.oauth.expiresAt,
              accountId: typeof value.oauth.accountId === "string" ? value.oauth.accountId : undefined,
            }
          : undefined,
    };
  }
  const active = typeof parsed.active === "string" && isNativeProviderId(parsed.active) ? parsed.active : undefined;
  return { active: active && providers[active] ? active : undefined, providers };
}

export async function saveAuth(auth: AuthFile): Promise<void> {
  const path = authPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

export function applyAuth(
  cfg: Config,
  auth: AuthFile,
  skip: {
    baseUrl?: boolean;
    apiKey?: boolean;
    model?: boolean;
    mode?: boolean;
    effort?: boolean;
    contextWindow?: boolean;
  } = {},
): NativeProviderId | null {
  const id = auth.active;
  if (!id) return null;
  const profile = auth.providers[id];
  if (!profile) return null;
  if (!skip.baseUrl) cfg.provider.baseUrl = normalizeBaseUrl(profile.baseUrl);
  if (!skip.apiKey) cfg.provider.apiKey = profile.apiKey;
  if (!skip.model && profile.model) cfg.provider.model = profile.model;
  if (!skip.effort && profile.effort) cfg.reasoning.effort = profile.effort;
  if (!skip.mode) cfg.provider.mode = profile.mode;
  if (!skip.contextWindow && profile.contextWindow) {
    cfg.provider.contextWindow = profile.contextWindow;
    cfg.provider.contextWindowReported = true;
  }
  if (profile.oauth?.accountId) {
    cfg.provider.headers["chatgpt-account-id"] = profile.oauth.accountId;
    cfg.provider.headers.originator = "codex_cli_rs";
  }
  return id;
}

export function setProfile(auth: AuthFile, id: NativeProviderId, profile: AuthProfile): void {
  auth.providers[id] = profile;
  auth.active = id;
}
