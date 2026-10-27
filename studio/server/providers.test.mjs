/* Tests for the provider registry + settings store (the logic behind the
   minimum-effort UI routes). Offline — no network, no live proxy. The routes in
   proxy.mjs are thin glue over these; live endpoints need the running server.

   Run: node server/providers.test.mjs   (or: npm run test:providers)
*/
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// isolate the settings file BEFORE importing settings.mjs
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ergon-set-"));
process.env.ERGON_SETTINGS_FILE = path.join(TMP, "settings.json");
process.env.ERGON_SETTINGS_SECRET = "test-secret-123";

const { PROVIDERS, getProvider, canonicalPrefix, resolveProvider, providerList,
        modelsRequest, parseModelList, OPENAI_DEFAULT_BASE } = await import("./providers.mjs");
const { getSetting, setSetting, clearSetting, statusFor, _reset } = await import("./settings.mjs");

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }
const clearEnv = (...ks) => ks.forEach((k) => delete process.env[k]);

// ── registry ──
await test("registry has the expected provider families", () => {
  for (const p of ["openai", "anthropic", "nvidia", "groq", "gemini", "ollama", "vllm", "azure"])
    assert.ok(PROVIDERS[p], `missing ${p}`);
});

await test("aliases canonicalize", () => {
  assert.equal(canonicalPrefix("claude"), "anthropic");
  assert.equal(canonicalPrefix("nim"), "nvidia");
  assert.equal(canonicalPrefix("google"), "gemini");
  assert.ok(getProvider("claude") === PROVIDERS.anthropic);
});

await test("nvidia maps to openai kind + NVIDIA endpoint", () => {
  const s = PROVIDERS.nvidia;
  assert.equal(s.kind, "openai");
  assert.equal(s.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.deepEqual(s.keyEnvs, ["NVIDIA_API_KEY", "OPENAI_API_KEY"]);
});

// ── resolveProvider precedence ──
await test("saved key beats env key", () => {
  const r = resolveProvider("groq", { apiKey: "saved-key" }, { GROQ_API_KEY: "env-key" });
  assert.equal(r.key, "saved-key");
  assert.equal(r.keySource, "saved");
});

await test("env key used when nothing saved; tries chain in order", () => {
  const r = resolveProvider("nvidia", null, { OPENAI_API_KEY: "oai" });   // NVIDIA_API_KEY absent
  assert.equal(r.key, "oai");
  assert.equal(r.keySource, "env:OPENAI_API_KEY");
  assert.equal(r.baseUrl, "https://integrate.api.nvidia.com/v1");
});

await test("openai default base when none set", () => {
  const r = resolveProvider("openai", null, { OPENAI_API_KEY: "k" });
  assert.equal(r.baseUrl, OPENAI_DEFAULT_BASE);
});

await test("saved base_url overrides default", () => {
  const r = resolveProvider("vllm", { apiKey: "k", baseUrl: "http://gpu-box:8000/v1" }, {});
  assert.equal(r.baseUrl, "http://gpu-box:8000/v1");
});

await test("unknown provider resolves to error", () => {
  assert.ok(resolveProvider("bogus", null, {}).error);
});

await test("ollama needs no key (local)", () => {
  const r = resolveProvider("ollama", null, {});
  assert.equal(r.key, null);
  assert.ok(r.spec.local);
});

// ── providerList (secret-free picker data) ──
await test("providerList marks configured + never leaks the key", () => {
  const list = providerList((p) => (p === "groq" ? { apiKey: "secret!" } : null));
  const groq = list.find((x) => x.prefix === "groq");
  assert.equal(groq.configured, true);
  assert.ok(!("key" in groq) && !("apiKey" in groq));
  const ollama = list.find((x) => x.prefix === "ollama");
  assert.equal(ollama.configured, true);   // local → always "configured"
});

// ── model list request + parse ──
await test("modelsRequest builds the right URL per kind", () => {
  const oa = modelsRequest("groq", resolveProvider("groq", { apiKey: "k" }, {}));
  assert.equal(oa.url, "https://api.groq.com/openai/v1/models");
  assert.ok(oa.headers.authorization.startsWith("Bearer "));
  const an = modelsRequest("anthropic", resolveProvider("anthropic", { apiKey: "k" }, {}));
  assert.equal(an.url, "https://api.anthropic.com/v1/models");
  assert.ok(an.headers["x-api-key"]);
  const ge = modelsRequest("gemini", resolveProvider("gemini", { apiKey: "k" }, {}));
  assert.ok(ge.url.includes("generativelanguage.googleapis.com"));
  assert.ok(ge.headers["x-goog-api-key"]);
});

await test("parseModelList normalizes OpenAI + Gemini shapes, dedups, sorts", () => {
  const oa = parseModelList("openai", { data: [{ id: "b" }, { id: "a" }, { id: "a" }] });
  assert.deepEqual(oa, ["a", "b"]);
  const ge = parseModelList("gemini", { models: [{ name: "models/gemini-x" }, { name: "models/gemini-a" }] });
  assert.deepEqual(ge, ["gemini-a", "gemini-x"]);
});

// ── settings store (encrypted at rest, secret-free status) ──
await test("set then get round-trips the key; file has no plaintext", () => {
  _reset();
  setSetting("groq", { apiKey: "gsk_supersecret", baseUrl: "" });
  assert.equal(getSetting("groq").apiKey, "gsk_supersecret");
  const onDisk = fs.readFileSync(process.env.ERGON_SETTINGS_FILE, "utf8");
  assert.ok(!onDisk.includes("gsk_supersecret"), "plaintext key leaked to disk!");
});

await test("statusFor is secret-free (last4 only)", () => {
  _reset();
  setSetting("groq", { apiKey: "gsk_abcd1234" });
  const st = statusFor("groq");
  assert.equal(st.saved, true);
  assert.equal(st.last4, "1234");
  assert.ok(!("apiKey" in st) && !("key" in st));
});

await test("empty apiKey clears the key but keeps base_url", () => {
  _reset();
  setSetting("vllm", { apiKey: "k", baseUrl: "http://x/v1" });
  setSetting("vllm", { apiKey: "" });
  const g = getSetting("vllm");
  assert.ok(!g.apiKey);
  assert.equal(g.baseUrl, "http://x/v1");
});

await test("clearSetting removes everything", () => {
  _reset();
  setSetting("groq", { apiKey: "k" });
  clearSetting("groq");
  assert.equal(getSetting("groq"), null);
  assert.equal(statusFor("groq").saved, false);
});

await test("saved key takes precedence via resolveProvider", () => {
  _reset();
  setSetting("groq", { apiKey: "saved-wins" });
  const r = resolveProvider("groq", getSetting("groq"), { GROQ_API_KEY: "env-loses" });
  assert.equal(r.key, "saved-wins");
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nproviders.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  ✗ ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
