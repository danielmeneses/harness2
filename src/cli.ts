export type Flags = {
  print: boolean;
  json: boolean;
  continue: boolean;
  session?: string;
  eventsFile?: string;
  configPath?: string;
  help: boolean;
  version: boolean;
  prompt: string;
  patch: Record<string, unknown>;
  explicit: {
    baseUrl: boolean;
    apiKey: boolean;
    model: boolean;
    mode: boolean;
    effort: boolean;
    contextWindow: boolean;
    approvals: boolean;
    network: boolean;
    sandbox: boolean;
    loopChanges: boolean;
    showThinking: boolean;
  };
};

export const HELP = `harness2 — a coding agent whose loop the model controls

usage: harness2 [options] [prompt]
  With no prompt and a TTY, starts the interactive terminal.
  With -p, or when stdin is not a TTY, runs one turn and prints the answer.
  With --json, prints the full event stream as JSONL (implies -p).

model / transport:
  --base-url <url>            OpenAI-compatible base URL (default http://127.0.0.1:8080/v1)
  --api-key <key>             bearer token (or HARNESS2_API_KEY / OPENAI_API_KEY)
  --model <name>              model name (default "default")
  --mode <auto|chat|completions|responses>
                              auto tries /v1/chat/completions, falls back to /v1/completions
  --effort <auto|none|minimal|low|medium|high|xhigh|max|ultra>
                              reasoning effort (sent natively; also added to completion prompts)
  --template <chatml|plain>   prompt template for /v1/completions (default chatml)
  --temperature <n>           sampling temperature (default 0.2)
  --max-tokens <n>            max output tokens per turn (default 16384)
  --context-window <n>        context size used for compaction (default 32768)
  --timeout <ms>              HTTP timeout (default 600000)
  --retries <n>               pre-stream retries (default 2)

loop / tools:
  --max-steps <n>             hard cap for the model-controlled loop (default 40)
  --loop-changes <auto|approve>
                              require approval when the model rewrites its loop
  --max-subagent-depth <n>    loop_spawn nesting cap (default 2)
  --max-child-agents <n>      hard cap on child conversations per run (0 disables; default 8)
  --token-budget <n>          hard prompt+completion token cap for the run tree (0 = off)
  --prompt-budget <n>         hard cumulative prompt-token cap for the run tree (0 = off)
  --time-budget <ms>          hard wall-clock cap for the run tree (0 = off)
  --compact-at <n>            compact at context usage n (fraction 0.3-0.95, or percent) (default 0.95)
  --system-suffix <text>      extra instructions appended to the system prompt

safety:
  --approvals <on|off>        approval prompts for outside-cwd / network access
  --approve-all               auto-allow all approvals (headless only; dangerous)
  --network <ask|allow|deny>  network policy for bash and fetch
  --sandbox                   run bash under bwrap (read-only outside cwd)
  --no-sandbox                disable the sandbox
  --env-allow <NAME,...>      extra host environment variables for tool subprocesses
  --sandbox-network           allow network inside the bash sandbox (default off)
  --no-sandbox-network

sessions / ui:
  -c, --continue              resume the latest session in this working directory
  --session <path>            resume a specific session file
  --no-session                do not write a session file
  --session-dir <dir>         session directory (default ~/.harness2/sessions)
  --events-file <path>        append the live event stream as JSONL
  --thinking                  stream thinking live inline (default: collapsed summaries)
  --no-thinking               force collapsed thinking summaries
  --no-color                  disable ANSI colors
  -p, --print                 non-interactive
  --json                      JSONL event stream on stdout (implies -p)
  --config <path>             explicit config file
  -h, --help
  -v, --version

env:
  HARNESS2_BASE_URL, HARNESS2_API_KEY (or OPENAI_API_KEY), HARNESS2_MODEL,
  HARNESS2_MODE, HARNESS2_REASONING_EFFORT, HARNESS2_CONTEXT_WINDOW,
  HARNESS2_MAX_STEPS, HARNESS2_NETWORK, HARNESS2_SANDBOX, HARNESS2_HOME

config files:
  ~/.harness2/config.json          (shared)
  .harness2/config.json            (project; safe fields override shared)
  .harness2/settings.json          (project; safe preferences only)

interactive:
  /login [provider]     choose/authenticate a native provider
  /model, /models       searchable models from every saved provider
  /context-size         list model context sizes reported by the API
  /effort               searchable reasoning-effort list
  /mode                 searchable transport-mode list
  /approvals /sandbox /network
                        searchable safety-option lists
  /loop preset|changes  searchable loop-option lists
  /logout               clear the saved provider
  settings              ~/.harness2/settings.json (0600)

examples:
  harness2 --base-url http://127.0.0.1:8080 --model qwen3 "fix the failing test"
  harness2 -p --json --events-file events.jsonl "summarize this repo"
  harness2 -c
`;

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let obj = root;
  for (const part of parts.slice(0, -1)) {
    const next = obj[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) obj[part] = {};
    obj = obj[part] as Record<string, unknown>;
  }
  obj[parts[parts.length - 1]] = value;
}

function numberArg(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${flag} expects a number (got ${value})`);
  return n;
}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    print: false,
    json: false,
    continue: false,
    help: false,
    version: false,
    prompt: "",
    patch: {},
    explicit: {
      baseUrl: false,
      apiKey: false,
      model: false,
      mode: false,
      effort: false,
      contextWindow: false,
      approvals: false,
      network: false,
      sandbox: false,
      loopChanges: false,
      showThinking: false,
    },
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }

    let value: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        value = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
    }
    const take = (): string => {
      if (value !== undefined) return value;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };

    switch (arg) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "-v":
      case "--version":
        flags.version = true;
        break;
      case "-p":
      case "--print":
        flags.print = true;
        break;
      case "--json":
        flags.json = true;
        flags.print = true;
        break;
      case "-c":
      case "--continue":
        flags.continue = true;
        break;
      case "--session":
        flags.session = take();
        break;
      case "--events-file":
        flags.eventsFile = take();
        break;
      case "--config":
        flags.configPath = take();
        break;
      case "--base-url":
        flags.explicit.baseUrl = true;
        setPath(flags.patch, "provider.baseUrl", take());
        break;
      case "--api-key":
        flags.explicit.apiKey = true;
        setPath(flags.patch, "provider.apiKey", take());
        break;
      case "--model":
        flags.explicit.model = true;
        setPath(flags.patch, "provider.model", take());
        break;
      case "--mode":
        flags.explicit.mode = true;
        setPath(flags.patch, "provider.mode", take());
        break;
      case "--effort":
      case "--reasoning-effort":
        flags.explicit.effort = true;
        setPath(flags.patch, "reasoning.effort", take());
        break;
      case "--template":
        setPath(flags.patch, "prompt.template", take());
        break;
      case "--system-suffix":
        setPath(flags.patch, "prompt.systemSuffix", take());
        break;
      case "--temperature":
        setPath(flags.patch, "provider.temperature", numberArg(arg, take()));
        break;
      case "--max-tokens":
        setPath(flags.patch, "provider.maxTokens", Math.floor(numberArg(arg, take())));
        break;
      case "--context-window":
        flags.explicit.contextWindow = true;
        setPath(flags.patch, "provider.contextWindow", Math.floor(numberArg(arg, take())));
        break;
      case "--timeout":
        setPath(flags.patch, "provider.timeoutMs", Math.floor(numberArg(arg, take())));
        break;
      case "--retries":
        setPath(flags.patch, "provider.retries", Math.floor(numberArg(arg, take())));
        break;
      case "--max-steps": {
        const n = Math.floor(numberArg(arg, take()));
        setPath(flags.patch, "loop.maxStepsCap", n);
        setPath(flags.patch, "loop.defaultMaxSteps", n);
        break;
      }
      case "--loop-changes":
        flags.explicit.loopChanges = true;
        setPath(flags.patch, "loop.changes", take());
        break;
      case "--max-subagent-depth":
        setPath(flags.patch, "loop.maxSubagentDepth", Math.floor(numberArg(arg, take())));
        break;
      case "--max-child-agents":
        setPath(flags.patch, "loop.maxChildAgents", Math.floor(numberArg(arg, take())));
        break;
      case "--token-budget":
        setPath(flags.patch, "provider.totalTokenBudget", Math.floor(numberArg(arg, take())));
        break;
      case "--prompt-budget":
        setPath(flags.patch, "provider.promptTokenBudget", Math.floor(numberArg(arg, take())));
        break;
      case "--time-budget":
        setPath(flags.patch, "loop.runTimeBudgetMs", Math.floor(numberArg(arg, take())));
        break;
      case "--compact-at": {
        const n = numberArg(arg, take());
        setPath(flags.patch, "loop.compactAtPct", n > 1 ? n / 100 : n);
        break;
      }
      case "--approvals":
        flags.explicit.approvals = true;
        setPath(flags.patch, "safety.approvals", take());
        break;
      case "--approve-all":
        setPath(flags.patch, "safety.approveAll", true);
        break;
      case "--network":
        flags.explicit.network = true;
        setPath(flags.patch, "safety.network", take());
        break;
      case "--sandbox":
        flags.explicit.sandbox = true;
        setPath(flags.patch, "safety.bashSandbox", true);
        break;
      case "--no-sandbox":
        flags.explicit.sandbox = true;
        setPath(flags.patch, "safety.bashSandbox", false);
        break;
      case "--env-allow":
        setPath(
          flags.patch,
          "safety.envAllowlist",
          take()
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case "--sandbox-network":
        setPath(flags.patch, "safety.sandboxNetwork", true);
        break;
      case "--no-sandbox-network":
        setPath(flags.patch, "safety.sandboxNetwork", false);
        break;
      case "--no-session":
        setPath(flags.patch, "session.enabled", false);
        break;
      case "--session-dir":
        setPath(flags.patch, "session.dir", take());
        break;
      case "--thinking":
        flags.explicit.showThinking = true;
        setPath(flags.patch, "ui.showThinking", true);
        break;
      case "--no-thinking":
        flags.explicit.showThinking = true;
        setPath(flags.patch, "ui.showThinking", false);
        break;
      case "--no-color":
        setPath(flags.patch, "ui.color", false);
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }

  flags.prompt = positionals.join(" ").trim();
  return flags;
}
