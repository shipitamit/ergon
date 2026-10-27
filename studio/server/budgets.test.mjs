/* Budgets & quotas against the real SQLite data layer (node:sqlite fallback,
   zero deps). Covers setting caps (owner/admin), status computed from recorded
   runs, the checkBudget gate, enforcement at run admission (402-tagged), RBAC,
   and delete. Run: node server/budgets.test.mjs  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-budgets-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
db.addMember(team.id, alice.id, (db.createUser("carol@x.com", "password1"), "carol@x.com"), "member");
const carol = db.verifyUser("carol@x.com", "password1");

test("owner sets a spend cap and a request quota; a member cannot", () => {
  const b = db.setBudget(team.id, alice.id, { period: "total", maxCost: 1.0, maxRequests: 3 });
  assert.ok(b.some((x) => x.period === "total" && x.maxCost === 1.0 && x.maxRequests === 3));
  assert.throws(() => db.setBudget(team.id, carol.id, { period: "day", maxCost: 1 }), /owner or admin/);
  assert.throws(() => db.setBudget(team.id, alice.id, { period: "year", maxCost: 1 }), /period must be/);
  assert.throws(() => db.setBudget(team.id, alice.id, { period: "day" }), /at least one/);
});

test("setting the same period again updates in place (one row per period)", () => {
  db.setBudget(team.id, alice.id, { period: "total", maxCost: 5.0, maxRequests: 3 });
  const list = db.listBudgets(team.id, alice.id).filter((b) => b.period === "total");
  assert.equal(list.length, 1);
  assert.equal(list[0].maxCost, 5.0);
});

test("status reflects recorded run spend + request count; gate stays open under cap", () => {
  db.recordRun(alice.id, { orgId: team.id, input: "a", usage: { cost: 0.4 } });
  db.recordRun(alice.id, { orgId: team.id, input: "b", usage: { cost: 0.3 } });
  const st = db.budgetStatus(team.id, alice.id).find((b) => b.period === "total");
  assert.ok(Math.abs(st.spend - 0.7) < 1e-9);
  assert.equal(st.requests, 2);
  assert.equal(st.costExceeded, false);
  assert.equal(db.checkBudget(team.id).allowed, true);   // 0.7 < 5.0 and 2 < 3
});

test("hitting the request quota closes the gate and refuses the next run (402-tagged)", () => {
  db.recordRun(alice.id, { orgId: team.id, input: "c" });   // now 3 requests == quota
  const gate = db.checkBudget(team.id);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /request quota/);
  let err;
  try { db.recordRun(alice.id, { orgId: team.id, input: "d" }); } catch (e) { err = e; }
  assert.ok(err && err.code === "budget");
});

test("a spend cap also closes the gate", () => {
  const solo = db.createOrg(alice.id, "Solo");
  db.setBudget(solo.id, alice.id, { period: "total", maxCost: 0.5 });
  db.recordRun(alice.id, { orgId: solo.id, input: "x", usage: { cost: 0.6 } });
  const gate = db.checkBudget(solo.id);
  assert.equal(gate.allowed, false);
  assert.match(gate.reason, /spend cap/);
});

test("members can read status but not list/manage; delete reopens the gate", () => {
  assert.ok(Array.isArray(db.budgetStatus(team.id, carol.id)));   // member read ok
  assert.throws(() => db.listBudgets(team.id, carol.id), /owner or admin/);
  const bud = db.listBudgets(team.id, alice.id).find((b) => b.period === "total");
  db.deleteBudget(team.id, alice.id, bud.id);
  assert.equal(db.checkBudget(team.id).allowed, true);            // no budget → open
});

console.log(`\nbudgets.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
