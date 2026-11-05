import type { Config } from "../config.ts";

export function requestHeaders(cfg: Config): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...cfg.provider.headers,
  };
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (cfg.provider.apiKey && !hasAuth) headers.Authorization = `Bearer ${cfg.provider.apiKey}`;
  return headers;
}

export function errorText(status: number, body: string): string {
  return `HTTP ${status}: ${body.replace(/\s+/g, " ").slice(0, 400)}`;
}
