# harness2

[![npm version](https://img.shields.io/npm/v/@danielmeneses/harness2.svg)](https://www.npmjs.com/package/@danielmeneses/harness2)
[![Node.js](https://img.shields.io/node/v/@danielmeneses/harness2.svg)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-danielmeneses%2Fharness2-181717?logo=github)](https://github.com/danielmeneses/harness2)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A terminal coding agent whose **loop belongs to the model**.

Most harnesses run a fixed loop: call model → run tools → repeat. harness2 starts
from that, then gives the model tools to rewrite the loop itself — stages, goals,
tool subsets, stop conditions, step budgets, parallel tool use, and child
conversations. The harness complies and keeps the human-owned safety envelope
(path jail, approvals, network policy, hard caps) out of reach.

It speaks the OpenAI-compatible API: `/v1/chat/completions` with native tool
calls, `/v1/completions` with a text tool protocol, and `auto` to try chat first
and fall back. Streaming text, thinking, tool output, and subagent conversations
are first-class event streams.

No runtime dependencies. Development runs TypeScript directly on Node 22.18+;
the npm package ships compiled JavaScript in `dist/`.

## Install

Requires Node.js 22.18 or newer.

```bash
# install the published package
npm install -g @danielmeneses/harness2

# or install this checkout globally
npm install
npm install -g .

# or install a packed tarball
npm pack
npm install -g ./danielmeneses-harness2-0.1.1.tgz

harness2 --version
```

The global command is `harness2`; `h2` is installed as an alias. Run it from the
project folder you want it to work on. That current directory supplies the
working directory and `AGENTS.md`; project `.harness2/config.json` and
`.harness2/settings.json` can override safe workflow preferences.

## State

All harness-owned state lives in `~/.harness2` (override with `HARNESS2_HOME`):

```
~/.harness2/
  config.json       shared configuration
  auth.json         provider logins (0600)
  settings.json     interactive choices (0600)
  grants.json       persisted approvals (0600)
  history.jsonl     interactive input history
  sessions/         all conversation logs
  tmp/              transient harness files
```

The package `postinstall` creates this directory; runtime also creates it if
missing. Older `~/.config/harness2` files and project `.harness2/sessions` /
`.harness2/history.jsonl` are migrated into it. Auth, grants, sessions, and
history are not overlaid from a project at runtime; the project cannot grant
safety permissions or point the harness at different credentials.

## Quick start

```bash
# point it at any OpenAI-compatible server (llama.cpp, vLLM, LM Studio, ...)
harness2 --base-url http://127.0.0.1:8080 --model qwen3

# one-shot
harness2 -p --base-url http://127.0.0.1:8080 --model qwen3 "fix the failing test"

# full event feed on stdout
harness2 -p --json --base-url http://127.0.0.1:8080 --model qwen3 "summarize this repo"
```

If the server exposes both endpoints, `--mode auto` (the default) uses chat first.
Use `--mode completions` for text-completion-only servers, `--mode chat` to force
native tool calls. Start with a model that supports tool calls; for /completions
the harness has to teach and parse a text protocol.

## The loop is a value the model can rewrite

The kernel runs one model turn at a time. Between turns the model can change how
the next turn is driven:

| tool | effect |
|---|---|
| `loop_inspect` | current spec, stage, step budgets, notes, recent tool outcomes |
| `loop_set` | replace or merge the loop spec (stages, goals, tools, predicates, sampling) |
| `loop_stage` | next / restart / enter a stage |
| `loop_halt` | stop deliberately with an answer |
| `loop_note` | durable note that survives compaction |
| `loop_ask` | ask the human and wait |
| `loop_spawn` | run a child conversation with its own loop, return its answer |

`loop_spawn` children share the root run budget and the same host safety
envelope. They cannot widen permissions; a parent's stage tool policy does not
automatically restrict a child, so pass a narrower child spec when delegating.

Spec shape:

```json
{
  "name": "plan-execute",
  "maxSteps": 30,
  "stages": [
    { "id": "plan", "goal": "Inspect the repo and write a plan with todo",
      "tools": ["read", "ls", "glob", "grep", "todo"],
      "exitWhen": { "toolCalled": "todo" } },
    { "id": "implement", "goal": "Implement the plan", "exitWhen": { "modelStopped": true } },
    { "id": "review", "goal": "Run checks and review the diff", "exitWhen": { "modelStopped": true } }
  ],
  "toolPolicy": { "parallel": false },
  "onToolError": "continue",
  "finish": { "modelStopped": true }
}
```

Predicates are data, never `eval`:

```
{all:[...]} {any:[...]} {not:...} {modelStopped:true}
{toolCalled:"name"} {toolOk:"name"} {toolFailed:"name"}
{fileExists:"path"} {filesChanged:["path"]} {stepsAtLeast:n}
{lastOutputMatches:"regex"} {command:"npm test",expectExit:0,timeoutMs?}
```

Semantics:

- A reply with **no tool calls** means the model stopped.
- If the current stage's `exitWhen` is not met, the harness says why and continues.
- If it is met and another stage exists, the loop advances and continues.
- At the last stage the `finish` predicate is checked; if false, the loop continues.
- `maxSteps`, token/prompt/time budgets, tool-output size, and child-agent caps
  are hard human caps. Specs are validated and clamped; safety fields are not
  part of the spec. A resumed spec is re-clamped against the current host caps.
- Changes from `loop_set`/`loop_stage` are staged, version-checked, and committed
  atomically after the current tool batch, in call order. Replacing the spec
  preserves the current stage by id; a stale transaction is rejected whole.
  Every change is an event and visible in the transcript.
- Predicate `command` checks run through the normal `bash` tool path: stage tool
  policy, approvals, output caps, and `tool.call`/`tool.result` events. They are
  not a side channel.
- Set `--loop-changes approve` if you want to approve each rewrite before it takes
  effect. Presets: `react`, `plan-execute`, `tdd`. `/loop` edits the spec live.

## Prompt caching

The system prompt is **static for the life of the process**. Live loop state is
appended at the start of every step as a synthetic user message beginning with
`[harness loop state]`: step, full spec, current stage, stage goal/exit,
active tools, notes, todos, and changed files. That message is persisted in the
conversation, so each request's prompt is a prefix of the next one. Prefix-cache
implementations can therefore reuse the system prompt plus the whole previous
conversation, and only process the new assistant/tool/state suffix.

- The harness emits a `notice` when the system prompt changes. During normal
  operation it should not fire; over `--json`/`--events-file` you can confirm it.
- All tool schemas are sent every step to keep the request prefix stable. The
  stage's active tool set is listed in the state and enforced by the harness;
  calling an inactive tool returns a tool error.
- Compaction, `/clear`, resuming after an interrupted turn, a config/day change,
  or server cache eviction start a new prefix.
- Server side: llama.cpp reuses prompt prefixes automatically (optionally pass
  `"extraBody": {"cache_prompt": true}` to be explicit). vLLM needs
  `--enable-prefix-caching` (or its default) and logs a prefix-cache hit rate;
  SGLang's radix cache is on by default. If you still see no hits, check the
  server log first, then make sure nothing is changing `reasoning.effort` or
  `prompt.systemSuffix` between turns.
- State messages are hidden in the TUI, skipped in markdown exports and in the
  compaction transcript, but they are present in the session/JSON event feed.

## Convo streams

Everything is an event. One sequenced stream per conversation, multiplexed over a
single session feed:

- `assistant.text.delta`, `assistant.thinking.delta`, `tool.output.delta` — live.
- Token-sized SSE chunks render immediately. Servers that batch a whole line, or
  return one non-streaming JSON body, get large text chunks sliced for display
  (16 chars / 8ms) so the terminal still reveals text progressively; real token
  streams pass through untouched. Tool cards still buffer until the result so
  success/failure coloring is consistent.
- `tool.call` / `tool.result`, `loop.spec`, `loop.stage`, `loop.spawn`, `todo`,
  `compaction`, `usage`, `approval.*`, `error`, `done`.
- `loop_spawn` creates `main.sub1`, `main.sub2`, ... streams. The TUI prefixes
  their lines; the JSON feed tags every event with `stream`.
- Assistant text is rendered as markdown: headings, lists/tasks, quotes, fenced
  code with a gutter, aligned tables, and inline bold/italic/strike/code/links.
  Thinking is collapsed by default; Ctrl-O rebuilds the transcript with all thinking
  expanded in place. Tool calls render as full-width near-black muted-yellow cards: green
  text on success, red on failure, including their output/diff/status. Tool output
  is buffered until the result so the card can be styled consistently; the status
  line shows the running tool in the meantime. Blank lines separate the user turn,
  thinking, response, tools, and done line.
- `--json` writes the live feed to stdout (implies `-p`).
- `--events-file events.jsonl` appends the live feed (including deltas) for other
  processes to tail.
- Session files (`~/.harness2/sessions/*.jsonl`) persist finalized messages,
  tool calls/results, loop changes, notes, todos, approvals, usage, and
  completion events. Deltas are intentionally not persisted; `--events-file` is for that.
- Resume with `-c` (latest session in this cwd) or `--session <path>`.

## Thinking

Thinking is streamed on its own channel and kept dim. By default every block is
**collapsed** to a summary at its position:

```
✻ thinking · 1.2k chars · 4s · ctrl-o to expand all
```

`Ctrl-O` (or `/thinking`) rebuilds the transcript with **all** thinking blocks
expanded in place; pressing it again rebuilds with all collapsed. The toggle
clears the terminal screen and scrollback and re-renders the recorded
conversation, so expanded blocks appear before their assistant text where they
belong, not appended at the end. While a turn is running, the toggle applies when
that turn finishes and the transcript is rebuilt then. `/thinking` is the same
toggle; `--thinking` starts expanded. The text is buffered on the assistant
message and included in `--json`/session events. A resumed session seeds the
re-render history; only the recorded harness conversation is re-rendered, not
unrelated terminal output.

## Tools

`read`, `write`, `edit` (exact multi-edit, atomic), `bash`, `ls`, `glob`, `grep`,
`fetch`, `todo`, plus the `loop_*` tools. Every schema is sent on every step for
cache stability; the state lists the active subset and the harness denies the rest.
Tool cards are full-width near-black yellow (a subtle tint), with green text on
success and red on failure; streaming output is shown in the card after completion.

- Edits require unique matches unless `replaceAll` is set; all edits are applied
  atomically.
- Bash output streams live and is capped for the model; the tail is preserved.
- File tools resolve symlinks and stay inside the cwd (or configured roots).
- Glob/grep skip `.git`, `node_modules`, build dirs, and `.harness2`.

## Safety

The human owns this section. The project config is **untrusted data**: the model
can write it, so it cannot set safety policy or hard caps. Only the user config,
environment, and CLI may change host-owned fields (`HOST_OWNED_PATHS` in
`src/config.ts`: `safety`, all hard caps/budgets, provider endpoint/key/headers,
context window, and the session directory). A project config may still tune
workflow preferences such as temperature and loop defaults.

- **File tools**: every read/write/edit/ls/glob/grep path is realpath-resolved and
  must be inside `cwd` plus `safety.readRoots`/`writeRoots`/`allowedPaths`.
  Anything else creates an approval request:
  `[y] once  [s] session  [a] always  [n] deny` (+ optional reason). Grants are
  scoped to the workspace and requesting conversation stream.
- **Fetch**: network policy `ask|allow|deny`. `ask` requests approval per origin.
  Redirects are followed manually; a cross-origin redirect asks again, and
  `deny` blocks it.
- **Bash**: a classifier flags absolute/`~`/`..` paths outside the cwd, network
  commands (curl, ssh, git push, npm install, docker pull, ...), URLs, and `$HOME`,
  then requests approval. `deny` blocks network outright. This is a **heuristic
  gate, not a jail**; `bash -c` can still read what the shell can read. The
  command's `cwd` requires **write** authority, not read authority.
- **Environment**: tool subprocesses get a minimal allowlist (`PATH`, locale,
  `HOME`, `TMPDIR`, ...), not the host environment; provider keys and tokens do
  not leak into commands. Add names with `--env-allow` or `safety.envAllowlist`.
- **Sandbox**: `--sandbox` runs bash under `bwrap` with `/` read-only, only
  approved writable roots bound read-write (the cwd is usually one), home masked
  with a tmpfs unless it overlaps an approved root, `/tmp` tmpfs, and network
  unshared unless `--sandbox-network`. Outside writes fail; outside reads remain
  possible because system libraries and toolchains must be readable. Use it when
  you want containment without prompts.
- **Approvals**: `once` / `session` / `always`; `always` grants persist in
  `~/.harness2/grants.json` under workspace+stream-scoped keys.
  Headless runs deny by default; only `--approve-all` bypasses approvals
  (explicitly dangerous).
- The model can see files inside the cwd, including `.env`; the harness does not
  invent secret filtering.

## Configuration

Precedence for safe preferences: CLI flags > environment > `.harness2/settings.json`
(shared, then project-safe fields) > project `.harness2/config.json` > shared
`~/.harness2/config.json` > defaults. The project layer is stripped of
host-owned fields; only the shared user config, environment, and CLI may set
safety, caps/budgets, provider endpoint/key/headers, context window, or the
session directory. Project settings may override model/effort/mode/context/UI
preferences but not approvals, network, sandbox, or loop-change policy.
Saved interactive choices in `~/.harness2/settings.json` override config
defaults unless the matching CLI flag or environment variable is set for that
run; an active provider profile then supplies model/effort/mode. `--config <path>`
uses one explicit trusted file instead of discovery.

```json
{
  "provider": {
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "qwen3",
    "mode": "auto",
    "temperature": 0.2,
    "maxTokens": 16384,
    "contextWindow": 32768,
    "retries": 2,
    "extraBody": {},
    "modelEfforts": { "qwen3": ["low", "medium", "high"] },
    "totalTokenBudget": 0,
    "promptTokenBudget": 0
  },
  "reasoning": { "effort": "medium" },
  "prompt": {
    "template": "chatml",
    "thinkingTags": [["<think>", "</think>"], ["<thinking>", "</thinking>"]],
    "thinkingControl": "none"
  },
  "loop": {
    "maxStepsCap": 100,
    "defaultMaxSteps": 40,
    "maxChildAgents": 8,
    "runTimeBudgetMs": 0,
    "compactAtPct": 0.95,
    "changes": "auto"
  },
  "safety": {
    "approvals": "on",
    "network": "ask",
    "bashSandbox": false,
    "sandboxNetwork": false,
    "readRoots": [],
    "writeRoots": [],
    "allowedPaths": [],
    "envAllowlist": []
  },
  "ui": { "showThinking": false, "color": true },
  "session": { "enabled": true, "dir": "~/.harness2/sessions" }
}
```

Environment: `HARNESS2_BASE_URL`, `HARNESS2_API_KEY` (or `OPENAI_API_KEY`),
`HARNESS2_MODEL`, `HARNESS2_MODE`, `HARNESS2_REASONING_EFFORT`,
`HARNESS2_CONTEXT_WINDOW`, `HARNESS2_MAX_STEPS`, `HARNESS2_NETWORK`,
`HARNESS2_SANDBOX`, `HARNESS2_SANDBOX_NETWORK`, `HARNESS2_HOME`.

Budgets are host-owned and off by default. `--token-budget` caps
prompt+completion tokens for the whole run tree, `--prompt-budget` caps
cumulative prompt tokens, `--time-budget` sets a wall-clock limit, and
`--max-child-agents` caps child conversations (0 disables children). The model
sees the live ledger in `[harness loop state]` and `loop_inspect`; it can spend
within the budget but cannot raise it. Compaction turns count toward it.

Provider notes:

- `baseUrl` is normalized: a bare host gets `/v1`; a URL ending in
  `/v1/chat/completions` or `/v1/completions` is reduced to the base.
- `mode: "auto"` tries chat and falls back to completions on 404/405/501 or a
  parameter/tool rejection before any output. The fallback is remembered.
- `mode: "responses"` uses the OpenAI Responses API; it is selected
  automatically by the OpenAI OAuth profile.
- For `/v1/completions`, the harness renders the prompt itself
  (`chatml` or `plain`). If your server already applies a chat template on
  completions, use chat mode instead, or edit the template/stop configuration.
- `extraBody` is spread into every request body for server-specific fields.

## Native providers, models, and thinking effort

Three native logins are built in:

- `/login` — opens a searchable provider menu. Choosing a provider starts its
  login prompts.
- `/login deepseek` — prompts only for the API key; the base URL is
  `https://api.deepseek.com/v1`.
- `/login llama-swap` — prompts for the base URL and an optional API key.
- `/login openai` — ChatGPT/Codex OAuth. It prints an `auth.openai.com` URL,
  opens a browser when possible, and waits on a local `127.0.0.1` callback. The
  OAuth token is refreshed when needed and used against the Codex Responses
  backend (`https://chatgpt.com/backend-api/codex`). Model discovery merges the
  Codex model catalog with a bundled Codex catalog (Astra, Sol, Terra, Luna,
  Daybreak, and related models) so an account/version-filtered API cannot hide
  models; API metadata wins when present. The catalog request sends
  `client_version=0.99.0`; override it with `OPENAI_CODEX_CLIENT_VERSION` if the
  backend expects a different version.

DeepSeek and llama-swap validate by calling `GET {baseUrl}/models`; OpenAI uses
`GET .../codex/models?client_version=...`. Profiles are saved to
`~/.harness2/auth.json` (mode `0600`). `/logout` clears the active
saved profile. The saved provider (base URL, key, model, effort, mode, and any
API-reported context window) is applied at startup unless the matching CLI flag
or environment variable overrides it:
`--api-key`, `--model`, `--mode`, `--effort`, `--context-window` and their
`HARNESS2_*`/`OPENAI_*` equivalents. An explicit base URL (`--base-url` / `HARNESS2_BASE_URL` /
`OPENAI_BASE_URL`) disables the saved profile entirely, so a stored key is never
sent to an overridden URL.

`/model` (or `/models`) fetches every saved provider's model catalog — OpenAI's
Codex catalog or `GET {baseUrl}/models` — and opens one searchable list of all
models: type to filter, use `↑/↓` to navigate, and `Enter` to choose. Choosing a model from another provider
switches the active provider, base URL, API key, and transport mode, and restores
that provider's saved model settings. Rows identify their provider and mark the
current and each provider's saved model. Model rows
show their API context limit and declared effort levels when the server exposes
them, and selecting a model uses those values for the control panel,
auto-compaction, and `/effort`. The selected model's thinking effort defaults to
its highest declared level, or `auto` when it declares none. `/model <id>` sets a
model directly with the same defaults.

`/effort` refreshes the current model's capability metadata and opens a menu with
only `auto` plus the effort levels that model declares. Providers that do not
expose effort metadata return only `auto`; declare levels manually in
`provider.modelEfforts` (for example `{"o3": ["low","medium","high"]}`) to enable
them. The chosen model and effort are saved with the active provider and
reapplied at startup.

`/context-size` fetches `/v1/models` and lists every model's API-reported context
window, marking the current model. It also refreshes the current maximum. The
window comes from the API (`context_window`, `context_length`, `max_model_len`,
`n_ctx`, and similar fields). llama-swap may not report it; in that case the
configured `provider.contextWindow` is used and the panel appends `*`. Startup
attempts the same API refresh, so API values win over configured defaults.

Effort values: `auto` (omit the parameter, model default), `none`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`, and `ultra` where a model declares it.
The harness sends `reasoning_effort` for chat/Responses and adds a
reasoning-effort line to completion prompts; `auto` sends nothing. DeepSeek's
models do not expose effort metadata in `/v1/models`, so the built-in fallback
declares `low`, `medium`, `high`, and `max` for them. DeepSeek's reasoner model
uses its native reasoning channel, which the chat parser reads as
`reasoning_content`.

Every other fixed-option directive also opens a searchable menu: `/mode`,
`/approvals`, `/sandbox`, `/network`, `/loop preset`, and `/loop changes`.
Directive arguments still work for scripting.

The prompt has a two-line control panel below it: model and effort on the first
line; agent-centric tokens and context used/max on the second. `in`/from model is
the cumulative completion tokens the model returned (including reasoning);
`out`/to model is the cumulative prompt tokens the harness sent. The outbound
total grows by the full prompt every step; context is only the latest request's
`usage.prompt_tokens` (a `~` marks an estimate when the provider did not report
usage). The maximum comes
from `/v1/models` metadata; a `*` marks a configured fallback used when the API
does not report one (notably some llama-swap models). `/context-size` lists all
API-reported sizes and refreshes the current limit.

Interactive choices are stored in `~/.harness2/settings.json` (mode `0600`):
model, effort, mode, context window, approvals, network, bash sandbox, loop
changes, and whether thinking is expanded. A project `.harness2/settings.json`
may override only model/effort/mode/context/show-thinking. Declared per-model
effort capabilities can be supplied under `provider.modelEfforts` in config.
These values are reapplied at startup unless a matching CLI flag or environment
variable is set for that run. Provider logins (base URL and API key) remain in
`auth.json`.

Saved safety choices also apply to headless runs. Override them for one run with
`--approvals on`, `--network ask`, `--no-sandbox`, or `--loop-changes auto`.

## Interactive commands

The interactive UI clears the visible screen and prior scrollback on entry. The
conversation scrolls in the area above a fixed footer and remains available in
normal terminal scrollback. The footer has a reddish separator, a wrapped input
area that grows upward, another reddish separator, and the pinned
model/effort/token/context panel.

Type `/` to open the command menu. Keep typing to filter by command name;
`↑/↓` selects, `Tab` inserts the selected command (with a trailing space for
arguments), and `Enter` runs the selected command. `/help` lists every command
and key binding from the same registry.

Fixed-option commands such as `/model`, `/effort`, `/login`, `/mode`,
`/approvals`, `/sandbox`, `/network`, `/loop preset`, and `/loop changes` open a
searchable option menu. Type to filter, `↑/↓` to navigate, `Enter` to choose, or
`Esc`/`Ctrl-C` to cancel. The option menus and `/` command menu use the same
visual style.

`/help`, `/quit`, `/login [provider]`, `/logout`, `/model [name]`, `/models`,
`/context-size`, `/mode [mode]`, `/effort [level]`, `/thinking`,
`/loop [show|edit|preset|reset|changes]`,
`/compact`, `/clear`, `/sessions`, `/resume`, `/session`, `/export`,
`/approvals`, `/sandbox`, `/network`, `/tools`.

Input: `Enter` sends, `Alt+Enter`/`Ctrl-J` inserts a newline, `Esc` aborts a
running turn or cancels an option menu, `Ctrl-C` clears the line or aborts a
running turn (empty prompt exits), `Ctrl-D` exits, `Ctrl-O` toggles all thinking
(while a turn runs the rebuild happens after it finishes), up/down is history
when the command menu is closed, `Ctrl-A/E/U/K/W` edit.
Bracketed paste is supported.

## Sessions and compaction

- Sessions live in `~/.harness2/sessions`, one JSONL file per conversation; the
  first line records cwd/model/mode. `-c` resumes the latest for this cwd, and
  `/sessions` lists only sessions for the current cwd.
- `loadSession` rebuilds messages, loop spec/stage, notes, todos, and usage; it
  repairs an interrupted tool call with a synthetic failed result.
- Context usage uses provider-reported prompt tokens when available, otherwise an
  estimate. Auto-compaction runs when usage crosses `compactAtPct` (default
  `0.95`) and is hard-capped at 95% of the model window, leaving 5% headroom.
  Older messages are summarized by the model; the summary is kept, and recent
  messages plus notes/todos survive. `/compact` forces it. Child streams are
  never mixed into the main resume state.
- `/export [path]` writes a markdown transcript.

## Headless use

```bash
harness2 -p --json ... "task"                    # JSONL events on stdout
harness2 -p --events-file run.jsonl ... "task"   # live feed to a file
harness2 -p --approve-all --json ... "task"      # no prompts (dangerous)
harness2 -p -c ... "continue where you left off" # resume then run
echo "task" | harness2 -p --mode chat ...        # stdin prompt
```

Exit codes: `0` completed/halted, `1` max steps/error, `130` aborted.

## Development

```bash
npm install         # also builds dist via prepare
npm test            # node:test, mock OpenAI server, unit + e2e
npm run typecheck   # tsc --noEmit
npm run build       # compile src to dist for the npm package
npm run mock        # demo server on :8099 (MODE=text|markdown|thinking|approval|slow|loop|spawn|tool|toolfail)
```

Layout:

```
src/main.ts             CLI entry
src/config.ts           defaults, file/env/flag merge, normalization
src/settings.ts         persisted interactive choices
src/events.ts           event union + bus
src/session.ts          JSONL store, resume, export, history
src/provider/           http/SSE, chat, completions, auto fallback
src/prompt/             streaming tag splitter, completions renderer, system prompt
src/loop/               spec validation, predicates, kernel, conversation state
src/tools/              fs, bash, fetch, todo, loop control, registry
src/safety/             path jail, bash classifier, approvals/grants
src/ui/                 terminal/raw keys, full-screen renderer, footer, editor
src/modes/              interactive, print
test/                   mock server, unit, kernel, e2e
dist/                   compiled package output (generated by npm run build)
tsconfig.build.json     build config for the global package
```

## Deliberate omissions

No MCP, skills, image input, LSP, HTTP RPC server, plugins, or multi-user
isolation. No `.gitignore` support in glob/grep. The project config is not a
security boundary; host policy comes from the user config, env, and CLI. The
bash classifier is best-effort; use `--sandbox` for real containment, and note
that the sandbox still exposes host system files read-only because toolchains
need them. The completions path only ships `chatml` and `plain` templates; use
chat mode for native templates/tools.
Everything is one process and one terminal. Markdown is line-oriented: headings,
lists, task lists, quotes, fenced code, aligned tables, and inline emphasis/links
are supported, but not full CommonMark, setext headings, or syntax highlighting.

## License

MIT © Daniel Meneses
