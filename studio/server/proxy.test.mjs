/* Tests for the proxy's security primitives: SSRF guard + rate limiter.
   Run: node server/proxy.test.mjs   (or: npm run test:proxy) */
import assert from "node:assert";
import { isBlockedUrl, makeLimiter } from "./proxy.mjs";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; failures.push([name, e.message]); }
}

// ── SSRF guard ──
test("allows normal external https", () => {
  assert.strictEqual(isBlockedUrl("https://api.stripe.com/v1/x"), null);
});

test("blocks localhost", () => {
  assert.ok(isBlockedUrl("http://localhost:8080"));
});

test("blocks loopback 127.x", () => {
  assert.ok(isBlockedUrl("http://127.0.0.1/secret"));
});

test("blocks private 10.x / 192.168.x", () => {
  assert.ok(isBlockedUrl("http://10.0.0.5/internal"));
  assert.ok(isBlockedUrl("http://192.168.1.1/router"));
});

test("blocks cloud metadata endpoint (169.254.169.254)", () => {
  assert.ok(isBlockedUrl("http://169.254.169.254/latest/meta-data/"));
});

test("blocks 172.16-31 private range but allows 172.32", () => {
  assert.ok(isBlockedUrl("http://172.16.0.1/x"));
  assert.strictEqual(isBlockedUrl("http://172.32.0.1/x"), null);
});

test("blocks non-http(s) protocols", () => {
  assert.ok(isBlockedUrl("file:///etc/passwd"));
  assert.ok(isBlockedUrl("ftp://example.com"));
});

test("rejects malformed urls", () => {
  assert.ok(isBlockedUrl("not a url"));
});

// ── rate limiter ──
test("allows up to max, then blocks", () => {
  const limit = makeLimiter({ windowMs: 1000, max: 3 });
  const results = [1, 2, 3, 4, 5].map(() => limit("1.2.3.4"));
  assert.deepStrictEqual(results, [true, true, true, false, false]);
});

test("limits are per-IP", () => {
  const limit = makeLimiter({ windowMs: 1000, max: 2 });
  limit("a"); limit("a");
  assert.strictEqual(limit("a"), false, "IP a exhausted");
  assert.strictEqual(limit("b"), true, "IP b independent");
});

test("window expiry frees the limit", async () => {
  const limit = makeLimiter({ windowMs: 40, max: 1 });
  assert.strictEqual(limit("x"), true);
  assert.strictEqual(limit("x"), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(limit("x"), true, "freed after window");
});

// ── async report (for the timing test) ──
setTimeout(() => {
  console.log(`\nproxy.test.mjs: ${passed} passed, ${failed} failed`);
  for (const [n, m] of failures) console.log(`  ✗ ${n}: ${m}`);
  process.exit(failed === 0 ? 0 : 1);
}, 120);
