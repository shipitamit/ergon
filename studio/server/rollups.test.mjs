/* Observability retention rollups: recordRun accumulates a durable daily
   rollup that survives run pruning, so the long-horizon trend stays correct
   even after old runs are deleted. Run: node server/rollups.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_RUNS_KEEP = "3";   // tiny cap so pruning is observable
process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-rollup-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
const h = db.saveHarness(alice.id, { id: null, name: "Bot", graph: { nodes: [], edges: [] }, orgId: team.id });

test("rollup accumulates runs / errors / cost / tokens / latency", () => {
  db.recordRun(alice.id, { harnessId: h.id, orgId: team.id, status: "ok", latencyMs: 100, usage: { input_tokens: 10, output_tokens: 5, cost: 0.01 } });
  db.recordRun(alice.id, { harnessId: h.id, orgId: team.id, status: "ok", latencyMs: 300, usage: { input_tokens: 10, output_tokens: 5, cost: 0.01 } });
  db.recordRun(alice.id, { harnessId: h.id, orgId: team.id, status: "error", latencyMs: 200, usage: { cost: 0 } });
  const series = db.metricsRollupSeries(team.id, alice.id, {});
  assert.equal(series.length, 1, "one day bucket");
  const d = series[0];
  assert.equal(d.runs, 3);
  assert.equal(d.errors, 1);
  assert.equal(d.tokensIn, 20);
  assert.equal(d.tokensOut, 10);
  assert.ok(Math.abs(d.cost - 0.02) < 1e-9);
  assert.equal(d.avgLatency, 200);   // (100+300+200)/3
  assert.equal(d.t % 86400000, 0, "day-aligned bucket");
});

test("rollup survives run pruning (the whole point)", () => {
  // keep is 3; record 5 more → runs table holds only the newest 3, but the
  // rollup must reflect all 8 runs in this org's day.
  for (let i = 0; i < 5; i++) db.recordRun(alice.id, { harnessId: h.id, orgId: team.id, status: "ok", usage: { cost: 0.01 } });
  const live = db.listRuns(alice.id, { orgId: team.id, limit: 200 }).length;
  assert.equal(live, 3, "runs table pruned to ERGON_RUNS_KEEP");
  const d = db.metricsRollupSeries(team.id, alice.id, {})[0];
  assert.equal(d.runs, 8, "rollup counted all 8 runs despite pruning");
});

test("rollup series is org-scoped", () => {
  const bob = db.createUser("bob@x.com", "password1");
  assert.throws(() => db.metricsRollupSeries(team.id, bob.id, {}), /Not a member/);
});

console.log(`\nrollups.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
