/* Observability: metricsSummary aggregates over the real SQLite runs store —
   totals (incl. latency percentiles computed in JS), the time-bucketed series,
   the by-harness breakdown, the from/to range filter, the harness filter, and
   RBAC. created_at is always now(), so a couple of runs are backdated through a
   second connection to exercise multi-bucket series + range exclusion.
   Run: node server/metrics.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-metrics-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const DAY = 86400_000;

async function openRaw() {
  try { const { default: D } = await import("better-sqlite3"); return new D(process.env.ERGON_DB); }
  catch { const { DatabaseSync } = await import("node:sqlite"); return new DatabaseSync(process.env.ERGON_DB); }
}

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
const h1 = db.saveHarness(alice.id, { id: null, name: "Bot A", graph: { nodes: [], edges: [] }, orgId: team.id });
const h2 = db.saveHarness(alice.id, { id: null, name: "Bot B", graph: { nodes: [], edges: [] }, orgId: team.id });

const run = (hid, status, latencyMs, cost) => db.recordRun(alice.id, {
  harnessId: hid, orgId: team.id, status, latencyMs,
  usage: { input_tokens: 10, output_tokens: 5, cost },
}).id;

// h1: 3 ok + 1 error; h2: 2 ok
run(h1.id, "ok", 100, 0.01);
run(h1.id, "ok", 200, 0.02);
run(h1.id, "ok", 300, 0.03);
run(h1.id, "error", 50, 0);
const b1 = run(h2.id, "ok", 400, 0.04);
const b2 = run(h2.id, "ok", 500, 0.05);

test("totals: counts, success rate, tokens, cost, latency percentiles", () => {
  const m = db.metricsSummary(alice.id, { orgId: team.id });
  assert.equal(m.totals.runs, 6);
  assert.equal(m.totals.errors, 1);
  assert.ok(Math.abs(m.totals.successRate - 5 / 6) < 1e-9);
  assert.equal(m.totals.tokensIn, 60);
  assert.equal(m.totals.tokensOut, 30);
  assert.ok(Math.abs(m.totals.cost - 0.15) < 1e-9);
  // sorted latencies [50,100,200,300,400,500]: nearest-rank p50=200, p95=500
  assert.equal(m.totals.latencyP50, 200);
  assert.equal(m.totals.latencyP95, 500);
  assert.equal(m.totals.latencyAvg, 258);   // 1550/6 rounded
});

test("by-harness breakdown, ordered by run count", () => {
  const m = db.metricsSummary(alice.id, { orgId: team.id });
  assert.equal(m.byHarness.length, 2);
  assert.equal(m.byHarness[0].harnessId, h1.id);
  assert.equal(m.byHarness[0].runs, 4);
  assert.equal(m.byHarness[0].errors, 1);
  assert.ok(Math.abs(m.byHarness[0].cost - 0.06) < 1e-9);
  const b = m.byHarness.find((x) => x.harnessId === h2.id);
  assert.equal(b.runs, 2);
  assert.ok(Math.abs(b.cost - 0.09) < 1e-9);
});

test("series groups into one day bucket when all runs are 'now'", () => {
  const m = db.metricsSummary(alice.id, { orgId: team.id, bucket: "day" });
  assert.equal(m.series.length, 1);
  assert.equal(m.series[0].runs, 6);
  assert.equal(m.series[0].errors, 1);
  // bucket start is aligned to a day boundary
  assert.equal(m.series[0].t % DAY, 0);
});

test("harness filter scopes totals to one harness", () => {
  const m = db.metricsSummary(alice.id, { orgId: team.id, harnessId: h1.id });
  assert.equal(m.totals.runs, 4);
  assert.equal(m.totals.errors, 1);
  assert.equal(m.byHarness.length, 1);
});

// backdate the two h2 runs by 3 days, through a second connection
const raw = await openRaw();
const threeDaysAgo = Date.now() - 3 * DAY;
raw.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(threeDaysAgo, b1);
raw.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(threeDaysAgo, b2);
raw.close?.();

test("series spans multiple day buckets once runs are spread over time", () => {
  const m = db.metricsSummary(alice.id, { orgId: team.id, bucket: "day" });
  assert.equal(m.series.length, 2, "today + three-days-ago");
  assert.equal(m.series.reduce((s, x) => s + x.runs, 0), 6);
  // chronological order
  assert.ok(m.series[0].t < m.series[1].t);
});

test("from/to range filter excludes out-of-window runs", () => {
  const m = db.metricsSummary(alice.id, { orgId: team.id, from: Date.now() - 2 * DAY });
  assert.equal(m.totals.runs, 4, "the two 3-day-old runs fall outside a 2-day window");
  assert.equal(m.totals.cost.toFixed(2), "0.06");
});

test("access is org-scoped: a non-member is refused", () => {
  const bob = db.createUser("bob@x.com", "password1");
  assert.throws(() => db.metricsSummary(bob.id, { orgId: team.id }), /Not a member/);
});

test("orgId is required", () => {
  assert.throws(() => db.metricsSummary(alice.id, {}), /orgId is required/);
});

console.log(`\nmetrics.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
