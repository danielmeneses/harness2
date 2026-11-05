import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config.ts";
import { classifyBash } from "../src/safety/classify.ts";

async function config(): Promise<ReturnType<typeof defaultConfig>> {
  const cwd = await mkdtemp(join(tmpdir(), "h2-classify-"));
  return defaultConfig(cwd);
}

test("safe local commands need no approval", async () => {
  const cfg = await config();
  for (const cmd of ["ls -la", "node --test", "git status", "npm test", "echo hi > out.txt", "cat package.json", "2>/dev/null"]) {
    assert.deepEqual(classifyBash(cmd, cfg), [], cmd);
  }
});

test("paths outside the working directory are flagged", async () => {
  const cfg = await config();
  assert.match(classifyBash("cat /etc/passwd", cfg).join(";"), /outside/);
  assert.match(classifyBash("cat ~/.ssh/id_rsa", cfg).join(";"), /outside/);
  assert.match(classifyBash("cat ~/.ssh/id_rsa", cfg).join(";"), /outside/);
  assert.match(classifyBash("cd ..", cfg).join(";"), /parent-directory/);
  assert.match(classifyBash("cat ../outside.txt", cfg).join(";"), /parent-directory/);
  assert.match(classifyBash("FOO=/etc/x true", cfg).join(";"), /outside/);
});

test("relative paths that stay inside are fine", async () => {
  const cfg = await config();
  assert.deepEqual(classifyBash("cat src/../package.json", cfg), []);
});

test("network commands and URLs are flagged", async () => {
  const cfg = await config();
  for (const cmd of [
    "curl https://example.com",
    "wget example.com",
    "git push origin main",
    "git clone https://example.com/repo",
    "npm install lodash",
    "pnpm add react",
    "pip install requests",
    "docker pull alpine",
    "ssh host uptime",
    "echo https://example.com",
    "sudo -u root curl https://example.com",
    "env -i wget https://example.com",
    "python -m pip install requests",
  ]) {
    assert.match(classifyBash(cmd, cfg).join(";"), /network/, cmd);
  }
});

test("local package and git commands are not flagged", async () => {
  const cfg = await config();
  for (const cmd of ["git commit -m x", "git log --oneline", "npm run build", "cargo test", "cargo build", "go test ./..."]) {
    assert.deepEqual(classifyBash(cmd, cfg), [], cmd);
  }
});
