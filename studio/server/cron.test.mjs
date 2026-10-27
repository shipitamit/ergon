/* Pure cron parser/scheduler. Run: node server/cron.test.mjs */
import assert from "node:assert";
import { parseCron, isValidCron, cronMatches, nextFireAfter } from "./cron.mjs";

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const at = (iso) => new Date(iso + "Z");   // treat as UTC

test("parseCron rejects the wrong number of fields", () => {
  assert.throws(() => parseCron("* * * *"));
  assert.throws(() => parseCron("* * * * * *"));
  assert.ok(parseCron("* * * * *"));
});

test("isValidCron: steps, ranges, lists, and junk", () => {
  assert.ok(isValidCron("*/5 * * * *"));
  assert.ok(isValidCron("0 9-17 * * 1-5"));
  assert.ok(isValidCron("0,30 0 1 1 0"));
  assert.ok(!isValidCron("60 * * * *"));   // minute out of range
  assert.ok(!isValidCron("* 24 * * *"));   // hour out of range
  assert.ok(!isValidCron("* * * * 9"));    // weekday out of range
  assert.ok(!isValidCron("hello"));
});

test("cronMatches: every 5 minutes", () => {
  assert.ok(cronMatches("*/5 * * * *", at("2026-10-25T10:05:00")));
  assert.ok(!cronMatches("*/5 * * * *", at("2026-10-25T10:06:00")));
});

test("cronMatches: weekdays 9am (Oct 25 2026 is a Sunday)", () => {
  assert.ok(!cronMatches("0 9 * * 1-5", at("2026-10-25T09:00:00")), "Sunday excluded");
  assert.ok(cronMatches("0 9 * * 1-5", at("2026-10-26T09:00:00")), "Monday included");
  assert.ok(!cronMatches("0 9 * * 1-5", at("2026-10-26T09:01:00")), "wrong minute");
});

test("cronMatches: dom OR dow when both are restricted", () => {
  // the 1st OR a Monday
  assert.ok(cronMatches("0 0 1 * 1", at("2026-10-01T00:00:00")), "1st matches via dom");
  assert.ok(cronMatches("0 0 1 * 1", at("2026-10-26T00:00:00")), "Monday matches via dow");
  assert.ok(!cronMatches("0 0 1 * 1", at("2026-10-27T00:00:00")), "neither");
});

test("nextFireAfter: next whole hour", () => {
  const next = nextFireAfter("0 * * * *", at("2026-10-25T10:12:30").getTime());
  assert.equal(new Date(next).toISOString(), "2026-10-25T11:00:00.000Z");
});

test("nextFireAfter: skips to the next weekday 9am from a Sunday", () => {
  const next = nextFireAfter("0 9 * * 1-5", at("2026-10-25T12:00:00").getTime());
  assert.equal(new Date(next).toISOString(), "2026-10-26T09:00:00.000Z");
});

test("nextFireAfter is strictly after the given instant", () => {
  const base = at("2026-10-25T10:05:00").getTime();
  const next = nextFireAfter("*/5 * * * *", base);
  assert.ok(next > base, "strictly after");
  assert.equal(new Date(next).toISOString(), "2026-10-25T10:10:00.000Z");
});

test("nextFireAfter returns null for an impossible date", () => {
  assert.equal(nextFireAfter("0 0 31 2 *", at("2026-01-01T00:00:00").getTime()), null);
});

console.log(`\ncron.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
