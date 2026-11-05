import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { listModelInfo, listModels } from "../src/provider/models.ts";

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("lists /v1/models with bearer auth and dedupes", async () => {
  let request: { url?: string; auth?: string } = {};
  const server = await serve((req, res) => {
    request = { url: req.url, auth: req.headers.authorization };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          { id: "a" },
          { id: "b", context_window: 128000 },
          { id: "a", meta: { n_ctx: 4096 } },
          { id: "c", max_model_len: 8192, supported_parameters: ["reasoning_effort"] },
          { id: "d", reasoning: { supported_efforts: ["low", "high"] } },
          { id: "e", supported_parameters: ["reasoning"] },
          { id: "f", capabilities: { reasoning: false } },
          { id: "g" },
        ],
      }),
    );
  });
  try {
    const models = await listModels({ baseUrl: `${server.url}/`, apiKey: "secret" });
    assert.deepEqual(models, ["a", "b", "c", "d", "e", "f", "g"]);
    assert.equal(request.url, "/v1/models");
    assert.equal(request.auth, "Bearer secret");
    const infos = await listModelInfo({ baseUrl: server.url, apiKey: "secret" });
    assert.deepEqual(infos, [
      { id: "a", contextWindow: 4096 },
      { id: "b", contextWindow: 128000 },
      { id: "c", contextWindow: 8192, efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] },
      { id: "d", efforts: ["low", "high"] },
      { id: "e", efforts: [] },
      { id: "f", efforts: [] },
      { id: "g" },
    ]);
  } finally {
    await server.close();
  }
});

test("surfaces model list errors", async () => {
  const server = await serve((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad key" }));
  });
  try {
    await assert.rejects(() => listModels({ baseUrl: server.url, apiKey: "nope" }), /HTTP 401/);
  } finally {
    await server.close();
  }
});
