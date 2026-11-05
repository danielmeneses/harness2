import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureHarnessHome, harnessHome } from "../src/home.ts";

test("harnessHome honors HARNESS2_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2-home-"));
  assert.equal(harnessHome({ HARNESS2_HOME: root }), root);
});

test("ensureHarnessHome creates the private home and subdirectories", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2-home-"));
  const home = join(root, "state");
  assert.equal(await ensureHarnessHome({ HARNESS2_HOME: home }), home);
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  for (const name of ["sessions", "tmp"]) {
    assert.equal((await stat(join(home, name))).mode & 0o777, 0o700);
  }
});

test("install-time setup migrates the legacy config directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2-home-legacy-"));
  const legacy = join(root, ".config", "harness2");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "auth.json"), '{"providers":{}}\n');
  const oldHome = process.env.HOME;
  const oldXdg = process.env.XDG_CONFIG_HOME;
  const oldH2 = process.env.HARNESS2_HOME;
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, ".config");
  delete process.env.HARNESS2_HOME;
  try {
    const home = await ensureHarnessHome({ HOME: root, XDG_CONFIG_HOME: join(root, ".config") });
    assert.equal(home, join(root, ".harness2"));
    assert.equal(await readFile(join(home, "auth.json"), "utf8"), '{"providers":{}}\n');
    await assert.rejects(stat(join(legacy, "auth.json")));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdg;
    if (oldH2 === undefined) delete process.env.HARNESS2_HOME;
    else process.env.HARNESS2_HOME = oldH2;
  }
});
