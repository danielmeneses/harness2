import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { ToolContext, ToolImpl, ToolOutcome } from "./types.ts";
import { capOutput, denied, failure } from "./types.ts";
import { optInt, optString, reqString } from "./args.ts";
import { classifyBash } from "../safety/classify.ts";
import { isInside } from "../safety/paths.ts";
import type { Config } from "../config.ts";
import { sanitizeTerminal } from "../util.ts";

const HEAD_OUTPUT_CAP = 250_000;
const TAIL_OUTPUT_CAP = 250_000;

let bwrapChecked: boolean | null = null;
function hasBwrap(): boolean {
  if (bwrapChecked !== null) return bwrapChecked;
  const r = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  bwrapChecked = r.status === 0;
  return bwrapChecked;
}

function isNetworkReason(reason: string): boolean {
  return reason.startsWith("network") || reason.includes("URL");
}

const BASE_ENV_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
];

/** A deliberately small environment: no API keys, tokens, or host secrets. */
export function toolEnvironment(cfg: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of cfg.safety.envAllowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    PAGER: "cat",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    CLICOLOR: "0",
    FORCE_COLOR: "0",
    HARNESS2: "1",
  };
}

export async function runShell(
  args: { command: string; timeoutMs?: number; cwd?: string },
  ctx: ToolContext,
  callId: string | undefined,
  streamOutput: boolean,
): Promise<ToolOutcome> {
  const command = args.command;
  if (!command.trim()) return failure("command must not be empty");
  if (ctx.signal.aborted) return failure("aborted before the command started");

  let cwd = ctx.cfg.cwd;
  const extraMounts: string[] = [];
  if (args.cwd) {
    // The command directory is where the shell will write, so it needs write
    // authority. Read authority is not enough to run a command there.
    const g = await ctx.guard.check("write", args.cwd, "bash working directory", ctx.conv.id);
    if (!g.ok) return denied(g.reason);
    const s = await stat(g.path).catch(() => null);
    if (!s?.isDirectory()) return failure(`not a directory: ${args.cwd}`);
    cwd = g.path;
    if (g.approved) extraMounts.push(g.path);
  }

  const timeoutMs = Math.min(
    ctx.cfg.safety.bashTimeoutMs,
    Math.max(1000, args.timeoutMs ?? ctx.cfg.safety.bashTimeoutMs),
  );
  const reasons = classifyBash(command, ctx.cfg);
  const networkReasons = reasons.filter(isNetworkReason);
  const pathReasons = reasons.filter((r) => !isNetworkReason(r));
  const writableRoots = await ctx.guard.writeRoots();

  let useSandbox = ctx.cfg.safety.bashSandbox;
  if (useSandbox && !hasBwrap()) {
    return failure("bash sandbox is enabled but bwrap was not found on PATH");
  }

  let needsApproval = false;
  if (useSandbox) {
    if (ctx.cfg.safety.sandboxNetwork) {
      if (networkReasons.length && ctx.cfg.safety.network === "deny") {
        return denied(`network access is disabled by config: ${networkReasons.join("; ")}`);
      }
      if (networkReasons.length && ctx.cfg.safety.network === "ask") needsApproval = true;
    }
  } else {
    if (pathReasons.length) needsApproval = true;
    if (networkReasons.length) {
      if (ctx.cfg.safety.network === "deny") {
        return denied(`network access is disabled by config: ${networkReasons.join("; ")}`);
      }
      if (ctx.cfg.safety.network === "ask") needsApproval = true;
    }
  }

  if (needsApproval) {
    const res = await ctx.approvals.request({
      kind: "bash",
      title: "bash command needs approval",
      detail: [`$ ${command}`, ...reasons.map((r) => `reason: ${r}`)].join("\n"),
      key: `bash:${cwd}:${command}`,
      stream: ctx.conv.id,
    });
    if (res.decision === "deny") return denied(res.reason || "denied by the user");
  }

  const bashBin = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  let file = bashBin;
  let argv = ["-c", command];
  if (useSandbox) {
    argv = [
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--tmpfs",
      "/tmp",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
    ];
    // The sandbox starts with `/` read-only, then exposes only roots the host
    // already granted write access to. Outside reads stay possible because
    // system libraries must be readable; they are still approval-gated unless
    // `--sandbox` is explicitly used as containment.
    for (const root of [...new Set([...writableRoots, ...extraMounts])]) {
      const st = await stat(root).catch(() => null);
      if (!st?.isDirectory()) continue;
      argv.push("--bind", root, root);
    }
    // Do not expose the host home directory inside the sandbox. Bind an empty
    // tmpfs only when it is not itself an approved writable root.
    for (const dir of [...new Set([homedir(), "/root"])]) {
      // Never shadow an approved writable root (the cwd is usually under home).
      const overlaps = [...writableRoots, ...extraMounts].some(
        (root) => isInside(dir, root) || isInside(root, dir),
      );
      if (overlaps) continue;
      const st = await stat(dir).catch(() => null);
      if (st?.isDirectory()) argv.push("--tmpfs", dir);
    }
    if (!ctx.cfg.safety.sandboxNetwork) argv.push("--unshare-net");
    argv.push("--chdir", cwd, "--", bashBin, "-c", command);
    file = "bwrap";
  }

  const started = Date.now();
  const decoder = new StringDecoder("utf8");
  let head = "";
  let tail = "";
  let omitted = 0;
  let liveBuf = "";
  let lastLive = 0;
  let timedOut = false;
  let aborted = false;
  let settled = false;

  const child = spawn(file, argv, {
    cwd,
    env: toolEnvironment(ctx.cfg),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const flushLive = (): void => {
    if (!callId || !streamOutput || !liveBuf) return;
    ctx.emit(ctx.conv.id, { t: "tool.output.delta", id: callId, name: "bash", text: liveBuf });
    liveBuf = "";
    lastLive = Date.now();
  };

  const collect = (text: string): void => {
    if (!text) return;
    if (head.length < HEAD_OUTPUT_CAP) {
      const room = HEAD_OUTPUT_CAP - head.length;
      head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    tail += text;
    if (tail.length > TAIL_OUTPUT_CAP) {
      const drop = tail.length - TAIL_OUTPUT_CAP;
      omitted += drop;
      tail = tail.slice(drop);
    }
  };
  const outputText = (): string => (head + (omitted ? `\n… [${omitted} chars omitted] …\n` : "") + tail);
  const append = (chunk: Buffer): void => {
    const text = decoder.write(chunk);
    collect(text);
    if (streamOutput && callId) {
      liveBuf += text;
      if (Date.now() - lastLive > 80 || liveBuf.length > 4096) flushLive();
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const kill = (): void => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const finish = (code: number | null, signal: NodeJS.Signals | null): ToolOutcome => {
    if (settled) return failure("command already finished");
    settled = true;
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    const rest = decoder.end();
    if (rest) {
      collect(rest);
      liveBuf += rest;
    }
    flushLive();
    let output = outputText();
    if (code !== null && code !== 0) output += `\n[exit code ${code}]`;
    if (signal) output += `\n[terminated by ${signal}]`;
    if (timedOut) output += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
    if (aborted) output += "\n[aborted]";
    const clean = sanitizeTerminal(output).trimEnd();
    return {
      ok: code === 0 && !timedOut && !aborted,
      output: capOutput(clean || "(no output)", ctx.cfg.safety.toolOutputChars),
      meta: {
        exitCode: code ?? 1,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        sandbox: useSandbox,
      },
    };
  };

  return await new Promise<ToolOutcome>((resolve) => {
    child.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve(failure(`failed to start command: ${e.message}`));
    });
    child.once("close", (code, signal) => resolve(finish(code, signal)));
  });
}

export const bashTool: ToolImpl = {
  spec: {
    name: "bash",
    description:
      "Run a shell command in the working directory. Streams output. Network commands and paths outside the working directory require approval (or are blocked by the sandbox). Use for tests, builds, git, and anything the file tools do not cover.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to run with bash -c." },
        timeoutMs: { type: "integer", description: "Timeout in milliseconds (clamped to the configured maximum)." },
        cwd: { type: "string", description: "Working directory (default: repository root)." },
      },
      required: ["command"],
    },
  },
  async execute(args, ctx, callId) {
    const command = reqString(args, "command");
    const timeoutMs = args.timeoutMs === undefined ? undefined : optInt(args, "timeoutMs", ctx.cfg.safety.bashTimeoutMs);
    const cwd = optString(args, "cwd");
    return runShell({ command, timeoutMs, cwd }, ctx, callId, true);
  },
};

export const bashTools: ToolImpl[] = [bashTool];
