/* Eval scorers: each type + the dataset aggregate. Run: node server/eval-score.test.mjs */
import assert from "node:assert";
import { scoreCase, scoreDataset } from "./eval-score.mjs";

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

test("exact (normalized)", () => {
  assert.equal(scoreCase("  Hello World ", "hello world", { type: "exact" }).passed, true);
  assert.equal(scoreCase("hello", "world", { type: "exact" }).passed, false);
  assert.equal(scoreCase("Hello", "hello", { type: "exact", normalize: false }).passed, false);
});

test("contains (case-insensitive default)", () => {
  assert.equal(scoreCase("the Answer is 42", "answer", { type: "contains" }).passed, true);
  assert.equal(scoreCase("nope", "answer", { type: "contains" }).passed, false);
  assert.equal(scoreCase("Answer", "answer", { type: "contains", caseSensitive: true }).passed, false);
});

test("not_contains (list)", () => {
  assert.equal(scoreCase("safe output", ["secret", "password"], { type: "not_contains" }).passed, true);
  assert.equal(scoreCase("the password is x", ["secret", "password"], { type: "not_contains" }).passed, false);
});

test("regex", () => {
  assert.equal(scoreCase("order #1234", "#\\d+", { type: "regex" }).passed, true);
  assert.equal(scoreCase("no number", "#\\d+", { type: "regex" }).passed, false);
  assert.equal(scoreCase("bad", "(", { type: "regex" }).passed, false);  // bad pattern → fail, no throw
});

test("numeric with tolerance", () => {
  assert.equal(scoreCase("the total is 100.0", 100, { type: "numeric", tolerance: 0.5 }).passed, true);
  assert.equal(scoreCase("99", 100, { type: "numeric", tolerance: 0.5 }).passed, false);
  assert.equal(scoreCase("102", 100, { type: "numeric", tolerance: 0.05, relative: true }).passed, true);  // 2% within 5%
  assert.equal(scoreCase("no digits", 100, { type: "numeric" }).passed, false);
});

test("json_valid + required keys", () => {
  assert.equal(scoreCase('{"a":1,"b":2}', null, { type: "json_valid" }).passed, true);
  assert.equal(scoreCase("not json", null, { type: "json_valid" }).passed, false);
  assert.equal(scoreCase('{"a":1}', null, { type: "json_valid", requiredKeys: ["a", "b"] }).passed, false);
  assert.equal(scoreCase('{"a":1,"b":2}', null, { type: "json_valid", requiredKeys: ["a", "b"] }).passed, true);
});

test("unknown scorer type fails gracefully", () => {
  assert.equal(scoreCase("x", "y", { type: "mystery" }).passed, false);
});

test("scoreDataset aggregates pass rate + score avg", () => {
  const cases = [
    { input: "q1", output: "answer", expected: "answer", scorer: { type: "contains" } },   // pass
    { input: "q2", output: "nope", expected: "answer", scorer: { type: "contains" } },      // fail
    { input: "q3", output: "42", expected: 42, scorer: { type: "numeric" } },               // pass
  ];
  const r = scoreDataset(cases);
  assert.equal(r.total, 3);
  assert.equal(r.passed, 2);
  assert.ok(Math.abs(r.passRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(r.scoreAvg - 2 / 3) < 1e-9);
  assert.equal(r.results[1].passed, false);
});

console.log(`\neval-score.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
