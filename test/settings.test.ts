import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HARNESS2_HOME = await mkdtemp(join(tmpdir(), "h2-settings-"));
const EMPTY_CWD = await mkdtemp(join(tmpdir(), "h2-settings-cwd-"));

import { applySettings, loadSettings, saveSettings, settingsPath, updateSettings } from "../src/settings.ts";
import { loadConfig } from "../src/config.ts";

test("settings round-trip and update", async () => {
  assert.equal(settingsPath(), join(process.env.HARNESS2_HOME!, "settings.json"));
  await saveSettings({
    model: "qwen3",
    effort: "high",
    mode: "chat",
    contextWindow: 65536,
    approvals: "on",
    network: "ask",
    bashSandbox: true,
    loopChanges: "approve",
    showThinking: true,
  });
  const loaded = await loadSettings(EMPTY_CWD);
  assert.deepEqual(loaded, {
    model: "qwen3",
    effort: "high",
    mode: "chat",
    contextWindow: 65536,
    approvals: "on",
    network: "ask",
    bashSandbox: true,
    loopChanges: "approve",
    showThinking: true,
  });
  await updateSettings({ effort: "low", showThinking: false });
  const updated = await loadSettings(EMPTY_CWD);
  assert.equal(updated.model, "qwen3");
  assert.equal(updated.effort, "low");
  assert.equal(updated.showThinking, false);
  const raw = await readFile(settingsPath(), "utf8");
  assert.match(raw, /"effort": "low"/);
});

test("project settings override safe preferences but not safety policy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "h2-settings-project-"));
  await saveSettings({ model: "central", effort: "high", approvals: "on", network: "ask" });
  await mkdir(join(cwd, ".harness2"), { recursive: true });
  await writeFile(
    join(cwd, ".harness2", "settings.json"),
    JSON.stringify({ model: "project", effort: "low", showThinking: true, approvals: "off", network: "allow", bashSandbox: true }),
  );
  const loaded = await loadSettings(cwd);
  assert.equal(loaded.model, "project");
  assert.equal(loaded.effort, "low");
  assert.equal(loaded.showThinking, true);
  assert.equal(loaded.approvals, "on");
  assert.equal(loaded.network, "ask");
  assert.equal(loaded.bashSandbox, undefined);
});

test("invalid settings are ignored", async () => {
  await writeFile(settingsPath(), "{ nope");
  assert.deepEqual(await loadSettings(EMPTY_CWD), {});
  await writeFile(settingsPath(), JSON.stringify({ model: 3, effort: "extreme", network: "sometimes" }));
  assert.deepEqual(await loadSettings(EMPTY_CWD), {});
});

test("applySettings fills runtime config and honors skips", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "h2-settings-cwd-"));
  const cfg = await loadConfig(cwd);
  applySettings(cfg, {
    model: "qwen3",
    effort: "high",
    mode: "completions",
    contextWindow: 65536,
    approvals: "off",
    network: "allow",
    bashSandbox: true,
    loopChanges: "approve",
    showThinking: true,
  });
  assert.equal(cfg.provider.model, "qwen3");
  assert.equal(cfg.reasoning.effort, "high");
  assert.equal(cfg.provider.mode, "completions");
  assert.equal(cfg.provider.contextWindow, 65536);
  assert.equal(cfg.safety.approvals, "off");
  assert.equal(cfg.safety.network, "allow");
  assert.equal(cfg.safety.bashSandbox, true);
  assert.equal(cfg.loop.changes, "approve");
  assert.equal(cfg.ui.showThinking, true);

  applySettings(
    cfg,
    { model: "other", effort: "low", network: "deny", showThinking: false },
    { model: true, effort: true, network: true, showThinking: true },
  );
  assert.equal(cfg.provider.model, "qwen3");
  assert.equal(cfg.reasoning.effort, "high");
  assert.equal(cfg.safety.network, "allow");
  assert.equal(cfg.ui.showThinking, true);
});
