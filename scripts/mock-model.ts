import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8099);
const mode = process.env.MODE ?? "text";
let requests = 0;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pause = mode === "slow" ? 80 : 0;

const server = createServer((req, res) => {
  void (async () => {
    if ((req.url ?? "").includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "mock-model",
              context_window: 32768,
              reasoning: { supported_efforts: ["low", "high"] },
            },
            {
              id: "mock-model-pro",
              context_window: 65536,
              reasoning: { supported_efforts: ["low", "medium", "high"] },
            },
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const part of req) raw += part.toString();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // ignore
    }
    requests++;
    const isChat = (req.url ?? "").includes("/chat/completions");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (obj: unknown): void => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    if (isChat) {
      let text = `mock response ${requests}. model=${String(body.model ?? "?")}`;
      if (mode === "long") {
        text = "wrapping ".repeat(24).trim();
      }
      if (mode === "burst") {
        text = "burst ".repeat(40).trim();
      }
      if (mode === "markdown") {
        text = [
          "## Summary",
          "",
          "I checked **three** things and `package.json`:",
          "",
          "- `package.json` — fine",
          "- tests — **passing**",
          "- [ ] write the docs",
          "",
          "1. first",
          "2. second",
          "",
          "> quoted **bold**",
          "",
          "```ts",
          "const x = 1;",
          "console.log(x);",
          "```",
          "",
          "| File | Status |",
          "|---|:---:|",
          "| README.md | ok |",
          "| src/main.ts | ok |",
          "",
          "See [the docs](https://example.com).",
        ].join("\n");
      }
      let toolCalls: Array<{ name: string; args: unknown }> = [];
      if (mode === "approval" && requests === 1) {
        text = "I need to look outside.";
        toolCalls = [{ name: "read", args: { path: "/etc/hostname" } }];
      } else if (mode === "spawn" && requests === 1) {
        text = "Delegating this part.";
        toolCalls = [{ name: "loop_spawn", args: { task: "child task", name: "kid" } }];
      } else if (mode === "spawn" && requests === 2) {
        text = "child speaking";
      } else if (mode === "spawn" && requests === 3) {
        text = "parent done";
      } else if (mode === "tool" && requests === 1) {
        text = "Running the command.";
        toolCalls = [{ name: "bash", args: { command: "printf 'hello\\nworld\\n'" } }];
      } else if (mode === "toolfail" && requests === 1) {
        text = "Running a failing command.";
        toolCalls = [{ name: "bash", args: { command: "printf 'oops\\n' >&2; exit 3" } }];
      } else if (mode === "loop" && requests === 1) {
        text = "Switching to a verify loop.";
        toolCalls = [
          {
            name: "loop_set",
            args: {
              reason: "demo",
              spec: {
                name: "demo-loop",
                stages: [{ id: "work", goal: "finish the demo" }],
                finish: { modelStopped: true },
              },
            },
          },
        ];
      }
      if (mode === "thinking") {
        const reasoning = "I should answer briefly and stay inside the workspace.";
        for (let i = 0; i < reasoning.length; i += 4) {
          send({ choices: [{ delta: { reasoning_content: reasoning.slice(i, i + 4) } }] });
          if (pause) await sleep(pause);
        }
      }
      if (mode === "burst") {
        send({ choices: [{ delta: { content: text } }] });
      } else {
        for (let i = 0; i < text.length; i += 4) {
          send({ choices: [{ delta: { content: text.slice(i, i + 4) } }] });
          if (pause) await sleep(pause);
        }
      }
      if (toolCalls.length) {
        send({
          choices: [
            {
              delta: {
                tool_calls: toolCalls.map((c, index) => ({
                  index,
                  id: `call_${index}`,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      } else {
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      }
      send({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } });
    } else {
      let text = `mock completion ${requests}`;
      let toolCalls: Array<{ name: string; args: unknown }> = [];
      if (mode === "approval" && requests === 1) {
        toolCalls = [{ name: "read", args: { path: "/etc/hostname" } }];
      }
      const full = ` thinkingmock thinking response${text}${toolCalls
        .map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.args })}</tool_call>`)
        .join("")}`;
      for (let i = 0; i < full.length; i += 4) {
        send({ choices: [{ text: full.slice(i, i + 4), finish_reason: null }] });
      }
      send({ choices: [{ text: "", finish_reason: "stop" }] });
      send({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  })().catch((e) => {
    res.statusCode = 500;
    res.end(String(e));
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock model on http://127.0.0.1:${port}/v1 (mode ${mode})\n`);
});
