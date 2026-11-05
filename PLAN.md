> **Status: v0.1 implemented.** Resolved decisions: TypeScript on Node 22 with
> zero runtime dependencies; chat + legacy completions + `auto` fallback with
> `reasoning_effort`; declarative loop spec plus loop-control tools (model-authored
> JS loops were deliberately not added); all three stream surfaces (live tokens,
> prefixed subagent streams, JSONL `--json`/`--events-file`); inline terminal UI;
> approvals on by default with opt-in `bwrap`. Prompt caching uses a fully static
> system prompt plus persisted `[harness loop state]` user messages, so each
> request is a prefix of the next. See README for usage.

# harness2 — a coding agent whose loop the model controls

Empty repo, so this is a from-scratch design. Goal: the model, not the harness,
decides how the next step of the loop looks. The harness supplies safe building
blocks and **complies**; it only refuses where the human-owned safety envelope
says no.

## 1. The core idea

Normal harness: `while (!done) { model -> tools -> model }`. Fixed.

harness2: the loop itself is a value the model can inspect and rewrite.

```
model turn  ──►  tools (incl. loop_* tools)  ──►  spec change applied at step boundary
                                                     │
                     ┌───────────────────────────────┘
                     ▼
             kernel runs the new spec
```

Loop control tools the model gets:

| tool | what it does |
|---|---|
| `loop_inspect` | current spec, stage, step, budgets left, notes, recent tool outcomes |
| `loop_set` | replace/merge the loop spec (stages, goals, tool subset, bounds, stop predicates, sampling) |
| `loop_stage` | enter/advance/jump stage, or restart the loop |
| `loop_ask` | pause the loop and ask the human a question (answer becomes tool output) |
| `loop_note` | persistent scratchpad used to rebuild context after compaction |
| `loop_halt` | stop with a final answer (plain text with no tool calls also stops) |
| `loop_spawn` | *(later)* run a child loop with its own spec, return its result |

A turn with no tool calls = the model declares it is done. The harness then
evaluates the current `finish` predicate; if false it says why and continues.
That is the whole trick: stopping is a predicate, not a fixed rule.

### Immutable envelope (the model cannot edit this)

Path jail roots, approval policy, network policy, hard caps (max steps, token /
prompt / time / child budgets, max tool output), which built-ins exist, sandbox
on/off, provider endpoint/key/headers, and the session directory. Model-authored
specs are validated and clamped against it. Otherwise "rewrite your loop" becomes
"disable the seatbelt". Safety fields live outside the spec the model sees.

**Hardening pass (implemented):** the envelope is also kept out of project data.
`.harness2/config.json` is stripped of `HOST_OWNED_PATHS` before merging, so a
model-written project config cannot grant itself approvals, network, sandbox
off, larger caps, a different provider endpoint, or a different session
directory. Only user config, env, and CLI set host fields. Persisted session
specs are re-clamped on resume.

## 2. Transport: OpenAI-compatible `/v1/completions`

Legacy completions = raw prompt in, text out. No roles, no native tool calls.
So the harness owns:

- **Prompt assembly.** Render system + tools + history into one string using a
  configurable template. Ship ChatML (Qwen-family, most local instruct models)
  and a plain `### role` format. `prompt.template = "chatml" | "plain" | <path>`.
  (llama.cpp does not apply the chat template on `/v1/completions`; vLLM does
  depend on config, so we cannot rely on the server.)
- **Tool call parsing.** Text protocol: `<tool_call>{"name":...,"arguments":{...}}</tool_call>`,
  zero or more per turn, plus a fenced-JSON fallback. Streaming parser with a
  buffer, so partial tags never leak into the UI. Optional grammar/`json_schema`
  pass-through for servers that support constrained decoding.
- **Thinking parsing.** Delimiters configurable, defaults cover ` thinking`,
  `<thinking>`, `<|thinking|>`. Streamed on a separate channel, persisted, and
  rendered dim/collapsible. Also a `thinking: auto|on|off` switch that injects
  `/think` / `/no_think` where the model profile wants it.
- **Stop sequences** per profile (`<|im_end|>`, `<|im_start|>`, `\nUser:`),
  because runaway generations are the default failure mode with raw completions.
- `POST {base}/v1/completions` with `stream: true`, SSE parsing, abort,
  retry/backoff on 429/5xx, usage when the server sends it, token estimate
  otherwise. Base URL/model/key from config.

Chat-completions support (`/v1/chat/completions`, native tool calls and
`reasoning_content`) is a second adapter behind the same interface. Cheap to add
once the message/event layer exists; **not** in the first milestone. Confirm
whether you want it at all.

## 3. Convo streams

One append-only, sequenced event stream per conversation. Everything the UI
shows is an event; nothing is rendered ad hoc.

```ts
type Event =
  | { t: "user.message"; text }
  | { t: "assistant.thinking.delta"; text }
  | { t: "assistant.text.delta"; text }
  | { t: "assistant.message"; text; thinking? }
  | { t: "tool.call"; id; name; args }
  | { t: "tool.output.delta"; id; text }
  | { t: "tool.result"; id; ok; output }
  | { t: "loop.spec"; spec; by: "model" | "user"; reason }
  | { t: "loop.stage"; id; step }
  | { t: "approval.request"; id; kind; detail }
  | { t: "approval.result"; id; decision }
  | { t: "usage"; prompt; completion; tokensPerSec }
  | { t: "error"; message; retryable }
  | { t: "done"; reason }
```

- Persisted as JSONL (session file), replayable, resumable.
- UI subscribes to it (text/thinking/tool/loop channels rendered differently).
- `--json` streams the same events to stdout = integration/RPC surface for free.
- Multiple conversations (main + subagents) are separate streams under one
  session later. Live token streaming is in v1 either way.

## 4. Safety model

All file tools resolve paths with `realpath` and must stay inside `cwd` plus
configured roots. Anything outside — read, write, glob, edit — becomes an
approval request. Same for `fetch` URLs and for `bash` commands classified as
network or out-of-root (absolute paths, `..`, redirects, `curl|wget|ssh|git
clone|npm install|docker|sudo|...`). Approvals:

```
[y] once   [s] for this session   [a] always (this path/pattern)   [n] deny (+ reason)
```

Denials come back to the model as `DENIED: ...` so it can reroute. Denial reason
is included. Headless mode denies by default unless `--approve-all` (or a policy
file) is passed. `--sandbox` runs bash under `bwrap` (available here) with cwd
read-write and the rest read-only/network-off. Off by default, because it changes
how real toolchains behave; documented honestly as *approval gate, not a jail*
unless sandbox is on.

Approval decisions are never influenced by the model, and loop specs cannot
touch this section (see immutable envelope).

**Implemented hardening:**

- Grants are keyed by workspace + requesting conversation stream; approval events
  are attributed to that stream.
- `fetch` follows redirects manually; a cross-origin redirect needs a fresh
  approval, and `network: "deny"` blocks it.
- Bash command `cwd` requires write authority, not read authority.
- Tool subprocesses get a minimal environment allowlist; provider keys and host
  tokens are not inherited.
- The sandbox binds only approved writable roots read-write; `/` is read-only,
  home is masked unless it overlaps an approved root, and `/tmp` is a tmpfs.
- Predicate `command` checks run through the normal bash tool path (policy,
  approvals, caps, events) instead of a side channel.
- Hard limits are one shared `RunBudget` ledger for the whole run tree, including
  children and compaction turns; loop rewrites are staged, version-checked, and
  committed atomically after a batch.

## 5. Tool set (v1)

`read` (line numbers, offset/limit, truncation), `write`, `edit` (exact replace,
multi-edit + diff output), `bash` (timeout, streaming output, cwd pinned,
approval classifier), `glob`, `grep` (uses `rg` when present), `ls`, `todo`
(plan list), `ask_user`, `fetch` (GET, size cap), and the `loop_*` tools above.

Skipped on purpose in v1: MCP, skills, images, plugins, subagents, web search,
LSP, syntax highlighting. Easy to add later; none are needed to prove the idea.

## 6. Loop spec

```ts
type LoopSpec = {
  name?: string
  maxSteps: number                    // clamped to config cap
  startStage?: string
  stages: Stage[]
  toolPolicy: { parallel: boolean; allow?: string[]; deny?: string[] }
  onToolError: "retry" | "continue" | "halt"
  compactAtPct?: number               // context compaction trigger
  sampling?: { temperature?: number; topP?: number; maxTokens?: number }
  finish: Predicate | { modelStopped: true }
}

type Stage = {
  id: string
  goal: string                        // injected into the prompt every step
  tools?: string[]
  systemAddendum?: string
  exitWhen?: Predicate
  maxSteps?: number
}

type Predicate =
  | { all: Predicate[] } | { any: Predicate[] } | { not: Predicate }
  | { toolCalled: string } | { toolOk: string } | { fileExists: string }
  | { filesChanged: string[] } | { stepsAtLeast: number }
  | { lastOutputMatches: string }
  | { command: string; expectExit: number; timeoutMs?: number }  // approval-gated
```

No `eval`, no JS in specs — predicates are data, so a spec is inspectable and
safe. `loop_set` merges + validates; invalid specs come back as a tool error with
the reason. Every change is an event, rendered as `↻ loop: ...`.

Built-in presets so the model isn't forced to write JSON from scratch:
`react` (default), `plan-execute`, `tdd`, `review-fix`, `investigate`.
`/loop` shows the current spec; `/loop edit` lets the human swap it too.

## 7. UI

Inline streaming renderer (normal scrollback, not alt-screen): thinking dim,
assistant text plain, tool calls as one-line cards with diff/output previews,
loop changes highlighted, approval prompt at the bottom, tokens/s and context %
in the status line. Custom raw-mode line editor (history, multi-line paste,
Ctrl-C cancels the current request, Ctrl-D exits), slash commands
(`/model /loop /thinking /compact /clear /sessions /resume /help`).
A full-screen TUI can come later; it is the most code for the least value here.

## 8. Context, sessions, config

- Token estimate (chars/4) or usage; compact when above `compactAtPct` by
  summarizing older turns (no tools) and keeping recent turns + `loop_note`s +
  touched files. Compaction is an event, so it's visible and auditable.
- Sessions: `.harness2/sessions/*.jsonl`, `--continue`, `/resume`, `/export md`.
- Config precedence: flags > `.harness2/config.json` (project) >
  `~/.config/harness2/config.json` > env `HARNESS2_*` > defaults. Sample in
  README once code exists.
- `AGENTS.md` from cwd is appended to the system prompt.

## 9. Repo layout

```
package.json  tsconfig.json  README.md  AGENTS.md
src/
  main.ts            CLI, mode dispatch
  config.ts          merge + validate
  events.ts          event types, bus, JSONL sink
  session.ts         store, resume, compaction records
  provider/          http.ts, completions.ts, (chat.ts later)
  prompt/            template.ts, assemble.ts, parse.ts, profiles.ts
  loop/              spec.ts, kernel.ts, predicates.ts
  tools/             index.ts, fs.ts, bash.ts, fetch.ts, todo.ts, loop.ts
  safety/            paths.ts, classify.ts, approvals.ts, sandbox.ts
  ui/                terminal.ts, render.ts, input.ts, theme.ts
  modes/             interactive.ts, print.ts
test/                mock-server.ts + node:test suites
```

Zero runtime dependencies if we can hold to it (Node 22 runs `.ts` directly;
`node:test` for tests; `rg`/`bwrap` used when present). `typescript` as a dev
dependency for `tsc --noEmit`.

## 10. Milestones (all shipped for v0.1)

1. **M0 skeleton** — config, SSE completions client, ChatML/plain prompt,
   stream parser, event bus, JSONL sessions, inline renderer, `--print/--json`.
   Testable against a mock `/v1/completions` server.
2. **M1 tools + safety** — fs/bash/glob/grep/ls/todo/fetch, path jail, approvals,
   diff output.
3. **M2 loop kernel** — spec validation/clamping, predicates, stages, `loop_*`
   tools, runtime spec changes, loop events.
4. **M3 thinking + context** — thinking channel, toggle, token stats, compaction,
   resume.
5. **M4 polish** — slash commands, clipboard/multiline, docs, e2e against mock and
   a real endpoint.

Optional later: subagents/parallel streams, chat-completions adapter, bwrap
sandbox on by default, RPC/SSE server, MCP.

## 11. Test plan

- Unit: SSE parser (chunk boundaries, `[DONE]`, errors), stream tag splitter
  (thinking/tool calls split across chunks), path jail (symlinks, `..`), bash
  classifier, spec validation/clamping, predicates.
- Integration: mock completions server replaying scripted model turns; assert
  event sequence for (a) plain task, (b) model changes loop mid-run, (c) denial
  and reroute, (d) compaction, (e) resume.
- Manual: real server for actual model quality; ask for a base URL/model.

## 12. Resolved decisions

1. TypeScript + Node 22.18+; zero runtime dependencies; node:test.
2. OpenAI-compatible API; chat + completions + auto fallback.
3. Completions renders the prompt itself (chatml or plain); custom server
   templates are out of scope, use chat mode.
4. Chat and reasoning effort are in v1.
5. Declarative loop spec plus loop tools. No model-authored JS loops.
6. Live token streaming, prefixed subagent streams, and a JSONL event feed are
   all in v1.
7. Approvals on by default (once/session/always, persisted grants); bwrap
   sandbox is opt-in.
8. Inline streaming terminal.
9. Resume, compaction, subagents, headless JSON, and the event feed are in v1.
   MCP, skills, images, LSP, RPC, and a full-screen TUI are deliberately out.
