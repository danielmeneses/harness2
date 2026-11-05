import { constants } from "node:fs";
import { chmod, copyFile, mkdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "./util.ts";

const LEGACY_FILES = ["config.json", "auth.json", "settings.json", "grants.json"];

/** Root for all harness-owned state. HARNESS2_HOME overrides for tests/portability. */
export function harnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.HARNESS2_HOME;
  if (custom && custom.trim()) return resolve(expandHome(custom));
  return join(homedir(), ".harness2");
}

export function harnessPath(...parts: string[]): string {
  return join(harnessHome(), ...parts);
}

export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(harnessHome(env), "sessions");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Move one legacy file without overwriting the new location. */
async function moveLegacyFile(src: string, dest: string): Promise<void> {
  if (await exists(dest)) return;
  try {
    await rename(src, dest);
  } catch {
    try {
      await copyFile(src, dest, constants.COPYFILE_EXCL);
      await unlink(src);
    } catch {
      return;
    }
  }
  await chmod(dest, 0o600).catch(() => {});
}

/** Copy auth/settings/grants/config from ~/.config/harness2 exactly once. */
async function migrateLegacyConfig(env: NodeJS.ProcessEnv, home: string): Promise<void> {
  if (env.HARNESS2_HOME) return;
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const legacy = join(xdg, "harness2");
  if (resolve(legacy) === resolve(home)) return;
  for (const name of LEGACY_FILES) {
    await moveLegacyFile(join(legacy, name), join(home, name)).catch(() => {});
  }
  await rmdir(legacy).catch(() => {});
}

export async function ensureHarnessHome(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const home = harnessHome(env);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700).catch(() => {});
  for (const name of ["sessions", "tmp"]) {
    const dir = join(home, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
  }
  await migrateLegacyConfig(env, home).catch(() => {});
  return home;
}
