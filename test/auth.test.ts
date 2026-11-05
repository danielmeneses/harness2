import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  NATIVE_PROVIDERS,
  applyAuth,
  authPath,
  loadAuth,
  saveAuth,
  setProfile,
  type AuthFile,
} from "../src/auth.ts";
import { defaultConfig } from "../src/config.ts";

async function freshXdg(): Promise<void> {
  process.env.HARNESS2_HOME = await mkdtemp(join(tmpdir(), "h2-auth-"));
}

test("native providers have sensible defaults", () => {
  assert.equal(NATIVE_PROVIDERS.deepseek.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(NATIVE_PROVIDERS.deepseek.apiKey, "required");
  assert.equal(NATIVE_PROVIDERS.deepseek.mode, "chat");
  assert.equal(NATIVE_PROVIDERS["llama-swap"].needsBaseUrl, true);
  assert.equal(NATIVE_PROVIDERS["llama-swap"].apiKey, "optional");
  assert.deepEqual(NATIVE_PROVIDERS.deepseek.defaultEfforts, ["low", "medium", "high", "max"]);
});

test("auth profiles round-trip with 0600 permissions", async () => {
  await freshXdg();
  assert.deepEqual(await loadAuth(), { providers: {} });
  const auth: AuthFile = { providers: {} };
  setProfile(auth, "deepseek", {
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    model: "deepseek-reasoner",
    effort: "high",
    mode: "chat",
    contextWindow: 65536,
  });
  await saveAuth(auth);
  const loaded = await loadAuth();
  assert.equal(loaded.active, "deepseek");
  assert.equal(loaded.providers.deepseek?.apiKey, "sk-test");
  assert.equal(loaded.providers.deepseek?.model, "deepseek-reasoner");
  assert.equal(loaded.providers.deepseek?.effort, "high");
  assert.equal(loaded.providers.deepseek?.contextWindow, 65536);
  const mode = (await stat(authPath())).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("corrupt auth files are ignored", async () => {
  const xdg = await mkdtemp(join(tmpdir(), "h2-auth-"));
  process.env.HARNESS2_HOME = xdg;
  const path = authPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not json", "utf8");
  assert.deepEqual(await loadAuth(), { providers: {} });
});

test("applyAuth applies profile fields and respects skips", async () => {
  await freshXdg();
  const auth: AuthFile = { providers: {} };
  setProfile(auth, "llama-swap", {
    baseUrl: "http://127.0.0.1:9000/v1",
    apiKey: "key",
    model: "qwen",
    effort: "low",
    mode: "auto",
    contextWindow: 131072,
  });
  const cfg = defaultConfig(await mkdtemp(join(tmpdir(), "h2-auth-cfg-")));
  cfg.provider.baseUrl = "http://old/v1";
  cfg.provider.apiKey = "old";
  cfg.provider.model = "old";
  cfg.reasoning.effort = "auto";
  const id = applyAuth(cfg, auth);
  assert.equal(id, "llama-swap");
  assert.equal(cfg.provider.baseUrl, "http://127.0.0.1:9000/v1");
  assert.equal(cfg.provider.apiKey, "key");
  assert.equal(cfg.provider.model, "qwen");
  assert.equal(cfg.reasoning.effort, "low");
  assert.equal(cfg.provider.contextWindow, 131072);
  assert.equal(cfg.provider.contextWindowReported, true);

  const skipped = defaultConfig(await mkdtemp(join(tmpdir(), "h2-auth-cfg-")));
  skipped.provider.model = "cli-model";
  skipped.reasoning.effort = "medium";
  applyAuth(skipped, auth, { model: true, effort: true, contextWindow: true });
  assert.equal(skipped.provider.model, "cli-model");
  assert.equal(skipped.reasoning.effort, "medium");
  assert.equal(skipped.provider.contextWindow, 32768);
});
