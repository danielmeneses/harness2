import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config.ts";
import { Approvals } from "../src/safety/approvals.ts";

process.env.HARNESS2_HOME = await mkdtemp(join(tmpdir(), "h2-approvals-xdg-"));

test("session grants stop repeat prompts for the same key", async () => {
  const cfg = defaultConfig(await mkdtemp(join(tmpdir(), "h2-approvals-")));
  cfg.safety.approvals = "on";
  const approvals = new Approvals(cfg, () => {});
  await approvals.init();
  let calls = 0;
  approvals.setHandler(async () => {
    calls++;
    return { decision: "session" };
  });
  const a = await approvals.request({ kind: "read", title: "read", key: "read:/tmp/x" });
  const b = await approvals.request({ kind: "read", title: "read", key: "read:/tmp/x" });
  assert.equal(a.decision, "session");
  assert.equal(b.decision, "once");
  assert.equal(calls, 1);
});

test("always grants persist to the grants file", async () => {
  const cfg = defaultConfig(await mkdtemp(join(tmpdir(), "h2-approvals-")));
  cfg.safety.approvals = "on";
  const approvals = new Approvals(cfg, () => {});
  await approvals.init();
  let calls = 0;
  approvals.setHandler(async () => {
    calls++;
    return { decision: "always" };
  });
  await approvals.request({ kind: "write", title: "write", key: "write:/tmp/y" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const grants = JSON.parse(await readFile(join(process.env.HARNESS2_HOME as string, "grants.json"), "utf8")) as Record<string, boolean>;
  const keys = Object.keys(grants);
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^.*\u0000main\u0000write:\/tmp\/y$/);
  assert.equal(grants[keys[0]], true);
  const second = await approvals.request({ kind: "write", title: "write", key: "write:/tmp/y" });
  assert.equal(second.decision, "once");
  assert.equal(calls, 1);
});

test("headless requests are denied when no handler is set", async () => {
  const cfg = defaultConfig(await mkdtemp(join(tmpdir(), "h2-approvals-")));
  cfg.safety.approvals = "on";
  const approvals = new Approvals(cfg, () => {});
  await approvals.init();
  const res = await approvals.request({ kind: "bash", title: "bash", key: "bash:curl x" });
  assert.equal(res.decision, "deny");
  const answer = await approvals.ask("question?");
  assert.equal(answer, null);
});

test("approvals can be disabled", async () => {
  const cfg = defaultConfig(await mkdtemp(join(tmpdir(), "h2-approvals-")));
  cfg.safety.approvals = "off";
  const approvals = new Approvals(cfg, () => {});
  await approvals.init();
  let calls = 0;
  approvals.setHandler(async () => {
    calls++;
    return { decision: "deny" };
  });
  const res = await approvals.request({ kind: "read", title: "read", key: "read:/tmp/z" });
  assert.equal(res.decision, "once");
  assert.equal(calls, 0);
});
