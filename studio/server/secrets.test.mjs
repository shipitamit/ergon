/* Tests for secrets management (env + AWS/GCP/Azure logic).

   Runs against fake providers, so it verifies the LOGIC — provider selection,
   bundle vs per-key resolution, caching, graceful fallback to process.env, and
   the startup overlay — offline. It does NOT verify the real AWS/GCP/Azure SDK
   calls; that needs live cloud credentials (see README).

   Run: node server/secrets.test.mjs   (or: npm run test:secrets)
*/
import assert from "node:assert";
import { getSecret, loadSecrets, _reset } from "./secrets.mjs";

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { _reset(); await fn(); passed++; }
  catch (e) { failed++; failures.push([name, e.message]); }
}

function fakeProvider(store) {
  return {
    fetches: [],
    async fetch(id) {
      this.fetches.push(id);
      if (!(id in store)) throw new Error("not found: " + id);
      return store[id];
    },
  };
}
const quiet = { warn: () => {}, log: () => {} };

await test("env provider reads process.env", async () => {
  process.env.SECRET_A = "from-env";
  assert.equal(await getSecret("SECRET_A", { providerName: "env" }), "from-env");
});

await test("bundle mode reads key from a JSON secret", async () => {
  const p = fakeProvider({ "ergon/prod": JSON.stringify({ ANTHROPIC_API_KEY: "sk-BUNDLE" }) });
  const v = await getSecret("ANTHROPIC_API_KEY", { providerName: "aws", injected: p, bundleId: "ergon/prod" });
  assert.equal(v, "sk-BUNDLE");
});

await test("bundle is fetched once and cached across keys", async () => {
  const p = fakeProvider({ b: JSON.stringify({ A: "1", B: "2" }) });
  await getSecret("A", { providerName: "aws", injected: p, bundleId: "b" });
  await getSecret("B", { providerName: "aws", injected: p, bundleId: "b" });
  assert.equal(p.fetches.length, 1);
});

await test("per-key mode fetches a prefixed secret", async () => {
  const p = fakeProvider({ "ergon/ANTHROPIC_API_KEY": "sk-PERKEY" });
  const v = await getSecret("ANTHROPIC_API_KEY", { providerName: "gcp", injected: p, prefix: "ergon/" });
  assert.equal(v, "sk-PERKEY");
  assert.equal(p.fetches[0], "ergon/ANTHROPIC_API_KEY");
});

await test("per-key result is cached", async () => {
  const p = fakeProvider({ K: "v" });
  await getSecret("K", { providerName: "aws", injected: p, prefix: "" });
  await getSecret("K", { providerName: "aws", injected: p, prefix: "" });
  assert.equal(p.fetches.length, 1);
});

await test("cloud miss falls back to process.env", async () => {
  process.env.FALLBACK = "env-fallback";
  const p = fakeProvider({});
  const v = await getSecret("FALLBACK", { providerName: "aws", injected: p, prefix: "", log: quiet });
  assert.equal(v, "env-fallback");
});

await test("unreadable bundle falls back to process.env", async () => {
  process.env.BK = "env-b";
  const p = { async fetch() { throw new Error("access denied"); } };
  const v = await getSecret("BK", { providerName: "aws", injected: p, bundleId: "x", log: quiet });
  assert.equal(v, "env-b");
});

await test("loadSecrets overlays cloud values into process.env", async () => {
  delete process.env.OVERLAY_ME;
  const p = fakeProvider({ bundle: JSON.stringify({ OVERLAY_ME: "cloud-val" }) });
  await loadSecrets(["OVERLAY_ME"], { providerName: "aws", injected: p, bundleId: "bundle", log: quiet });
  assert.equal(process.env.OVERLAY_ME, "cloud-val");
});

await test("env-mode loadSecrets is a pass-through", async () => {
  process.env.PASSTHRU = "p";
  const m = await loadSecrets(["PASSTHRU"], { providerName: "env" });
  assert.equal(m.PASSTHRU, "p");
});

await test("missing secret returns null (not throw)", async () => {
  delete process.env.NOPE;
  assert.equal(await getSecret("NOPE", { providerName: "env" }), null);
});

console.log(`\nsecrets.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  ✗ ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
