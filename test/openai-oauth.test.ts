import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

test("Codex model catalog includes client_version and parses context/efforts", async () => {
  let request: { url?: string; auth?: string; account?: string; originator?: string } = {};
  const server = createServer((req, res) => {
    request = {
      url: req.url,
      auth: req.headers.authorization,
      account: req.headers["chatgpt-account-id"] as string | undefined,
      originator: req.headers.originator as string | undefined,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        models: [
          {
            slug: "gpt-test",
            context_window: 272000,
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.OPENAI_CODEX_MODELS_URL = `http://127.0.0.1:${address.port}/models`;
  try {
    const { fetchOpenAIModels } = await import("../src/provider/openai-oauth.ts");
    const models = await fetchOpenAIModels({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
      accountId: "acct",
    });
    assert.deepEqual(models.find((model) => model.id === "gpt-test"), {
      id: "gpt-test",
      contextWindow: 272000,
      efforts: ["low", "high"],
    });
    assert.ok(models.some((model) => model.id === "gpt-6-astra"));
    assert.ok(models.some((model) => model.id === "gpt-6-sol"));
    assert.ok(models.every((model) => !model.efforts?.includes("ultra")));
    assert.match(request.url ?? "", /client_version=0\.99\.0/);
    assert.equal(request.auth, "Bearer access");
    assert.equal(request.account, "acct");
    assert.equal(request.originator, "codex_cli_rs");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.OPENAI_CODEX_MODELS_URL;
  }
});
