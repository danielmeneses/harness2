import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config.ts";
import { PathGuard, isInside, realish } from "../src/safety/paths.ts";
import type { Approvals, ApprovalRequest, ApprovalResponse } from "../src/safety/approvals.ts";

function stubApprovals(decision: "deny" | "once" = "deny"): { approvals: Approvals; calls: ApprovalRequest[] } {
  const calls: ApprovalRequest[] = [];
  const approvals = {
    request: async (req: ApprovalRequest): Promise<ApprovalResponse> => {
      calls.push(req);
      return decision === "deny" ? { decision: "deny", reason: "denied by test" } : { decision: "once" };
    },
    ask: async () => null,
    setHandler: () => {},
    init: async () => {},
    interactive: false,
  } as unknown as Approvals;
  return { approvals, calls };
}

test("isInside handles equal paths and children", () => {
  assert.equal(isInside("/a/b", "/a"), true);
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/bc", "/a/b"), false);
  assert.equal(isInside("/a/b", "/"), true);
});

test("realish resolves missing paths through the nearest parent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "h2-paths-"));
  const p = await realish(join(cwd, "new", "nested", "file.txt"));
  assert.equal(p, join(cwd, "new", "nested", "file.txt"));
});

test("inside reads do not ask for approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "h2-paths-"));
  await writeFile(join(cwd, "a.txt"), "hi");
  const { approvals, calls } = stubApprovals();
  const cfg = defaultConfig(cwd);
  const guard = new PathGuard(cfg, approvals);
  const r = await guard.check("read", "a.txt");
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
});

test("outside reads and writes ask, and a denial is returned", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "h2-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "h2-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  const { approvals, calls } = stubApprovals();
  const cfg = defaultConfig(cwd);
  const guard = new PathGuard(cfg, approvals);

  const read = await guard.check("read", join(outside, "secret.txt"));
  assert.equal(read.ok, false);
  if (!read.ok) assert.match(read.reason, /denied/);
  assert.equal(calls.length, 1);

  const write = await guard.check("write", join(outside, "new.txt"));
  assert.equal(write.ok, false);
  assert.equal(calls.length, 2);
});

test("symlinks escaping the working directory are treated as outside", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "h2-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "h2-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(join(outside, "secret.txt"), join(cwd, "link.txt"));
  const { approvals, calls } = stubApprovals();
  const guard = new PathGuard(defaultConfig(cwd), approvals);
  const r = await guard.check("read", "link.txt");
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
});

test("parent-directory escapes ask for approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "h2-paths-"));
  const { approvals, calls } = stubApprovals();
  const guard = new PathGuard(defaultConfig(cwd), approvals);
  const r = await guard.check("read", "../anything.txt");
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
});

test("configured read roots are allowed without approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "h2-paths-"));
  const extra = await mkdtemp(join(tmpdir(), "h2-extra-"));
  await writeFile(join(extra, "ok.txt"), "ok");
  const { approvals, calls } = stubApprovals();
  const cfg = defaultConfig(cwd);
  cfg.safety.readRoots = [extra];
  const guard = new PathGuard(cfg, approvals);
  const r = await guard.check("read", join(extra, "ok.txt"));
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
  await mkdir(join(cwd, "unused"), { recursive: true });
});
