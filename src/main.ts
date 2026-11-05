#!/usr/bin/env node
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs, HELP } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { applyAuth, loadAuth, saveAuth, NATIVE_PROVIDERS } from "./auth.ts";
import { applySettings, loadSettings, updateSettings } from "./settings.ts";
import { DELTA_EVENTS, EventBus } from "./events.ts";
import { Approvals } from "./safety/approvals.ts";
import { PathGuard } from "./safety/paths.ts";
import { createProvider } from "./provider/index.ts";
import { listModelInfo } from "./provider/models.ts";
import { applyTokens, ensureFreshTokens, fetchOpenAIModels } from "./provider/openai-oauth.ts";
import { maxEffort, supportsEffort } from "./reasoning.ts";
import { Runner } from "./loop/kernel.ts";
import { clampToHost, defaultSpec } from "./loop/spec.ts";
import type { SpecLimits } from "./loop/limits.ts";
import type { Conversation } from "./loop/state.ts";
import { latestSession, loadSession, migrateProjectState, newSessionMeta, SessionStore, type LoadedSession } from "./session.ts";
import { runInteractive } from "./modes/interactive.ts";
import { runPrint } from "./modes/print.ts";
import { errorMessage, readStdin } from "./util.ts";
import { defaultSessionsDir, ensureHarnessHome } from "./home.ts";

const VERSION =
  (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ??
  "0.0.0";

async function readAgentsMd(cwd: string): Promise<string> {
  const raw = await readFile(join(cwd, "AGENTS.md"), "utf8").catch(() => "");
  return raw.length > 20_000 ? `${raw.slice(0, 20_000)}\n… (truncated)` : raw;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (flags.version) {
    process.stdout.write(`harness2 ${VERSION}\n`);
    return;
  }

  const cwd = process.cwd();
  await ensureHarnessHome().catch(() => {});
  const cfg = await loadConfig(cwd, {
    patch: flags.patch,
    configPath: flags.configPath ?? process.env.HARNESS2_CONFIG,
  });
  const settings = await loadSettings(cwd);
  applySettings(cfg, settings, {
    model: flags.explicit.model || !!process.env.HARNESS2_MODEL,
    effort: flags.explicit.effort || !!process.env.HARNESS2_REASONING_EFFORT,
    mode: flags.explicit.mode || !!process.env.HARNESS2_MODE,
    contextWindow: flags.explicit.contextWindow || !!process.env.HARNESS2_CONTEXT_WINDOW,
    approvals: flags.explicit.approvals,
    network: flags.explicit.network || !!process.env.HARNESS2_NETWORK,
    bashSandbox: flags.explicit.sandbox || !!process.env.HARNESS2_SANDBOX,
    loopChanges: flags.explicit.loopChanges,
    showThinking: flags.explicit.showThinking,
  });
  const auth = await loadAuth();
  const explicitEffort = flags.explicit.effort || !!process.env.HARNESS2_REASONING_EFFORT;
  const explicitBase =
    flags.explicit.baseUrl || !!process.env.HARNESS2_BASE_URL || !!process.env.OPENAI_BASE_URL;
  // Never send a saved API key to a base URL the user explicitly overrode.
  const activeAuth = explicitBase
    ? null
    : applyAuth(cfg, auth, {
        apiKey: flags.explicit.apiKey || !!process.env.HARNESS2_API_KEY || !!process.env.OPENAI_API_KEY,
        model: flags.explicit.model || !!process.env.HARNESS2_MODEL,
        mode: flags.explicit.mode || !!process.env.HARNESS2_MODE,
        effort: explicitEffort,
        contextWindow: flags.explicit.contextWindow || !!process.env.HARNESS2_CONTEXT_WINDOW,
      });
  let currentInfo: Awaited<ReturnType<typeof listModelInfo>>[number] | undefined;
  try {
    let infos: Awaited<ReturnType<typeof listModelInfo>>;
    const activeProfile = activeAuth ? auth.providers[activeAuth] : undefined;
    if (activeAuth === "openai" && activeProfile?.oauth) {
      const tokens = await ensureFreshTokens(activeProfile);
      applyTokens(activeProfile, tokens);
      await saveAuth(auth);
      cfg.provider.apiKey = tokens.accessToken;
      if (tokens.accountId) {
        cfg.provider.headers["chatgpt-account-id"] = tokens.accountId;
        cfg.provider.headers.originator = "codex_cli_rs";
      }
      infos = await fetchOpenAIModels(tokens);
    } else {
      infos = await listModelInfo({
        baseUrl: cfg.provider.baseUrl,
        apiKey: cfg.provider.apiKey,
        headers: cfg.provider.headers,
        timeoutMs: 3000,
      });
    }
    currentInfo = infos.find((candidate) => candidate.id === cfg.provider.model);
    if (currentInfo?.contextWindow) {
      cfg.provider.contextWindow = currentInfo.contextWindow;
      cfg.provider.contextWindowReported = true;
    }
  } catch {
    // Offline/custom servers: keep the configured window and mark it as fallback.
  }
  const configuredEfforts = cfg.provider.modelEfforts[cfg.provider.model];
  const nativeEfforts = activeAuth ? (NATIVE_PROVIDERS[activeAuth].defaultEfforts ?? []) : undefined;
  const availableEfforts =
    currentInfo?.efforts !== undefined
      ? currentInfo.efforts
      : configuredEfforts !== undefined
        ? configuredEfforts
        : nativeEfforts;
  if (availableEfforts && !explicitEffort && !supportsEffort(cfg.reasoning.effort, availableEfforts)) {
    cfg.reasoning.effort = maxEffort(availableEfforts);
    if (activeAuth) {
      const profile = auth.providers[activeAuth];
      if (profile) {
        profile.effort = cfg.reasoning.effort;
        try {
          await saveAuth(auth);
        } catch {
          // The runtime choice is still valid for this session.
        }
      }
    }
    await updateSettings({ effort: cfg.reasoning.effort }).catch(() => {});
  }
  if (flags.json) flags.print = true;
  const interactive = !flags.print && !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (!interactive && !flags.prompt && process.stdin.isTTY) {
    throw new Error("no prompt provided (pass a prompt, pipe stdin, or run without -p for interactive mode)");
  }

  const limits: SpecLimits = { maxStepsCap: cfg.loop.maxStepsCap, contextWindow: cfg.provider.contextWindow };
  const bus = new EventBus();
  const sessionRef: { current: SessionStore | null } = { current: null };
  let feed: ReturnType<typeof createWriteStream> | null = null;
  if (flags.eventsFile) {
    const path = resolve(cwd, flags.eventsFile);
    await mkdir(dirname(path), { recursive: true });
    feed = createWriteStream(path, { flags: "a" });
    feed.on("error", () => {});
  }

  bus.subscribe((ev) => {
    if (!DELTA_EVENTS.has(ev.t)) sessionRef.current?.append(ev);
    if (feed) feed.write(`${JSON.stringify(ev)}\n`);
    if (flags.json) process.stdout.write(`${JSON.stringify(ev)}\n`);
  });

  const approvals = new Approvals(cfg, bus.emit);
  await approvals.init();
  const guard = new PathGuard(cfg, approvals);
  const provider = createProvider(cfg);
  const runner = new Runner({
    cfg,
    provider,
    approvals,
    guard,
    emit: bus.emit,
    agentsMd: await readAgentsMd(cwd),
  });

  await migrateProjectState(cwd, cfg.session.dir, resolve(cfg.session.dir) === resolve(defaultSessionsDir())).catch(() => {});

  let resumed: LoadedSession | null = null;
  if (flags.session) {
    resumed = await loadSession(resolve(cwd, flags.session), limits);
  } else if (flags.continue) {
    const latest = await latestSession(cfg.session.dir, cwd);
    if (!latest) throw new Error("no previous session found in this working directory");
    resumed = await loadSession(latest, limits);
  }

  let conv: Conversation;
  if (resumed) {
    conv = runner.createConversation("main", "main", 0);
    conv.messages = resumed.messages;
    try {
      conv.spec = clampToHost(resumed.spec, limits);
    } catch {
      conv.spec = defaultSpec(limits);
    }
    conv.stageIndex = Math.min(resumed.stageIndex, conv.spec.stages.length - 1);
    conv.notes = resumed.notes;
    conv.todos = resumed.todos;
    conv.usage = {
      prompt: resumed.usage.promptTokens ?? 0,
      completion: resumed.usage.completionTokens ?? 0,
    };
    conv.contextTokens = resumed.contextTokens;
    conv.contextReported = resumed.contextReported;
  } else {
    conv = runner.createConversation("main", "main", 0);
  }

  if (resumed) {
    sessionRef.current = await SessionStore.open(resumed.path);
    if (resumed.meta) {
      bus.emit("main", { t: "session.resume", path: resumed.path });
    } else {
      const meta = newSessionMeta(cwd, cfg.provider.model, provider.mode, VERSION);
      bus.emit("main", {
        t: "session.start",
        id: meta.id,
        cwd,
        model: cfg.provider.model,
        mode: provider.mode,
        version: VERSION,
      });
    }
  } else if (cfg.session.enabled) {
    const meta = newSessionMeta(cwd, cfg.provider.model, provider.mode, VERSION);
    sessionRef.current = await SessionStore.create(cfg.session.dir, meta);
    bus.emit("main", {
      t: "session.start",
      id: meta.id,
      cwd,
      model: cfg.provider.model,
      mode: provider.mode,
      version: VERSION,
    });
  } else if (flags.json || feed) {
    const meta = newSessionMeta(cwd, cfg.provider.model, provider.mode, VERSION);
    bus.emit("main", {
      t: "session.start",
      id: meta.id,
      cwd,
      model: cfg.provider.model,
      mode: provider.mode,
      version: VERSION,
    });
  }

  try {
    if (interactive) {
      await runInteractive({
        cfg,
        runner,
        bus,
        approvals,
        sessionRef,
        conv,
        resumed: resumed
          ? { path: resumed.path, messages: resumed.messages.length, lastAssistant: resumed.lastAssistant }
          : null,
        initialHistory: resumed?.events,
        authProvider: activeAuth ?? undefined,
        initialPrompt: flags.prompt || undefined,
        version: VERSION,
      });
    } else {
      let prompt = flags.prompt.trim();
      if (!prompt && !process.stdin.isTTY) prompt = (await readStdin()).trim();
      if (!prompt) throw new Error("no prompt provided");
      process.exitCode = await runPrint({ runner, conv, prompt, json: flags.json, bus });
    }
  } finally {
    await sessionRef.current?.close();
    if (feed) {
      await new Promise<void>((resolveEnd) => feed?.end(resolveEnd));
    }
  }
}

main().catch((e) => {
  process.stderr.write(`harness2: ${errorMessage(e)}\n`);
  process.exitCode = 1;
});
