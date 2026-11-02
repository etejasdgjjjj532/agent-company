import { rmrf } from "./helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeAdapter } from "../src/adapters/opencode.ts";
import { buildCharter, validateCharter } from "../src/core/charter.ts";
import { engineName, normalizeProvider, opencodeProviderSetup, parseEngine, slugify } from "../src/core/providers.ts";

test("engine names parse as cli or api with an optional model", () => {
  assert.deepEqual(parseEngine("codex"), { kind: "cli", cli: "codex" });
  assert.deepEqual(parseEngine("api:groq"), { kind: "api", providerId: "groq", model: undefined });
  assert.deepEqual(parseEngine("api:groq:llama-3.1:70b"), { kind: "api", providerId: "groq", model: "llama-3.1:70b" });
  assert.equal(parseEngine("api:"), null);
  assert.equal(parseEngine("api:Bad Id"), null);
  assert.equal(parseEngine("nope"), null);
  assert.equal(engineName("x", "m"), "api:x:m");
});

test("charters accept api engines and still reject unknown names", () => {
  validateCharter(buildCharter({ rootCli: "api:my-proxy", childClis: ["api:my-proxy:gpt-4o", "claude"] }));
  assert.throws(() => validateCharter(buildCharter({ rootCli: "claude", childClis: ["api:bad id"] })));
});

test("normalizeProvider validates input and keeps an existing key when none is typed", () => {
  const first = normalizeProvider({ name: "Open AI", baseUrl: "https://api.openai.com/v1/", apiKey: " sk-1 ", models: "a, b" });
  assert.equal(first.id, "open-ai");
  assert.equal(first.baseUrl, "https://api.openai.com/v1");
  assert.equal(first.apiKey, "sk-1");
  assert.deepEqual(first.models, ["a", "b"]);
  assert.equal(first.defaultModel, "a");
  const edited = normalizeProvider({ name: "Open AI", baseUrl: "https://api.openai.com/v1", models: ["a"] }, first);
  assert.equal(edited.apiKey, "sk-1");
  const viaEnv = normalizeProvider({ name: "X", baseUrl: "http://localhost:11434/v1", apiKeyEnv: "MY_KEY", apiKey: "ignored", models: [] }, first);
  assert.equal(viaEnv.apiKey, undefined);
  assert.equal(viaEnv.apiKeyEnv, "MY_KEY");
  assert.throws(() => normalizeProvider({ name: "", baseUrl: "https://x.test" }));
  assert.throws(() => normalizeProvider({ name: "x", baseUrl: "ftp://x.test" }));
  assert.throws(() => normalizeProvider({ name: "x", baseUrl: "https://x.test", apiKeyEnv: "bad name" }));
  assert.equal(slugify("日本語 !!"), "provider");
});

test("opencode provider setup builds an openai-compatible provider block", () => {
  const provider = normalizeProvider({ name: "Proxy", baseUrl: "https://p.test/v1", apiKey: "sk-secret-999999", models: "m1" });
  const setup = opencodeProviderSetup(provider, "m2");
  assert.equal(setup.model, "proxy/m2");
  assert.equal(setup.hasSecret, true);
  const cfg = (setup.config as any).provider.proxy;
  assert.equal(cfg.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.options.baseURL, "https://p.test/v1");
  assert.equal(cfg.options.apiKey, "sk-secret-999999");
  assert.deepEqual(Object.keys(cfg.models).sort(), ["m1", "m2"]);
});

test("opencode provider setup reads env-var keys at run time and supports keyless local servers", () => {
  const viaEnv = opencodeProviderSetup(normalizeProvider({ name: "E", baseUrl: "https://e.test/v1", apiKeyEnv: "E_KEY", models: "m" }), undefined, { E_KEY: "from-env" });
  assert.equal((viaEnv.config as any).provider.e.options.apiKey, "from-env");
  assert.throws(() => opencodeProviderSetup(normalizeProvider({ name: "E", baseUrl: "https://e.test/v1", apiKeyEnv: "E_KEY", models: "m" }), undefined, {}), /E_KEY/);
  const local = opencodeProviderSetup(normalizeProvider({ name: "Local", baseUrl: "http://localhost:11434/v1", models: "llama3" }));
  assert.equal((local.config as any).provider.local.options.apiKey, "not-needed");
  assert.equal(local.hasSecret, false);
  assert.throws(() => opencodeProviderSetup(normalizeProvider({ name: "Empty", baseUrl: "http://localhost:1/v1" })));
});

test("the api adapter writes a temporary 0600 config and removes it on cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-prov-"));
  try {
    const provider = normalizeProvider({ name: "Proxy", baseUrl: "https://p.test/v1", apiKey: "sk-secret-999999", models: "m1" });
    const adapter = opencodeAdapter("opencode", { provider, model: "m1" });
    assert.equal(adapter.name, "api:proxy:m1");
    const invocation = adapter.invoke({ cwd: dir, prompt: "hi", profile: "worker", workDir: dir, mcpUrl: "http://127.0.0.1:1/mcp/t" });
    assert.deepEqual(invocation.args.slice(-2), ["--model", "proxy/m1"]);
    const file = invocation.env.OPENCODE_CONFIG;
    const config = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(config.model, "proxy/m1");
    assert.equal(config.mcp.orch.type, "remote");
    assert.equal(config.provider.proxy.options.apiKey, "sk-secret-999999");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(invocation.stdin, "hi");
    assert.ok(invocation.cleanup);
    invocation.cleanup!();
    assert.equal(existsSync(file), false);
  } finally {
    rmrf(dir);
  }
});
