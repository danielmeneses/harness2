import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Config } from "../config.ts";
import { expandHome } from "../util.ts";
import type { Approvals } from "./approvals.ts";

const ALLOWED_DEV = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

export function isInside(child: string, root: string): boolean {
  if (root === sep) return child.startsWith(sep);
  const r = root.endsWith(sep) ? root : root + sep;
  return child === root || child.startsWith(r);
}

export function isInsideAny(child: string, roots: string[]): boolean {
  return roots.some((root) => isInside(child, root));
}

export function toAbs(cwd: string, p: string): string {
  return resolve(cwd, expandHome(p));
}

/** Resolve symlinks for an existing path, or for the nearest existing parent. */
export async function realish(input: string): Promise<string> {
  let p = resolve(input);
  const rest: string[] = [];
  while (true) {
    try {
      const rp = await realpath(p);
      return rest.length ? join(rp, ...rest.reverse()) : rp;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return rest.length ? join(p, ...rest.reverse()) : p;
      }
      const parent = dirname(p);
      if (parent === p) return rest.length ? join(p, ...rest.reverse()) : p;
      rest.push(basename(p));
      p = parent;
    }
  }
}

export type CheckResult = { ok: true; path: string; approved: boolean } | { ok: false; reason: string };

export class PathGuard {
  #cfg: Config;
  #approvals: Approvals;
  #roots: Partial<Record<"read" | "write", string[]>> = {};

  constructor(cfg: Config, approvals: Approvals) {
    this.#cfg = cfg;
    this.#approvals = approvals;
  }

  async #rootList(kind: "read" | "write"): Promise<string[]> {
    const cached = this.#roots[kind];
    if (cached) return cached;
    const extra = kind === "read" ? this.#cfg.safety.readRoots : this.#cfg.safety.writeRoots;
    const roots = [this.#cfg.cwd, ...extra, ...this.#cfg.safety.allowedPaths];
    const resolved = await Promise.all(roots.map((r) => realish(r)));
    this.#roots[kind] = [...new Set(resolved)];
    return this.#roots[kind] as string[];
  }

  /** Canonical roots the host allows writes to without an approval. */
  async writeRoots(): Promise<string[]> {
    return this.#rootList("write");
  }

  async check(
    kind: "read" | "write",
    input: string,
    detail?: string,
    stream = "main",
  ): Promise<CheckResult> {
    if (!input.trim()) return { ok: false, reason: "empty path" };
    const abs = await realish(toAbs(this.#cfg.cwd, input));
    if (ALLOWED_DEV.has(abs)) return { ok: true, path: abs, approved: false };
    const roots = await this.#rootList(kind);
    if (isInsideAny(abs, roots)) return { ok: true, path: abs, approved: false };

    const decision = await this.#approvals.request({
      kind,
      title: `${kind} outside the working directory`,
      detail: [abs, detail].filter(Boolean).join("\n"),
      key: `${kind}:${abs}`,
      stream,
    });
    if (decision.decision === "deny") {
      return { ok: false, reason: decision.reason || "denied by the user" };
    }
    return { ok: true, path: abs, approved: true };
  }
}

export function looksAbsolute(p: string): boolean {
  return isAbsolute(expandHome(p));
}
