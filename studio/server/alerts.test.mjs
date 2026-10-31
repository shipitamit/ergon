/* Alerting: rule CRUD + RBAC against the real SQLite layer, and the evaluator
   state machine (ok→firing emits 'firing', firing→ok emits 'resolved', steady
   state emits nothing; disabled rules are skipped).
   Run: node server/alerts.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-alerts-")), "t.db");
const db = await import("./db.mjs");
const { evaluateAlerts, metricValue } = await import("./alerts.mjs");

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }
const DAY = 86400_000;

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
const carol = db.createUser("carol@x.com", "password1");
db.addMember(team.id, alice.id, "carol@x.com", "member");
const h1 = db.saveHarness(alice.id, { id: null, name: "A", graph: { nodes: [], edges: [] }, orgId: team.id });

await test("create validates metric, comparator, threshold, window", () => {
  assert.throws(() => db.createAlertRule(team.id, alice.id, { name: "x", metric: "nope", comparator: ">", threshold: 1, windowMs: DAY }), /metric must be/);
  assert.throws(() => db.createAlertRule(team.id, alice.id, { name: "x", metric: "spend", comparator: "~", threshold: 1, windowMs: DAY }), /comparator/);
  assert.throws(() => db.createAlertRule(team.id, alice.id, { name: "x", metric: "spend", comparator: ">", threshold: 1, windowMs: 0 }), /windowMs/);
});

await test("owner creates; member can read but not create; outsider is refused", () => {
  const rule = db.createAlertRule(team.id, alice.id, { name: "spend cap", metric: "spend", comparator: ">", threshold: 1.0, windowMs: DAY });
  assert.ok(rule.id && rule.enabled && rule.lastState === "ok");
  assert.equal(db.listAlertRules(team.id, carol.id).length, 1);          // member reads
  assert.throws(() => db.createAlertRule(team.id, carol.id, { name: "y", metric: "spend", comparator: ">", threshold: 1, windowMs: DAY }), /owner or admin/);
  const bob = db.createUser("bob@x.com", "password1");
  assert.throws(() => db.listAlertRules(team.id, bob.id), /Not a member/);
});

await test("metricValue maps each metric", () => {
  const agg = { runs: 7, errors: 2, errorRate: 2 / 7, spend: 3.5, latencyP95: 900 };
  assert.equal(metricValue("run_count", agg), 7);
  assert.ok(Math.abs(metricValue("error_rate", agg) - 2 / 7) < 1e-9);
  assert.equal(metricValue("spend", agg), 3.5);
  assert.equal(metricValue("latency_p95", agg), 900);
});

await test("evaluator: ok→firing emits one 'firing' event, steady state emits none", async () => {
  // fresh org so the spend rule from above doesn't interfere
  const org = db.createOrg(alice.id, "Ops");
  const h = db.saveHarness(alice.id, { id: null, name: "Ops bot", graph: { nodes: [], edges: [] }, orgId: org.id });
  db.createAlertRule(org.id, alice.id, { name: "too many errors", metric: "error_rate", comparator: ">", threshold: 0.5, windowMs: DAY });
  db.recordRun(alice.id, { harnessId: h.id, orgId: org.id, status: "ok" });
  db.recordRun(alice.id, { harnessId: h.id, orgId: org.id, status: "error" });
  db.recordRun(alice.id, { harnessId: h.id, orgId: org.id, status: "error" });  // 2/3 ≈ 0.67 > 0.5

  const t1 = await evaluateAlerts(db);
  const mine = t1.filter((x) => x.orgId === org.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, "firing");
  let events = db.listAlertEvents(org.id, alice.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].state, "firing");

  // steady breach → no new event
  const t2 = await evaluateAlerts(db);
  assert.equal(t2.filter((x) => x.orgId === org.id).length, 0);
  assert.equal(db.listAlertEvents(org.id, alice.id).length, 1);

  // push error rate below threshold → resolved
  for (let i = 0; i < 5; i++) db.recordRun(alice.id, { harnessId: h.id, orgId: org.id, status: "ok" });
  const t3 = await evaluateAlerts(db);
  const resolved = t3.filter((x) => x.orgId === org.id);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].state, "resolved");
  events = db.listAlertEvents(org.id, alice.id);
  assert.equal(events.length, 2);
  assert.equal(events[0].state, "resolved");   // newest-first
});

await test("evaluator: a disabled rule is never evaluated", async () => {
  const org = db.createOrg(alice.id, "Quiet");
  const h = db.saveHarness(alice.id, { id: null, name: "q", graph: { nodes: [], edges: [] }, orgId: org.id });
  const rule = db.createAlertRule(org.id, alice.id, { name: "spend", metric: "spend", comparator: ">", threshold: 0.0, windowMs: DAY });
  db.updateAlertRule(alice.id, rule.id, { enabled: false });
  db.recordRun(alice.id, { harnessId: h.id, orgId: org.id, status: "ok", usage: { cost: 5 } });
  await evaluateAlerts(db);
  assert.equal(db.listAlertEvents(org.id, alice.id).length, 0);
});

await test("spend rule fires when windowed spend crosses the threshold", async () => {
  const org = db.createOrg(alice.id, "Spend");
  const h = db.saveHarness(alice.id, { id: null, name: "s", graph: { nodes: [], edges: [] }, orgId: org.id });
  db.createAlertRule(org.id, alice.id, { name: "budget", metric: "spend", comparator: ">", threshold: 1.0, windowMs: DAY });
  db.recordRun(alice.id, { harnessId: h.id, orgId: org.id, status: "ok", usage: { cost: 0.6 } });
  db.recordRun(alice.id, { harnessId: h.id, orgId: org.id, status: "ok", usage: { cost: 0.6 } });  // 1.2 > 1.0
  const t = await evaluateAlerts(db);
  const mine = t.filter((x) => x.orgId === org.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, "firing");
  assert.ok(Math.abs(mine[0].value - 1.2) < 1e-6);
});

await test("update changes threshold; delete removes the rule", () => {
  const org = db.createOrg(alice.id, "Edit");
  const rule = db.createAlertRule(org.id, alice.id, { name: "r", metric: "run_count", comparator: ">", threshold: 10, windowMs: DAY });
  const up = db.updateAlertRule(alice.id, rule.id, { threshold: 99 });
  assert.equal(up.threshold, 99);
  db.deleteAlertRule(alice.id, rule.id);
  assert.equal(db.listAlertRules(org.id, alice.id).length, 0);
});

console.log(`\nalerts.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
