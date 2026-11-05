# harness2 — repository notes

- Node 22.18+; TypeScript runs directly via type stripping. No runtime deps.
- The npm package ships compiled `dist/**/*.js` (Node refuses TypeScript type
  stripping under `node_modules`) and installs the global commands `harness2`
  (primary) and `h2` (alias). `npm run build` cleans and compiles with
  `tsconfig.build.json`; `prepare` builds before packing. Development still runs
  `src/main.ts` directly. `VERSION` is read from `package.json`.
- All harness-owned state lives under `~/.harness2` (`HARNESS2_HOME` overrides):
  `config.json`, `auth.json`, `settings.json`, `grants.json`, `history.jsonl`,
  `sessions/`, and `tmp/`. `postinstall` creates it; runtime ensures it and
  migrates legacy `~/.config/harness2` files plus project sessions/history.
  Project `.harness2/config.json` and `settings.json` may override safe
  preferences, but auth, grants, sessions, history, and safety fields are not
  overlaid from a project at runtime.
- After changes: `npm run typecheck` and `npm test`. Tests use a mock OpenAI
  server; no real model is needed.
- Keep the event schema (`src/events.ts`), session resume (`src/session.ts`), and
  renderer in sync. Every new event must survive `loadSession` or be explicitly
  filtered.
- The system prompt must stay static. Live loop state goes in
  `buildStateMessage()` and is appended as a persisted synthetic user message
  each step; this is what makes the request prefix cacheable. Do not add step,
  stage, notes, todos, or the spec back into the system prompt.
- Send all tool schemas every step. Stage/tool-policy restrictions belong in the
  state and in dispatch enforcement, not in the request's tool list.
- Treat `finish_reason: length|max_tokens` as incomplete, not as the model
  stopping: drop partial tool calls, nudge the model to continue, and error after
  three consecutive no-progress turns. Never report a truncated turn as
  `completed`.
- The model owns the loop (`src/loop/spec.ts`, `src/tools/loop.ts`), but never
  the safety envelope: path jail, approvals, network policy, and hard caps must
  stay outside the spec.
- Host policy is separate from project data. A project `.harness2/config.json`
  is untrusted (the model can write it) and is stripped of `HOST_OWNED_PATHS`;
  project settings may only override model/effort/mode/context/UI preferences.
  Only the shared user config, env, and CLI may set safety, caps/budgets,
  provider endpoint/key/headers, context window, or the session directory. Add
  new capability fields to `HOST_OWNED_PATHS` when introducing them.
- All hard limits live in a single `RunBudget` per run tree (`src/loop/budget.ts`):
  token/prompt tokens, child-agent count, and wall clock. Children share the
  parent ledger; compaction turns count. The model sees the ledger but cannot
  raise it.
- Loop mutations are staged and committed atomically by `commitMutations()` after
  a tool batch, in call order, with a `specVersion` conflict check. Do not
  mutate `conv.spec` directly from a tool. Preserve the current stage by id.
- Predicate commands and anything that executes an operation must go through the
  normal tool dispatch path so loop policy, approvals, output caps, and events
  apply. Do not add side channels.
- Bash subprocesses receive `toolEnvironment(cfg)` (minimal allowlist), never the
  full host environment. Keep provider keys out of tool child processes.
- Approval grants are workspace- and stream-scoped; approval events must be
  attributed to the requesting conversation stream. Cross-origin redirects need
  a fresh approval. Sandbox writable mounts must come only from approved roots.
- Interactive option choices persist in `src/settings.ts` (`~/.harness2/settings.json`);
  fixed-option commands use `Editor.select` and must also update the active
  auth profile when they touch model/effort/mode. Model metadata context limits
  are persisted as `contextWindow`.
- The input footer and running status show model, effort, provider usage tokens,
  and context used/max. Conversation context comes from provider
  `usage.prompt_tokens`; fall back to an estimate and mark it with `~`. Auto
  compaction is hard-capped at 95% of the context window. The footer is
  agent-centric: `in` is cumulative completion tokens returned by the model;
  `out` is cumulative prompt tokens sent to it; `context` is only the latest
  request.
- The UI clears the normal screen once and pins the footer to the bottom: red
  separator, wrapped input (the editor grows it upward as needed), red separator,
  then the two-line model/token/context panel. Output lives in a scroll region
  above the footer so completed lines remain in normal terminal scrollback; the
  editor and renderer save/restore the output cursor before drawing footer rows. Use `\r\n` line endings in raw mode and
  sanitize model/tool text before writing it. Keep thinking dim. Thinking
  blocks are buffered and collapsed by default. Ctrl-O (and `/thinking`) toggles
  all blocks by rebuilding the transcript from the renderer's event history with
  the blocks expanded/collapsed in place; if a turn is running, the rebuild
  happens at the end. Use the summary
  (`✻ thinking · N chars · … · ctrl-o to expand all`) rather than printing thinking
  text by default. Escape aborts a running turn and cancels option menus; Ctrl-C
  still aborts/clears, and Ctrl-O remains the thinking toggle. Send assistant text through the markdown renderer.
- Native provider auth is in `src/auth.ts` (`~/.harness2/auth.json`, mode 0600). Never put API keys or OAuth tokens in config files, sessions, or
  event feeds. DeepSeek/llama-swap use `/v1/models`; OpenAI uses ChatGPT OAuth
  (`src/provider/openai-oauth.ts`) and the Codex model catalog. Startup applies
  the active profile unless the matching CLI flag/env var overrides that field.
  `/model` and `/models` aggregate every saved provider; choosing another
  provider's model switches auth/base/key/mode. Responses mode is implemented in
  `src/provider/responses.ts`; the Codex catalog requires `client_version`.
  `src/provider/openai-codex-models.ts` is the bundled fallback catalog merged
  with the live Codex catalog.
- Reasoning effort values live in `src/reasoning.ts` (`auto` through `ultra`).
  `/model` defaults effort to the highest level the model declares, and `/effort`
  lists only `auto` plus declared levels. Capabilities come from `/v1/models`
  metadata, then `provider.modelEfforts`, then a native provider's
  `defaultEfforts` (DeepSeek declares `low/medium/high/max`); with none, only
  `auto` is offered. Save the active profile's model/effort.
- Context maxima come from `/v1/models` metadata, refreshed at startup, on model
  selection/login, and by `/context-size`. A `*` marks the configured fallback
  used when the API does not report a window (notably llama-swap).
- Slash command discovery lives in `src/commands.ts`; use it for `/help` and the
  editor's `/` type-ahead (filter, ↑/↓ select, Tab insert, Enter run). Command
  dispatch stays in `src/modes/interactive.ts`; keep the registry and dispatch in
  sync.
- Assistant text streams chunk-by-chunk (`appendStreaming`); do not line-buffer
  it. Providers split large batched/content chunks for display in
  `src/provider/anim.ts`; real token streams are untouched.
- Tool calls buffer their output until the result, then render as full-width
  near-black muted-yellow cards (truecolor 30,27,8; 256-color 58 fallback):
  bright green text on success, bright red on failure, including header, output,
  diff, and status. Show the running tool in
  the status line instead of streaming raw output. Keep cards full width by
  padding to the terminal width.
- Completions mode is prompt rendering + text tool calls; chat mode is native
  tool calls. Keep both working; `auto` falls back before any output.
- Prefer the existing mock server (`test/mock-server.ts`,
  `scripts/mock-model.ts`) for manual checks.
