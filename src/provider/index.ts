import type { Provider, ProviderMode, ProviderRequest, TurnResult } from "../types.ts";
import type { Config } from "../config.ts";
import { HTTPError } from "./http.ts";
import { ChatProvider } from "./chat.ts";
import { CompletionsProvider } from "./completions.ts";
import { ResponsesProvider } from "./responses.ts";
import { loadAuth, saveAuth } from "../auth.ts";
import { applyTokens, ensureFreshTokens } from "./openai-oauth.ts";

function shouldFallBack(e: unknown): boolean {
  if (!(e instanceof HTTPError)) return false;
  if (e.status === 404 || e.status === 405 || e.status === 501) return true;
  if (e.status === 400 || e.status === 422) {
    return /tool|function|reasoning|stream_options|chat/i.test(e.body);
  }
  return false;
}

export class AutoProvider implements Provider {
  #chat: ChatProvider;
  #completions: CompletionsProvider;
  #active: Provider | null = null;

  constructor(cfg: Config) {
    this.#chat = new ChatProvider(cfg);
    this.#completions = new CompletionsProvider(cfg);
  }

  get mode(): ProviderMode {
    return this.#active?.mode ?? "auto";
  }

  async stream(req: ProviderRequest): Promise<TurnResult> {
    if (this.#active) return this.#active.stream(req);

    let produced = false;
    const wrapped: ProviderRequest = {
      ...req,
      onText: (t) => {
        produced = true;
        req.onText?.(t);
      },
      onThinking: (t) => {
        produced = true;
        req.onThinking?.(t);
      },
      onNotice: req.onNotice,
    };

    try {
      const result = await this.#chat.stream(wrapped);
      this.#active = this.#chat;
      return result;
    } catch (e) {
      if (!shouldFallBack(e) || produced) throw e;
      req.onNotice?.("chat endpoint unavailable; falling back to /v1/completions");
      this.#active = this.#completions;
      return this.#completions.stream(req);
    }
  }
}

class OAuthResponsesProvider implements Provider {
  readonly mode = "responses" as const;
  #cfg: Config;
  #inner: ResponsesProvider;

  constructor(cfg: Config) {
    this.#cfg = cfg;
    this.#inner = new ResponsesProvider(cfg);
  }

  async stream(req: Parameters<Provider["stream"]>[0]): Promise<Awaited<ReturnType<Provider["stream"]>>> {
    try {
      return await this.#inner.stream(req);
    } catch (e) {
      if (!(e instanceof HTTPError) || e.status !== 401) throw e;
      const auth = await loadAuth();
      const profile = auth.providers.openai;
      if (!profile?.oauth) throw e;
      const tokens = await ensureFreshTokens(profile, true);
      applyTokens(profile, tokens);
      await saveAuth(auth);
      this.#cfg.provider.apiKey = tokens.accessToken;
      if (tokens.accountId) this.#cfg.provider.headers["chatgpt-account-id"] = tokens.accountId;
      this.#inner = new ResponsesProvider(this.#cfg);
      return await this.#inner.stream(req);
    }
  }
}

export function createProvider(cfg: Config): Provider {
  if (cfg.provider.mode === "chat") return new ChatProvider(cfg);
  if (cfg.provider.mode === "completions") return new CompletionsProvider(cfg);
  if (cfg.provider.mode === "responses") return new OAuthResponsesProvider(cfg);
  return new AutoProvider(cfg);
}
