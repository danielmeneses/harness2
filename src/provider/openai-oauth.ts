import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { normalizeEfforts } from "../reasoning.ts";
import type { ModelInfo } from "./models.ts";
import { mergeOpenAIModels } from "./openai-codex-models.ts";

const CLIENT_ID = process.env.OPENAI_OAUTH_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = (process.env.OPENAI_OAUTH_ISSUER || "https://auth.openai.com").replace(/\/+$/, "");
const CODEX_BASE = (process.env.OPENAI_CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
const MODELS_URL = process.env.OPENAI_CODEX_MODELS_URL || `${CODEX_BASE}/models`;
const SCOPE = "openid profile email offline_access";

export type OpenAITokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
};

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function accountIdFromTokens(response: TokenResponse): string | undefined {
  for (const jwt of [response.id_token, response.access_token]) {
    if (!jwt) continue;
    const payload = jwtPayload(jwt);
    if (!payload) continue;
    const auth = payload["https://api.openai.com/auth"];
    if (typeof auth === "object" && auth !== null && !Array.isArray(auth)) {
      const account = (auth as Record<string, unknown>).chatgpt_account_id;
      if (typeof account === "string" && account) return account;
    }
    if (typeof payload.chatgpt_account_id === "string" && payload.chatgpt_account_id) return payload.chatgpt_account_id;
  }
  return undefined;
}

function tokensFromResponse(response: TokenResponse, previousRefresh?: string): OpenAITokens {
  if (!response.access_token) throw new Error("OAuth token response did not include access_token");
  const refreshToken = response.refresh_token || previousRefresh;
  if (!refreshToken) throw new Error("OAuth token response did not include refresh_token");
  const expiresIn = typeof response.expires_in === "number" && response.expires_in > 0 ? response.expires_in : 3600;
  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    accountId: accountIdFromTokens(response),
  };
}

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  clientId = CLIENT_ID,
): Promise<OpenAITokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI token exchange failed (HTTP ${res.status}): ${text.slice(0, 400)}`);
  return tokensFromResponse(JSON.parse(text) as TokenResponse);
}

export async function refreshOpenAITokens(refreshToken: string): Promise<OpenAITokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI token refresh failed (HTTP ${res.status}): ${text.slice(0, 400)}`);
  return tokensFromResponse(JSON.parse(text) as TokenResponse, refreshToken);
}

export async function loginOpenAI(onUrl: (url: string) => void): Promise<OpenAITokens> {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));

  return await new Promise<OpenAITokens>((resolve, reject) => {
    let settled = false;
    let redirectUri = "";
    let timer: NodeJS.Timeout | null = null;
    const finish = (err: Error | null, tokens?: OpenAITokens): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Resolve the terminal immediately; waiting for server.close() can hang on
      // the browser's keep-alive callback connection.
      if (err) reject(err);
      else if (tokens) resolve(tokens);
      else reject(new Error("OAuth login ended without tokens"));
      server.close();
      setTimeout(() => server.closeAllConnections(), 250).unref();
    };

    const server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url || "/", redirectUri || "http://127.0.0.1");
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" });
          res.end("not found");
          return;
        }
        const error = url.searchParams.get("error");
        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html", Connection: "close" });
          res.end(`<h1>OpenAI login failed</h1><p>${error.replace(/[<>&]/g, "")}</p>`);
          finish(new Error(`OpenAI OAuth error: ${error}`));
          return;
        }
        if (!returnedState || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
          res.end("invalid OAuth state");
          finish(new Error("OAuth state mismatch"));
          return;
        }
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
          res.end("missing code");
          finish(new Error("OAuth callback missing code"));
          return;
        }
        try {
          const tokens = await exchangeCode(code, verifier, redirectUri);
          res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
          res.end("<h1>OpenAI login complete</h1><p>You can return to the terminal.</p>");
          finish(null, tokens);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" });
          res.end(e instanceof Error ? e.message : String(e));
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });

    let portIndex = 0;
    const ports = [1455, 1457];
    const listen = (): void => {
      server.listen(ports[portIndex], "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        finish(new Error("could not bind OAuth callback server"));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const authorize = new URL(`${ISSUER}/oauth/authorize`);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", CLIENT_ID);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("scope", SCOPE);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("id_token_add_organizations", "true");
      authorize.searchParams.set("codex_cli_simplified_flow", "true");
      authorize.searchParams.set("originator", "codex_cli_rs");
      onUrl(authorize.toString());
      try {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        const args = process.platform === "win32" ? ["/c", "start", "", authorize.toString()] : [authorize.toString()];
        spawn(opener, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      } catch {
        // The printed URL is enough when no browser opener is available.
      }
      timer = setTimeout(() => finish(new Error("OpenAI OAuth timed out")), 5 * 60_000);
      timer.unref();
      });
    };
    server.on("error", (e) => {
      const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code?: unknown }).code) : "";
      if (!settled && code === "EADDRINUSE" && portIndex < ports.length - 1) {
        portIndex++;
        listen();
        return;
      }
      finish(e instanceof Error ? e : new Error(String(e)));
    });
    listen();
  });
}

export async function fetchOpenAIModels(tokens: OpenAITokens): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.accessToken}`,
    Accept: "application/json",
  };
  if (tokens.accountId) headers["chatgpt-account-id"] = tokens.accountId;
  headers.originator = "codex_cli_rs";
  const catalogUrl = new URL(MODELS_URL);
  catalogUrl.searchParams.set(
    "client_version",
    process.env.OPENAI_CODEX_CLIENT_VERSION || "0.99.0",
  );
  let raw: unknown[] = [];
  try {
    const res = await fetch(catalogUrl, { headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenAI model catalog failed (HTTP ${res.status}): ${text.slice(0, 400)}`);
    const parsed: unknown = JSON.parse(text);
    const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    raw = Array.isArray(record.models) ? record.models : Array.isArray(record.data) ? record.data : [];
  } catch {
    return mergeOpenAIModels([]);
  }
  const models: ModelInfo[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.slug === "string" ? entry.slug : typeof entry.id === "string" ? entry.id : "";
    if (!id) continue;
    const context =
      typeof entry.context_window === "number"
        ? entry.context_window
        : typeof entry.max_context_window === "number"
          ? entry.max_context_window
          : undefined;
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((level) => {
          if (typeof level === "string") return level;
          if (typeof level === "object" && level !== null && !Array.isArray(level)) {
            const value = (level as Record<string, unknown>).effort;
            return typeof value === "string" ? value : "";
          }
          return "";
        })
      : undefined;
    const info: ModelInfo = { id };
    if (context && Number.isFinite(context) && context > 0) info.contextWindow = Math.floor(context);
    if (levels !== undefined) {
      // The Codex Responses backend rejects `ultra`; its ceiling is `max`.
      info.efforts = (normalizeEfforts(levels) ?? []).filter((effort) => effort !== "ultra");
    }
    models.push(info);
  }
  return mergeOpenAIModels(models);
}

export type OAuthProfileLike = {
  apiKey: string;
  oauth?: { refreshToken: string; expiresAt: number; accountId?: string };
};

export function tokensForProfile(profile: OAuthProfileLike): OpenAITokens | null {
  if (!profile.oauth) return null;
  return {
    accessToken: profile.apiKey,
    refreshToken: profile.oauth.refreshToken,
    expiresAt: profile.oauth.expiresAt,
    accountId: profile.oauth.accountId,
  };
}

export function applyTokens(profile: OAuthProfileLike, tokens: OpenAITokens): void {
  profile.apiKey = tokens.accessToken;
  profile.oauth = {
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    accountId: tokens.accountId ?? profile.oauth?.accountId,
  };
}

export async function ensureFreshTokens(profile: OAuthProfileLike, force = false): Promise<OpenAITokens> {
  const tokens = tokensForProfile(profile);
  if (!tokens) throw new Error("OpenAI profile has no OAuth credentials");
  if (!force && tokens.expiresAt > Date.now() + 60_000) return tokens;
  return refreshOpenAITokens(tokens.refreshToken);
}
