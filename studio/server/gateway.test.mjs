/* Gateway forwarder — forwardRun against a fake fetch (offline). Covers the
   no-runner 503, a forwarded result with usage, non-OK passthrough, an
   unreachable runner, and the stream passthrough shape.
   Run: node server/gateway.test.mjs  */
import assert from "node:assert";
import { forwardRun } from "./gateway.mjs";

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const okFetch = (payload, ok = true, status = 200) => async (url, opts) => ({
  ok, status, json: async () => payload, _url: url, _opts: opts,
});

await test("no target_url → 503 no-runner (does not call fetch)", async () => {
  let called = false;
  const out = await forwardRun(null, { input: "x" }, async () => { called = true; return {}; });
  assert.equal(out.status, 503);
  assert.equal(out.kind, "no-runner");
  assert.equal(called, false);
});

await test("forwards to <target>/run and returns the result + usage", async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200,
    json: async () => ({ text: "hello", usage: { input_tokens: 5, output_tokens: 2, cost: 0.001 } }) }; };
  const out = await forwardRun("http://runner:8900/", { input: "hi" }, fetchImpl);
  assert.equal(out.status, 200);
  assert.equal(out.body.text, "hello");
  assert.equal(out.usage.cost, 0.001);
  assert.equal(seen.url, "http://runner:8900/run");       // trailing slash trimmed, /run appended
  assert.match(seen.opts.body, /"input":"hi"/);
});

await test("a non-OK runner response is passed through with its status", async () => {
  const out = await forwardRun("http://runner:8900", { input: "x" }, okFetch({ error: "boom" }, false, 500));
  assert.equal(out.status, 500);
  assert.equal(out.kind, "error");
  assert.equal(out.body.error, "boom");
});

await test("an unreachable runner → 502", async () => {
  const out = await forwardRun("http://runner:8900", { input: "x" }, async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(out.status, 502);
  assert.equal(out.kind, "unreachable");
});

await test("stream mode hits /run/stream and returns the raw response", async () => {
  let seen = null;
  const fakeRes = { ok: true, status: 200, body: { getReader: () => ({}) } };
  const fetchImpl = async (url) => { seen = url; return fakeRes; };
  const out = await forwardRun("http://runner:8900", { input: "x", stream: true }, fetchImpl);
  assert.equal(seen, "http://runner:8900/run/stream");
  assert.equal(out.kind, "stream");
  assert.equal(out.stream, fakeRes);
});

console.log(`\ngateway.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
