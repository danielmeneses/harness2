import { createServer } from "node:http";

export type MockTurn = {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
  errorStatus?: number;
  errorBody?: string;
};

export type MockServer = {
  url: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
};

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export async function startMock(turns: MockTurn[]): Promise<MockServer> {
  const requests: MockServer["requests"] = [];
  const server = createServer((req, res) => {
    void (async () => {
      if ((req.url ?? "").includes("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "mock", context_window: 32768 },
              { id: "mock-model", context_window: 32768 },
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
        // keep empty
      }
      requests.push({ path: req.url ?? "", body });

      const turn = turns.shift();
      if (!turn) {
        res.statusCode = 500;
        res.end("mock exhausted");
        return;
      }
      if (turn.errorStatus) {
        res.statusCode = turn.errorStatus;
        res.setHeader("Content-Type", "application/json");
        res.end(turn.errorBody ?? JSON.stringify({ error: { message: "mock error" } }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (obj: unknown): void => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };

      if ((req.url ?? "").includes("/chat/completions")) {
        for (const piece of chunk(turn.thinking ?? "", 3)) {
          send({ choices: [{ delta: { reasoning_content: piece } }] });
        }
        for (const piece of chunk(turn.text ?? "", 3)) {
          send({ choices: [{ delta: { content: piece } }] });
        }
        if (turn.toolCalls?.length) {
          send({
            choices: [
              {
                delta: {
                  tool_calls: turn.toolCalls.map((call, index) => ({
                    index,
                    id: `call_${index}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  })),
                },
                finish_reason: turn.finishReason ?? "tool_calls",
              },
            ],
          });
        } else {
          send({ choices: [{ delta: {}, finish_reason: turn.finishReason ?? "stop" }] });
        }
        send({
          choices: [],
          usage: turn.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      } else {
        let text = "";
        if (turn.thinking) text += ` thinking${turn.thinking} response`;
        text += turn.text ?? "";
        for (const call of turn.toolCalls ?? []) {
          text += `<tool_call>${JSON.stringify({ name: call.name, arguments: call.args })}</tool_call>`;
        }
        for (const piece of chunk(text, 4)) {
          send({ choices: [{ text: piece, finish_reason: null }] });
        }
        send({
          choices: [{ text: "", finish_reason: turn.finishReason ?? (turn.toolCalls?.length ? "stop" : "stop") }],
        });
        send({
          choices: [],
          usage: turn.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    })().catch((e) => {
      res.statusCode = 500;
      res.end(String(e));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
