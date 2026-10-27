/* Sealed-secret crypto. Run: node server/cryptobox.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// pin a secret + a throwaway keyfile location so the test is hermetic
process.env.ERGON_SETTINGS_SECRET = "test-secret-key-material";
process.env.ERGON_SETTINGS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-box-")), "s.json");
const { seal, open, last4 } = await import("./cryptobox.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

test("round-trips a secret", () => {
  const s = seal("xoxb-abc-123-secret");
  assert.ok(s.startsWith("v1:"), "tagged format");
  assert.notEqual(s, "xoxb-abc-123-secret", "not plaintext");
  assert.equal(open(s), "xoxb-abc-123-secret");
});

test("empty / null seal to null", () => {
  assert.equal(seal(""), null);
  assert.equal(seal(null), null);
});

test("tampered ciphertext fails closed (null, no throw)", () => {
  const s = seal("super-secret");
  const bad = s.slice(0, -2) + (s.endsWith("aa") ? "bb" : "aa");
  assert.equal(open(bad), null);
});

test("malformed input returns null", () => {
  assert.equal(open("not-sealed"), null);
  assert.equal(open(""), null);
  assert.equal(open(null), null);
  assert.equal(open("v1:only:two"), null);
});

test("each seal uses a fresh IV (ciphertexts differ)", () => {
  assert.notEqual(seal("same"), seal("same"));
});

test("last4 masks", () => {
  assert.equal(last4("xoxb-123456"), "3456");
  assert.equal(last4("ab"), "ab");
  assert.equal(last4(""), "");
});

console.log(`\ncryptobox.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
