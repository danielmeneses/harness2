import { spawnSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeBaseUrl, type Config } from "../config.ts";
import type { Event, EventBus } from "../events.ts";
import type { Approvals } from "../safety/approvals.ts";
import { createProvider } from "../provider/index.ts";
import type { Runner } from "../loop/kernel.ts";
import type { Conversation } from "../loop/state.ts";
import type { SpecLimits } from "../loop/limits.ts";
import { clampToHost, defaultSpec, formatSpec, normalizeSpec, presetNames, presetSpec } from "../loop/spec.ts";
import {
  appendHistory,
  exportMarkdown,
  historyPath,
  listSessions,
  loadHistory,
  loadSession,
  newSessionMeta,
  SessionStore,
} from "../session.ts";
import { Terminal } from "../ui/terminal.ts";
import { Renderer } from "../ui/renderer.ts";
import { Editor } from "../ui/editor.ts";
import type { ControlPanel } from "../ui/control.ts";
import { ALL_TOOLS } from "../tools/index.ts";
import { SLASH_COMMANDS, commandLabel } from "../commands.ts";
import {
  loadAuth,
  saveAuth,
  setProfile,
  NATIVE_PROVIDERS,
  isNativeProviderId,
  nativeProviderIds,
  type AuthProfile,
  type NativeProviderId,
} from "../auth.ts";
import { listModelInfo, type ModelInfo } from "../provider/models.ts";
import {
  applyTokens,
  ensureFreshTokens,
  fetchOpenAIModels,
  loginOpenAI,
} from "../provider/openai-oauth.ts";
import { effortChoices, maxEffort, parseReasoningEffort, supportsEffort } from "../reasoning.ts";
import { updateSettings, type Settings } from "../settings.ts";
import type { ReasoningEffort } from "../types.ts";
import { errorMessage, fmtTokens, oneLine, sanitizeTerminal } from "../util.ts";
import { harnessHome } from "../home.ts";

export type InteractiveDeps = {
  cfg: Config;
  runner: Runner;
  bus: EventBus;
  approvals: Approvals;
  sessionRef: { current: SessionStore | null };
  conv: Conversation;
  resumed: { path: string; messages: number; lastAssistant: string } | null;
  initialHistory?: Event[];
  initialPrompt?: string;
  authProvider?: string;
  version: string;
};

function limitsFor(cfg: Config): SpecLimits {
  return { maxStepsCap: cfg.loop.maxStepsCap, contextWindow: cfg.provider.contextWindow };
}

export async function runInteractive(deps: InteractiveDeps): Promise<void> {
  const cfg = deps.cfg;
  const term = new Terminal();
  const renderer = new Renderer(term, {
    showThinking: cfg.ui.showThinking,
    color: cfg.ui.color,
    header: `harness2 ${deps.version} · ${cfg.provider.model} · ${cfg.cwd}\nsafety: approvals ${cfg.safety.approvals} · network ${cfg.safety.network} · sandbox ${cfg.safety.bashSandbox ? "on" : "off"}`,
  });
  if (deps.initialHistory?.length) renderer.setHistory(deps.initialHistory);

  const persistSettings = async (patch: Partial<Settings>): Promise<void> => {
    try {
      await updateSettings(patch);
    } catch (e) {
      renderer.showError(`could not save settings: ${errorMessage(e)}`);
    }
  };
  const toggleThinkingDisplay = async (): Promise<void> => {
    renderer.toggleThinking();
    cfg.ui.showThinking = renderer.showThinking;
    await persistSettings({ showThinking: renderer.showThinking });
  };

  const updateActiveProfile = async (patch: {
    model?: string;
    effort?: ReasoningEffort;
    mode?: Config["provider"]["mode"];
    contextWindow?: number | null;
  }): Promise<void> => {
    try {
      const auth = await loadAuth();
      if (!auth.active) return;
      const profile = auth.providers[auth.active];
      if (!profile) return;
      if (patch.model !== undefined) profile.model = patch.model;
      if (patch.effort !== undefined) profile.effort = patch.effort;
      if (patch.mode !== undefined) profile.mode = patch.mode;
      if (patch.contextWindow !== undefined) {
        if (patch.contextWindow === null) delete profile.contextWindow;
        else profile.contextWindow = patch.contextWindow;
      }
      await saveAuth(auth);
    } catch (e) {
      renderer.showError(`could not save auth: ${errorMessage(e)}`);
    }
  };
  const unsubscribe = renderer.attach(deps.bus);
  deps.approvals.setHandler((req) => renderer.askApproval(req));

  let conv = deps.conv;
  let currentProviderId: NativeProviderId | undefined =
    deps.authProvider && isNativeProviderId(deps.authProvider) ? deps.authProvider : undefined;
  const nativeEfforts = (id?: NativeProviderId): ReasoningEffort[] =>
    id ? (NATIVE_PROVIDERS[id].defaultEfforts ?? []) : [];
  const control = (): ControlPanel => ({
    model: cfg.provider.model,
    effort: cfg.reasoning.effort,
    completionTokens: conv.usage.completion,
    promptTokens: conv.usage.prompt,
    contextTokens: conv.contextTokens,
    contextWindow: cfg.provider.contextWindow,
    contextWindowReported: cfg.provider.contextWindowReported,
    contextReported: conv.contextReported,
  });
  renderer.setControl(control);
  const availableEfforts = (
    model: string,
    reported?: ReasoningEffort[],
    providerId = currentProviderId,
  ): ReasoningEffort[] =>
    reported !== undefined
      ? reported
      : (cfg.provider.modelEfforts[model] ?? nativeEfforts(providerId));
  const effortSummary = (available: ReasoningEffort[]): string =>
    available.length ? available.join("/") : "auto only";
  const fetchCurrentProviderModels = async (): Promise<ModelInfo[]> => {
    if (currentProviderId === "openai") {
      const auth = await loadAuth();
      const profile = auth.providers.openai;
      if (profile?.oauth) {
        const tokens = await ensureFreshTokens(profile);
        applyTokens(profile, tokens);
        await saveAuth(auth);
        cfg.provider.apiKey = tokens.accessToken;
        if (tokens.accountId) {
          cfg.provider.headers["chatgpt-account-id"] = tokens.accountId;
          cfg.provider.headers.originator = "codex_cli_rs";
        }
        return fetchOpenAIModels(tokens);
      }
    }
    return listModelInfo({
      baseUrl: cfg.provider.baseUrl,
      apiKey: cfg.provider.apiKey,
      headers: cfg.provider.headers,
    });
  };
  const fetchModelInfo = async (model: string): Promise<ModelInfo | undefined> => {
    try {
      const infos = await fetchCurrentProviderModels();
      return infos.find((info) => info.id === model);
    } catch {
      return undefined;
    }
  };
  const refreshCurrentEfforts = async (): Promise<ReasoningEffort[]> => {
    try {
      const infos = await fetchCurrentProviderModels();
      const info = infos.find((candidate) => candidate.id === cfg.provider.model);
      if (info?.contextWindow) {
        cfg.provider.contextWindow = info.contextWindow;
        cfg.provider.contextWindowReported = true;
        await persistSettings({ contextWindow: info.contextWindow });
        await updateActiveProfile({ contextWindow: info.contextWindow });
      } else {
        cfg.provider.contextWindow = cfg.provider.contextWindowFallback;
        cfg.provider.contextWindowReported = false;
        await updateActiveProfile({ contextWindow: null });
        await persistSettings({ contextWindow: cfg.provider.contextWindowFallback });
      }
      return availableEfforts(cfg.provider.model, info?.efforts);
    } catch (e) {
      renderer.showError(`could not read model efforts: ${errorMessage(e)}`);
      return availableEfforts(cfg.provider.model);
    }
  };
  let currentAbort: AbortController | null = null;

  term.setDefaultHandler((key) => {
    if (key.type === "escape") {
      if (currentAbort) {
        currentAbort.abort();
        renderer.showNotice("esc aborting");
      }
    } else if (key.type === "ctrl" && key.ch === "c") {
      if (currentAbort) {
        currentAbort.abort();
        renderer.showNotice("^C aborting");
      }
    } else if (key.type === "ctrl" && key.ch === "o") {
      void toggleThinkingDisplay();
    }
  });

  const history = await loadHistory(historyPath());
  const editor = new Editor(term, history, { color: cfg.ui.color });
  editor.setControl(control);

  const info = (text: string): void => {
    renderer.flushAll();
    const normalized = sanitizeTerminal(text.replace(/\r\n/g, "\n")).replace(/\n/g, "\r\n");
    term.write(normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`);
  };

  await term.start();
  term.setMode("modal");
  if (deps.initialHistory?.length) {
    renderer.replayTranscript();
    renderer.blankLine();
  }
  info(`harness2 ${deps.version} · ${cfg.provider.model} · ${deps.runner.provider.mode}`);
  info(`cwd: ${cfg.cwd}`);
  info(
    `safety: approvals ${cfg.safety.approvals}${cfg.safety.approveAll ? " (approve-all)" : ""} · network ${cfg.safety.network} · sandbox ${cfg.safety.bashSandbox ? "on" : "off"}`,
  );
  if (deps.resumed) {
    info(`resumed ${deps.resumed.path} (${deps.resumed.messages} messages)`);
    if (deps.resumed.lastAssistant) info(`last: ${oneLine(deps.resumed.lastAssistant, 160)}`);
  }
  if (deps.authProvider) info(`provider: ${deps.authProvider} (saved login · /logout to clear)`);
  info(`thinking: ${cfg.ui.showThinking ? "expanded" : "collapsed"} · Ctrl-O toggles all`);
  info(`/help for commands · Esc aborts · Ctrl-O toggles all thinking · Ctrl-D exits`);
  renderer.blankLine();

  const applyUserSpec = (input: unknown, reason: string): void => {
    try {
      const spec = normalizeSpec(input, limitsFor(cfg));
      conv.spec = spec;
      if (conv.stageIndex >= spec.stages.length) conv.stageIndex = 0;
      conv.pendingMutations = [];
      conv.specVersion++;
      conv.stageSteps = 0;
      conv.stageTools = [];
      deps.bus.emit(conv.id, { t: "loop.spec", spec, by: "user", reason });
      deps.bus.emit(conv.id, {
        t: "loop.stage",
        id: spec.stages[conv.stageIndex].id,
        index: conv.stageIndex,
        total: spec.stages.length,
        step: 0,
      });
    } catch (e) {
      renderer.showError(`invalid loop spec: ${errorMessage(e)}`);
    }
  };

  const editLoop = async (): Promise<void> => {
    const tmpDir = join(harnessHome(), "tmp");
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const path = join(tmpDir, `harness2-loop-${process.pid}.json`);
    await writeFile(path, `${formatSpec(conv.spec)}\n`);
    term.stop();
    const editorCmd = (process.env.EDITOR || process.env.VISUAL || "vi").trim();
    const parts = editorCmd.split(/\s+/);
    const result = spawnSync(parts[0], [...parts.slice(1), path], { stdio: "inherit" });
    await term.start();
    term.setMode("modal");
    // Restore the transcript after the external editor before printing status.
    renderer.replayTranscript();
    if (result.error) {
      renderer.showError(`could not run editor: ${result.error.message}`);
      await unlink(path).catch(() => {});
      return;
    }
    if (result.status !== 0) {
      renderer.showError(`editor exited with status ${result.status ?? "?"}`);
      await unlink(path).catch(() => {});
      return;
    }
    const raw = await readFile(path, "utf8").catch(() => null);
    await unlink(path).catch(() => {});
    if (!raw) return;
    try {
      applyUserSpec(JSON.parse(raw), "edited by the user");
    } catch (e) {
      renderer.showError(`invalid JSON in loop spec: ${errorMessage(e)}`);
    }
  };

  const handleSlash = async (input: string): Promise<boolean> => {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0];
    const arg = parts.slice(1).join(" ");
    switch (cmd) {
      case "/quit":
      case "/exit":
      case "/q":
        return true;
      case "/help": {
        const width = Math.max(...SLASH_COMMANDS.map((command) => commandLabel(command).length));
        info(
          [
            "commands (type / to filter · ↑/↓ select · Tab insert · Enter run):",
            ...SLASH_COMMANDS.map((command) => `  ${commandLabel(command).padEnd(width)}  ${command.description}`),
            "",
            "option menus (model, effort, login, mode, safety, loop presets):",
            "  type to filter · ↑/↓ select · Enter choose · Esc/Ctrl-C cancel",
            "  fixed choices persist in ~/.harness2/settings.json; loop presets live in the session spec",
            "",
            `loop presets: ${presetNames().join(", ")}`,
            "",
            "keys:",
            "  Esc                abort a running turn / cancel a menu",
            "  Ctrl-O             toggle all thinking",
            "  Ctrl-C             clear input / abort turn / exit when empty",
            "  Ctrl-D             exit",
            "  Alt+Enter, Ctrl-J  insert a newline",
            "  ↑ / ↓              history, or command selection",
            "  Tab                insert the selected command",
            "  Ctrl-A/E/U/K/W     line editing",
          ].join("\n"),
        );
        return false;
      }
      case "/login": {
        let id = arg.trim() as NativeProviderId;
        if (!id) {
          const chosen = await editor.select(
            nativeProviderIds().map((pid) => ({
              value: pid,
              label: pid,
              description: NATIVE_PROVIDERS[pid].oauth
                ? `ChatGPT OAuth · ${NATIVE_PROVIDERS[pid].baseUrl}`
                : `${NATIVE_PROVIDERS[pid].needsBaseUrl ? "base URL + API key" : "API key only"} · ${NATIVE_PROVIDERS[pid].baseUrl}`,
            })),
            "native providers",
          );
          if (!chosen) {
            renderer.showNotice("login cancelled");
            return false;
          }
          id = chosen as NativeProviderId;
        }
        const meta = NATIVE_PROVIDERS[id];
        if (!meta) {
          renderer.showError(`unknown provider ${id}; available: ${nativeProviderIds().join(", ")}`);
          return false;
        }
        const auth = await loadAuth();
        if (meta.oauth) {
          info("starting OpenAI OAuth; a browser window should open (or use the URL below)...");
          let tokens;
          try {
            tokens = await loginOpenAI((url) => {
              info("Open this URL to sign in to OpenAI:");
              info(url);
            });
          } catch (e) {
            renderer.showError(`OpenAI OAuth failed: ${errorMessage(e)}`);
            return false;
          }
          let models: ModelInfo[];
          try {
            models = await fetchOpenAIModels(tokens);
          } catch (e) {
            renderer.showError(`OpenAI login succeeded but model catalog failed: ${errorMessage(e)}`);
            return false;
          }
          if (!models.length) {
            renderer.showError("OpenAI returned no models");
            return false;
          }
          const previous = auth.providers[id];
          const preferred = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol"].find((id) =>
            models.some((model) => model.id === id),
          );
          const chosen =
            previous?.model &&
            previous.model !== "codex-auto-review" &&
            models.some((model) => model.id === previous.model)
              ? previous.model
              : (preferred ?? models[0].id);
          const selected = models.find((model) => model.id === chosen);
          const available = availableEfforts(chosen, selected?.efforts, id);
          const effort = maxEffort(available);
          const contextWindow = selected?.contextWindow;
          const profile: AuthProfile = {
            baseUrl: meta.baseUrl,
            apiKey: tokens.accessToken,
            mode: meta.mode,
            model: chosen,
            effort,
            contextWindow,
            oauth: {
              refreshToken: tokens.refreshToken,
              expiresAt: tokens.expiresAt,
              accountId: tokens.accountId,
            },
          };
          setProfile(auth, id, profile);
          try {
            await saveAuth(auth);
          } catch (e) {
            renderer.showError(`could not save auth: ${errorMessage(e)}`);
          }
          currentProviderId = id;
          cfg.provider.baseUrl = profile.baseUrl;
          cfg.provider.apiKey = profile.apiKey;
          cfg.provider.mode = profile.mode;
          cfg.provider.model = chosen;
          cfg.reasoning.effort = effort;
          if (contextWindow) {
            cfg.provider.contextWindow = contextWindow;
            cfg.provider.contextWindowReported = true;
          } else {
            cfg.provider.contextWindow = cfg.provider.contextWindowFallback;
            cfg.provider.contextWindowReported = false;
          }
          if (tokens.accountId) {
            cfg.provider.headers["chatgpt-account-id"] = tokens.accountId;
            cfg.provider.headers.originator = "codex_cli_rs";
          }
          deps.runner.setProvider(createProvider(cfg));
          await persistSettings({
            model: chosen,
            effort,
            mode: profile.mode,
            contextWindow: cfg.provider.contextWindow,
          });
          info(
            `logged in to ${meta.label} · model: ${chosen} · effort: ${effort} · efforts ${effortSummary(available)}${contextWindow ? ` · context ${fmtTokens(contextWindow)}` : ""}${models.length ? ` · ${models.length} models (/models to switch)` : ""}`,
          );
          return false;
        }
        let baseUrl = meta.baseUrl;
        if (meta.needsBaseUrl) {
          const fallback = auth.providers[id]?.baseUrl ?? meta.baseUrl;
          const input = await term.readLine(`${meta.label} base URL [${fallback}]> `);
          if (input === null) {
            renderer.showNotice("login cancelled");
            return false;
          }
          try {
            baseUrl = normalizeBaseUrl(input.trim() || fallback);
          } catch (e) {
            renderer.showError(errorMessage(e));
            return false;
          }
        }
        let apiKey = "";
        if (meta.apiKey === "required") {
          const input = await term.readSecret(`${meta.label} API key> `);
          if (input === null || !input.trim()) {
            renderer.showNotice("login cancelled");
            return false;
          }
          apiKey = input.trim();
        } else {
          const input = await term.readSecret(`${meta.label} API key (empty for none)> `);
          if (input === null) {
            renderer.showNotice("login cancelled");
            return false;
          }
          apiKey = input.trim();
        }
        info(`validating ${meta.label} at ${baseUrl}...`);
        let infos: ModelInfo[];
        try {
          infos = await listModelInfo({ baseUrl, apiKey, headers: cfg.provider.headers });
        } catch (e) {
          renderer.showError(`login failed: ${errorMessage(e)}`);
          return false;
        }
        const models = infos.map((model) => model.id);
        const previous = auth.providers[id];
        const chosenModel = previous?.model && models.includes(previous.model) ? previous.model : models[0];
        const selectedInfo = infos.find((model) => model.id === chosenModel);
        const available = availableEfforts(chosenModel ?? cfg.provider.model, selectedInfo?.efforts, id);
        currentProviderId = id;
        const profile: AuthProfile = {
          baseUrl,
          apiKey,
          mode: meta.mode,
          model: chosenModel,
          effort: maxEffort(available),
          contextWindow: selectedInfo?.contextWindow,
        };
        setProfile(auth, id, profile);
        try {
          await saveAuth(auth);
        } catch (e) {
          renderer.showError(`could not save auth: ${errorMessage(e)}`);
        }
        cfg.provider.baseUrl = baseUrl;
        cfg.provider.apiKey = apiKey;
        cfg.provider.mode = meta.mode;
        if (profile.model) cfg.provider.model = profile.model;
        if (profile.effort) cfg.reasoning.effort = profile.effort;
        if (selectedInfo?.contextWindow) {
          cfg.provider.contextWindow = selectedInfo.contextWindow;
          cfg.provider.contextWindowReported = true;
        } else {
          cfg.provider.contextWindow = cfg.provider.contextWindowFallback;
          cfg.provider.contextWindowReported = false;
        }
        deps.runner.setProvider(createProvider(cfg));
        await persistSettings({
          model: cfg.provider.model,
          effort: cfg.reasoning.effort,
          mode: cfg.provider.mode,
          contextWindow: cfg.provider.contextWindow,
        });
        info(
          `logged in to ${meta.label} · model: ${cfg.provider.model} · effort: ${cfg.reasoning.effort} · efforts ${effortSummary(available)}${selectedInfo?.contextWindow ? ` · context ${fmtTokens(selectedInfo.contextWindow)}` : ""}${models.length ? ` · ${models.length} models` : ""} (/model to switch)`,
        );
        return false;
      }
      case "/logout": {
        const auth = await loadAuth();
        if (!auth.active) {
          info("no saved provider login");
          return false;
        }
        const id = auth.active;
        auth.active = undefined;
        try {
          await saveAuth(auth);
        } catch (e) {
          renderer.showError(`could not save auth: ${errorMessage(e)}`);
          return false;
        }
        currentProviderId = undefined;
        info(`logged out of ${id} · the current session keeps its connection`);
        return false;
      }
      case "/model":
      case "/models": {
        const applyModel = async (
          chosen: string,
          contextWindow?: number,
          reportedEfforts?: ReasoningEffort[],
        ): Promise<void> => {
          const available = availableEfforts(chosen, reportedEfforts);
          const effort = maxEffort(available);
          cfg.provider.model = chosen;
          cfg.reasoning.effort = effort;
          if (contextWindow) {
            cfg.provider.contextWindow = contextWindow;
            cfg.provider.contextWindowReported = true;
          } else {
            cfg.provider.contextWindow = cfg.provider.contextWindowFallback;
            cfg.provider.contextWindowReported = false;
          }
          await updateActiveProfile({ model: chosen, effort, contextWindow: contextWindow ?? null });
          await persistSettings({ model: chosen, effort, contextWindow: cfg.provider.contextWindow });
          const contextNote = contextWindow
            ? ` · context ${fmtTokens(contextWindow)}`
            : ` · context ${fmtTokens(cfg.provider.contextWindow)} (fallback)`;
          info(`model: ${chosen} · effort: ${effort} · efforts ${effortSummary(available)} · max supported; /effort to change${contextNote}`);
        };

        const switchProviderModel = async (provider: NativeProviderId, selected: ModelInfo): Promise<void> => {
          let auth;
          try {
            auth = await loadAuth();
          } catch (e) {
            renderer.showError(`could not read auth: ${errorMessage(e)}`);
            return;
          }
          const profile = auth.providers[provider];
          if (!profile) {
            renderer.showError(`saved provider ${provider} is missing`);
            return;
          }
          const available = availableEfforts(selected.id, selected.efforts, provider);
          const effort = maxEffort(available);
          currentProviderId = provider;
          const contextReported = selected.contextWindow !== undefined;
          const contextWindow = selected.contextWindow ?? cfg.provider.contextWindowFallback;
          profile.model = selected.id;
          profile.effort = effort;
          if (selected.contextWindow) profile.contextWindow = selected.contextWindow;
          else delete profile.contextWindow;
          auth.active = provider;
          try {
            await saveAuth(auth);
          } catch (e) {
            renderer.showError(`could not save auth: ${errorMessage(e)}`);
          }
          cfg.provider.baseUrl = normalizeBaseUrl(profile.baseUrl);
          cfg.provider.apiKey = profile.apiKey;
          cfg.provider.mode = profile.mode;
          cfg.provider.model = selected.id;
          cfg.reasoning.effort = effort;
          cfg.provider.contextWindow = contextWindow;
          cfg.provider.contextWindowReported = contextReported;
          if (profile.oauth?.accountId) {
            cfg.provider.headers["chatgpt-account-id"] = profile.oauth.accountId;
            cfg.provider.headers.originator = "codex_cli_rs";
          }
          deps.runner.setProvider(createProvider(cfg));
          await persistSettings({
            model: selected.id,
            effort,
            mode: profile.mode,
            contextWindow,
          });
          const contextNote = contextReported
            ? ` · context ${fmtTokens(contextWindow)}`
            : ` · context ${fmtTokens(contextWindow)} (fallback)`;
          info(
            `provider: ${NATIVE_PROVIDERS[provider].label} · model: ${selected.id} · effort: ${effort} · efforts ${effortSummary(available)}${contextNote}`,
          );
        };

        if (arg) {
          const infoForModel = await fetchModelInfo(arg);
          await applyModel(arg, infoForModel?.contextWindow, infoForModel?.efforts);
          return false;
        }

        const auth = await loadAuth();
        type Target = {
          id?: NativeProviderId;
          label: string;
          baseUrl: string;
          apiKey: string;
          current: boolean;
          profile?: AuthProfile;
        };
        const targets: Target[] = [];
        for (const id of nativeProviderIds()) {
          const profile = auth.providers[id];
          if (!profile) continue;
          targets.push({
            id,
            label: NATIVE_PROVIDERS[id].label,
            baseUrl: profile.baseUrl,
            apiKey: profile.apiKey,
            current: auth.active === id,
            profile,
          });
        }
        if (!targets.length) {
          targets.push({ label: "current", baseUrl: cfg.provider.baseUrl, apiKey: cfg.provider.apiKey, current: true });
        }

        const publicHeaders = Object.fromEntries(
          Object.entries(cfg.provider.headers).filter(([key]) => key.toLowerCase() !== "authorization"),
        );
        let authChanged = false;
        info(`fetching models from ${targets.map((target) => target.label).join(", ")}...`);
        const results = await Promise.all(
          targets.map(async (target) => {
            try {
              let infos: ModelInfo[];
              if (target.id === "openai" && target.profile?.oauth) {
                const tokens = await ensureFreshTokens(target.profile);
                applyTokens(target.profile, tokens);
                authChanged = true;
                infos = await fetchOpenAIModels(tokens);
              } else {
                infos = await listModelInfo({
                  baseUrl: target.baseUrl,
                  apiKey: target.apiKey,
                  headers: target.id ? publicHeaders : cfg.provider.headers,
                });
              }
              return { target, infos };
            } catch (e) {
              return { target, infos: [] as ModelInfo[], error: errorMessage(e) };
            }
          }),
        );
        if (authChanged) {
          try {
            await saveAuth(auth);
          } catch (e) {
            renderer.showError(`could not save refreshed OpenAI auth: ${errorMessage(e)}`);
          }
        }

        const options: Array<{ value: string; label: string; description?: string }> = [];
        const choices = new Map<string, { target: Target; info: ModelInfo }>();
        let sequence = 0;
        for (const result of results) {
          if (result.error) {
            renderer.showError(`could not list ${result.target.label} models: ${result.error}`);
            continue;
          }
          if (!result.infos.length) {
            info(`${result.target.label} returned no models`);
            continue;
          }
          for (const info of result.infos) {
            const reported = info.efforts;
            const available = availableEfforts(info.id, reported, result.target.id);
            const effortLabel =
              reported === undefined && cfg.provider.modelEfforts[info.id] === undefined
                ? "efforts unknown"
                : `efforts ${effortSummary(available)}`;
            const isCurrent = result.target.current && info.id === cfg.provider.model;
            const isSaved = !isCurrent && result.target.profile?.model === info.id;
            const value = `${result.target.id ?? "current"}\u0000${sequence++}`;
            options.push({
              value,
              label: info.id,
              description: [
                result.target.label,
                isCurrent ? "current" : isSaved ? "saved" : "",
                info.contextWindow ? `ctx ${fmtTokens(info.contextWindow)}` : "",
                effortLabel,
              ]
                .filter(Boolean)
                .join(" · "),
            });
            choices.set(value, { target: result.target, info });
          }
        }
        if (!options.length) {
          renderer.showError("no models available from the saved providers");
          return false;
        }
        const currentLabel = targets.find((target) => target.current)?.label ?? "current";
        const chosen = await editor.select(
          options,
          `models from ${targets.map((target) => target.label).join(", ")} (current: ${currentLabel}/${cfg.provider.model})`,
        );
        if (!chosen) {
          info("model unchanged");
          return false;
        }
        const picked = choices.get(chosen);
        if (!picked) return false;
        if (picked.target.id) await switchProviderModel(picked.target.id, picked.info);
        else await applyModel(picked.info.id, picked.info.contextWindow, picked.info.efforts);
        return false;
      }
      case "/context-size": {
        info(`fetching context sizes from ${cfg.provider.baseUrl}...`);
        let infos: ModelInfo[];
        try {
          infos = await fetchCurrentProviderModels();
        } catch (e) {
          renderer.showError(`could not list context sizes: ${errorMessage(e)}`);
          return false;
        }
        if (!infos.length) {
          renderer.showError("the server returned no models");
          return false;
        }
        const width = Math.max(...infos.map((info) => info.id.length), 7);
        const lines = infos.map((info) => {
          const mark = info.id === cfg.provider.model ? "*" : " ";
          return `${mark} ${info.id.padEnd(width)}  ${info.contextWindow ? fmtTokens(info.contextWindow) : "not reported"}`;
        });
        const current = infos.find((info) => info.id === cfg.provider.model);
        if (current?.contextWindow) {
          cfg.provider.contextWindow = current.contextWindow;
          cfg.provider.contextWindowReported = true;
          await updateActiveProfile({ contextWindow: current.contextWindow });
          await persistSettings({ contextWindow: current.contextWindow });
        } else {
          cfg.provider.contextWindow = cfg.provider.contextWindowFallback;
          cfg.provider.contextWindowReported = false;
          await updateActiveProfile({ contextWindow: null });
          await persistSettings({ contextWindow: cfg.provider.contextWindowFallback });
        }
        info(
          [
            `context sizes from ${cfg.provider.baseUrl} (current: ${cfg.provider.model}):`,
            ...lines,
            "",
            current?.contextWindow
              ? `current max context: ${fmtTokens(current.contextWindow)} (from the API)`
              : `current max context: ${fmtTokens(cfg.provider.contextWindow)} (configured fallback; API did not report it)`,
          ].join("\n"),
        );
        return false;
      }
      case "/mode": {
        const setMode = async (mode: Config["provider"]["mode"]): Promise<void> => {
          cfg.provider.mode = mode;
          deps.runner.setProvider(createProvider(cfg));
          await updateActiveProfile({ mode });
          await persistSettings({ mode });
          info(`mode: ${cfg.provider.mode}`);
        };
        if (!arg) {
          const chosen = await editor.select(
            [
              { value: "auto", label: "auto", description: "try chat, fall back to completions" },
              { value: "chat", label: "chat", description: "native tool calls" },
              { value: "completions", label: "completions", description: "prompt-rendered text tool calls" },
              { value: "responses", label: "responses", description: "OpenAI Responses API" },
            ],
            `transport mode (current: ${cfg.provider.mode})`,
          );
          if (!chosen) {
            info("mode unchanged");
            return false;
          }
          await setMode(chosen as Config["provider"]["mode"]);
          return false;
        }
        if (!["chat", "completions", "auto", "responses"].includes(arg)) {
          renderer.showError("mode must be chat, completions, auto, or responses");
          return false;
        }
        await setMode(arg as Config["provider"]["mode"]);
        return false;
      }
      case "/effort": {
        const setEffort = async (effort: ReasoningEffort): Promise<void> => {
          cfg.reasoning.effort = effort;
          await updateActiveProfile({ effort });
          await persistSettings({ effort });
          info(`effort: ${effort}`);
        };
        const available = await refreshCurrentEfforts();
        if (!supportsEffort(cfg.reasoning.effort, available)) {
          const previous = cfg.reasoning.effort;
          const next = maxEffort(available);
          await setEffort(next);
          info(`model does not declare ${previous}; using ${next}`);
        }
        if (!available.length) {
          info("model did not declare effort levels; only auto is available (set provider.modelEfforts to override)");
        }
        if (arg) {
          const effort = parseReasoningEffort(arg);
          if (!effort) {
            renderer.showError("effort must be auto, none, minimal, low, medium, or high");
            return false;
          }
          if (!supportsEffort(effort, available)) {
            renderer.showError(
              `model does not declare ${effort}; available: ${["auto", ...available].join(", ")}`,
            );
            return false;
          }
          await setEffort(effort);
          return false;
        }
        const chosen = await editor.select(
          effortChoices(available).map((effort) => ({
            value: effort.value,
            label: effort.value,
            description:
              effort.value === cfg.reasoning.effort ? `${effort.description} · current` : effort.description,
          })),
          `thinking effort (current: ${cfg.reasoning.effort})`,
        );
        if (!chosen) {
          info("effort unchanged");
          return false;
        }
        await setEffort(chosen as ReasoningEffort);
        return false;
      }
      case "/thinking":
        await toggleThinkingDisplay();
        return false;
      case "/loop": {
        const sub = parts[1] ?? "show";
        if (sub === "show") info(formatSpec(conv.spec));
        else if (sub === "edit") await editLoop();
        else if (sub === "reset") applyUserSpec(defaultSpec(limitsFor(cfg)), "user reset");
        else if (sub === "preset") {
          let name = parts[2];
          if (!name) {
            const chosen = await editor.select(
              presetNames().map((preset) => ({ value: preset, label: preset })),
              "loop presets",
            );
            if (!chosen) {
              info("preset unchanged");
              return false;
            }
            name = chosen;
          }
          try {
            applyUserSpec(presetSpec(name, limitsFor(cfg)), `user preset ${name}`);
          } catch (e) {
            renderer.showError(errorMessage(e));
          }
        } else if (sub === "changes") {
          const value = parts[2];
          if (value === "auto" || value === "approve") {
            cfg.loop.changes = value;
            await persistSettings({ loopChanges: value });
            info(`loop changes: ${cfg.loop.changes}`);
          } else if (value) {
            renderer.showError("loop changes must be auto or approve");
          } else {
            const chosen = await editor.select(
              [
                { value: "auto", label: "auto", description: "the model may rewrite its loop without approval" },
                { value: "approve", label: "approve", description: "require approval for loop rewrites" },
              ],
              `loop changes (current: ${cfg.loop.changes})`,
            );
            if (!chosen) {
              info("loop changes unchanged");
              return false;
            }
            cfg.loop.changes = chosen as "auto" | "approve";
            await persistSettings({ loopChanges: cfg.loop.changes });
            info(`loop changes: ${cfg.loop.changes}`);
          }
        } else renderer.showError("usage: /loop [show|edit|reset|preset <name>|changes auto|approve]");
        return false;
      }
      case "/compact": {
        try {
          await deps.runner.compact(conv, true, new AbortController().signal);
        } catch (e) {
          renderer.showError(errorMessage(e));
        }
        return false;
      }
      case "/clear": {
        const old = deps.sessionRef.current;
        const meta = newSessionMeta(cfg.cwd, cfg.provider.model, deps.runner.provider.mode, deps.version);
        const store = cfg.session.enabled ? await SessionStore.create(cfg.session.dir, meta) : null;
        deps.sessionRef.current = store;
        await old?.close();
        conv = deps.runner.createConversation("main", "main", 0);
        renderer.setHistory([]);
        renderer.replayTranscript();
        renderer.blankLine();
        deps.bus.emit("main", {
          t: "session.start",
          id: meta.id,
          cwd: cfg.cwd,
          model: cfg.provider.model,
          mode: deps.runner.provider.mode,
          version: deps.version,
        });
        renderer.showNotice("conversation cleared; new session started");
        return false;
      }
      case "/sessions": {
        const list = await listSessions(cfg.session.dir, cfg.cwd, 10);
        if (!list.length) {
          info("no sessions in this working directory");
          return false;
        }
        info(
          list
            .map((s, i) => `${i + 1}. ${s.path.split("/").pop()}  ${new Date(s.mtime).toISOString().slice(0, 16).replace("T", " ")}  ${s.meta.model}`)
            .join("\n"),
        );
        return false;
      }
      case "/resume": {
        const list = await listSessions(cfg.session.dir, cfg.cwd, 10);
        let path = arg;
        const n = Number(arg);
        if (Number.isInteger(n) && n >= 1 && n <= list.length) path = list[n - 1].path;
        if (!path) {
          renderer.showError("usage: /resume <number|path> (see /sessions)");
          return false;
        }
        const abs = resolve(cfg.cwd, path);
        try {
          const loaded = await loadSession(abs, limitsFor(cfg));
          const store = await SessionStore.open(abs);
          const old = deps.sessionRef.current;
          deps.sessionRef.current = store;
          await old?.close();
          conv = deps.runner.createConversation("main", "main", 0);
          conv.messages = loaded.messages;
          conv.spec = clampToHost(loaded.spec, limitsFor(cfg));
          conv.stageIndex = Math.min(loaded.stageIndex, conv.spec.stages.length - 1);
          conv.notes = loaded.notes;
          conv.todos = loaded.todos;
          conv.usage = {
            prompt: loaded.usage.promptTokens ?? 0,
            completion: loaded.usage.completionTokens ?? 0,
          };
          conv.contextTokens = loaded.contextTokens;
          conv.contextReported = loaded.contextReported;
          renderer.setHistory(loaded.events);
          renderer.replayTranscript();
          renderer.blankLine();
          deps.bus.emit("main", { t: "session.resume", path: abs });
          renderer.showNotice(`resumed ${abs} (${loaded.messages.length} messages)`);
          if (loaded.lastAssistant) info(`last: ${oneLine(loaded.lastAssistant, 160)}`);
        } catch (e) {
          renderer.showError(`could not resume: ${errorMessage(e)}`);
        }
        return false;
      }
      case "/session": {
        info(deps.sessionRef.current ? deps.sessionRef.current.path : "sessions are disabled");
        return false;
      }
      case "/export": {
        const out = arg ? resolve(cfg.cwd, arg) : join(cfg.cwd, `harness2-export-${Date.now()}.md`);
        const md = exportMarkdown({
          path: deps.sessionRef.current?.path ?? "",
          meta: null,
          messages: conv.messages,
          spec: conv.spec,
          stageIndex: conv.stageIndex,
          notes: conv.notes,
          todos: conv.todos,
          usage: {
            promptTokens: conv.usage.prompt,
            completionTokens: conv.usage.completion,
            totalTokens: conv.usage.prompt + conv.usage.completion,
          },
          contextTokens: conv.contextTokens,
          contextReported: conv.contextReported,
          lastAssistant: "",
          events: [],
        });
        try {
          await writeFile(out, md);
          renderer.showNotice(`exported to ${out}`);
        } catch (e) {
          renderer.showError(`export failed: ${errorMessage(e)}`);
        }
        return false;
      }
      case "/approvals": {
        const setApprovals = async (value: "on" | "off"): Promise<void> => {
          cfg.safety.approvals = value;
          await persistSettings({ approvals: value });
          info(`approvals: ${cfg.safety.approvals}`);
        };
        if (arg === "on" || arg === "off") {
          await setApprovals(arg);
          return false;
        }
        if (arg) {
          renderer.showError("approvals must be on or off");
          return false;
        }
        const chosen = await editor.select(
          [
            { value: "on", label: "on", description: "ask before outside-cwd access and network access" },
            { value: "off", label: "off", description: "allow without asking" },
          ],
          `approvals (current: ${cfg.safety.approvals})`,
        );
        if (!chosen) {
          info("approvals unchanged");
          return false;
        }
        await setApprovals(chosen as "on" | "off");
        return false;
      }
      case "/sandbox": {
        const setSandbox = async (value: boolean): Promise<void> => {
          cfg.safety.bashSandbox = value;
          await persistSettings({ bashSandbox: value });
          info(`sandbox: ${cfg.safety.bashSandbox ? "on" : "off"}`);
        };
        if (arg === "on" || arg === "off") {
          await setSandbox(arg === "on");
          return false;
        }
        if (arg) {
          renderer.showError("sandbox must be on or off");
          return false;
        }
        const chosen = await editor.select(
          [
            { value: "on", label: "on", description: "run bash under bwrap" },
            { value: "off", label: "off", description: "run bash directly" },
          ],
          `sandbox (current: ${cfg.safety.bashSandbox ? "on" : "off"})`,
        );
        if (!chosen) {
          info("sandbox unchanged");
          return false;
        }
        await setSandbox(chosen === "on");
        return false;
      }
      case "/network": {
        const setNetwork = async (value: "ask" | "allow" | "deny"): Promise<void> => {
          cfg.safety.network = value;
          await persistSettings({ network: value });
          info(`network: ${cfg.safety.network}`);
        };
        if (arg === "ask" || arg === "allow" || arg === "deny") {
          await setNetwork(arg);
          return false;
        }
        if (arg) {
          renderer.showError("network must be ask, allow, or deny");
          return false;
        }
        const chosen = await editor.select(
          [
            { value: "ask", label: "ask", description: "ask before each network access" },
            { value: "allow", label: "allow", description: "allow network access without asking" },
            { value: "deny", label: "deny", description: "block network access" },
          ],
          `network (current: ${cfg.safety.network})`,
        );
        if (!chosen) {
          info("network unchanged");
          return false;
        }
        await setNetwork(chosen as "ask" | "allow" | "deny");
        return false;
      }
      case "/tools":
        info(ALL_TOOLS.map((t) => `- ${t.spec.name}: ${t.spec.description.split("\n")[0]}`).join("\n"));
        return false;
      default:
        renderer.showError(`unknown command ${cmd}; try /help`);
        return false;
    }
  };

  const runPrompt = async (text: string): Promise<void> => {
    const ac = new AbortController();
    currentAbort = ac;
    term.setMode("default");
    renderer.startRun(deps.runner.provider.mode);
    try {
      const result = await deps.runner.run(conv, text, { signal: ac.signal });
      if (result.reason === "aborted") renderer.showNotice("aborted");
    } catch (e) {
      renderer.showError(errorMessage(e));
    } finally {
      renderer.endRun();
      currentAbort = null;
      term.setMode("modal");
    }
  };

  const cleanup = async (): Promise<void> => {
    term.setDefaultHandler(null);
    deps.approvals.setHandler(null);
    unsubscribe();
    await deps.sessionRef.current?.close();
    term.stop();
  };

  let fatal = false;
  const onFatal = (e: unknown): void => {
    if (fatal) return;
    fatal = true;
    try {
      term.stop();
    } catch {
      // best effort
    }
    process.stderr.write(`harness2: fatal: ${errorMessage(e)}\n`);
    void deps.sessionRef.current?.close().finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 500).unref();
  };
  const onUncaught = (e: unknown): void => onFatal(e);
  // Most background failures in the UI are non-fatal. Keep the session alive and
  // make the failure visible instead of letting Node's default handler exit.
  const onUnhandled = (e: unknown): void => {
    process.stderr.write(`harness2: background error: ${errorMessage(e)}\n`);
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);

  const onSignal = (): void => {
    process.stderr.write("harness2: terminated by SIGTERM\n");
    term.stop();
    void deps.sessionRef.current?.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.once("SIGTERM", onSignal);

  try {
    let first = deps.initialPrompt?.trim();
    let draft = "";
    while (true) {
      if (first) {
        const text = first;
        first = undefined;
        if (text.startsWith("/")) {
          try {
            if (await handleSlash(text)) break;
          } catch (e) {
            renderer.showError(errorMessage(e));
          }
          renderer.blankLine();
          continue;
        }
        if (cfg.session.enabled) void appendHistory(historyPath(), text).catch(() => {});
        editor.remember(text);
        await runPrompt(text);
        continue;
      }
      const result = await editor.read(draft);
      draft = "";
      if (result === null) break;
      if (typeof result === "object") {
        await toggleThinkingDisplay();
        draft = result.text;
        continue;
      }
      const line = result;
      const text = line.replace(/\s+$/, "");
      if (!text.trim()) continue;
      if (text.trim().startsWith("/")) {
        try {
          if (await handleSlash(text.trim())) break;
        } catch (e) {
          renderer.showError(errorMessage(e));
        }
        renderer.blankLine();
        continue;
      }
      editor.remember(text);
      void appendHistory(historyPath(), text).catch(() => {});
      await runPrompt(text);
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
    await cleanup();
    process.stdout.write("\r\n");
  }
}
