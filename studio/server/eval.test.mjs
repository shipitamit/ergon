/* Eval at scale: dataset CRUD + RBAC, recording scored runs, listing/compare,
   against the real SQLite store. Run: node server/eval.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-eval-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
const carol = db.createUser("carol@x.com", "password1");
db.addMember(team.id, alice.id, "carol@x.com", "member");

const CASES = [
  { input: "2+2", expected: "4", scorer: { type: "contains" } },
  { input: "cap of france", expected: "paris", scorer: { type: "contains" } },
];

test("owner creates a dataset; member reads but can't mutate; non-member refused", () => {
  const ds = db.createEvalDataset(team.id, alice.id, { name: "smoke", cases: CASES });
  assert.equal(ds.caseCount, 2);
  assert.equal(db.listEvalDatasets(team.id, carol.id).length, 1);          // member reads
  assert.throws(() => db.createEvalDataset(team.id, carol.id, { name: "x" }), /owner or admin/);
  const bob = db.createUser("bob@x.com", "password1");
  assert.throws(() => db.listEvalDatasets(team.id, bob.id), /Not a member/);
});

test("update cases + get round-trips; delete removes", () => {
  const ds = db.createEvalDataset(team.id, alice.id, { name: "edit", cases: [] });
  const up = db.updateEvalDataset(alice.id, ds.id, { cases: CASES, name: "edited" });
  assert.equal(up.name, "edited");
  assert.equal(db.getEvalDataset(alice.id, ds.id).cases.length, 2);
  db.deleteEvalDataset(alice.id, ds.id);
  assert.throws(() => db.getEvalDataset(alice.id, ds.id), /not found/i);
});

test("recordEvalRun scores server-side and aggregates", () => {
  const ds = db.createEvalDataset(team.id, alice.id, { name: "run-me", cases: CASES });
  const run = db.recordEvalRun(team.id, alice.id, { datasetId: ds.id, label: "v1", cases: [
    { input: "2+2", output: "the answer is 4", expected: "4", scorer: { type: "contains" } },   // pass
    { input: "cap of france", output: "I think London", expected: "paris", scorer: { type: "contains" } },  // fail
  ]});
  assert.equal(run.total, 2);
  assert.equal(run.passed, 1);
  assert.ok(Math.abs(run.passRate - 0.5) < 1e-9);
  assert.equal(run.results[0].passed, true);
  assert.equal(run.results[1].passed, false);
  // a member may record a run
  assert.doesNotThrow(() => db.recordEvalRun(team.id, carol.id, { cases: CASES.map((c) => ({ ...c, output: c.expected })) }));
});

test("list runs newest-first, filter by dataset; get returns per-case results", () => {
  const ds = db.createEvalDataset(team.id, alice.id, { name: "trend", cases: CASES });
  const r1 = db.recordEvalRun(team.id, alice.id, { datasetId: ds.id, cases: [{ input: "a", output: "x", expected: "x", scorer: { type: "contains" } }] });
  const runs = db.listEvalRuns(team.id, alice.id, { datasetId: ds.id });
  assert.ok(runs.length >= 1 && runs[0].id === r1.id);
  assert.ok(Array.isArray(db.getEvalRun(alice.id, r1.id).results));
});

test("compare surfaces regressions and fixes by case input", () => {
  const ds = db.createEvalDataset(team.id, alice.id, { name: "cmp", cases: CASES });
  const a = db.recordEvalRun(team.id, alice.id, { datasetId: ds.id, cases: [
    { input: "keep", output: "good", expected: "good", scorer: { type: "contains" } },     // pass in both
    { input: "fixme", output: "bad", expected: "good", scorer: { type: "contains" } },      // fail → fixed
    { input: "breakme", output: "good", expected: "good", scorer: { type: "contains" } },   // pass → regress
  ]});
  const b = db.recordEvalRun(team.id, alice.id, { datasetId: ds.id, cases: [
    { input: "keep", output: "good", expected: "good", scorer: { type: "contains" } },
    { input: "fixme", output: "good now", expected: "good", scorer: { type: "contains" } }, // now pass
    { input: "breakme", output: "oops", expected: "good", scorer: { type: "contains" } },   // now fail
  ]});
  const cmp = db.compareEvalRuns(alice.id, a.id, b.id);
  assert.equal(cmp.fixes.length, 1);
  assert.equal(cmp.fixes[0].input, "fixme");
  assert.equal(cmp.regressions.length, 1);
  assert.equal(cmp.regressions[0].input, "breakme");
  assert.equal(cmp.changedCount, 2);
});

console.log(`\neval.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
