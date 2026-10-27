/* Run history against the real SQLite data layer (node:sqlite fallback, zero
   deps). Covers recording (org derived from the harness or passed directly),
   org-scoped listing + detail, RBAC, the harness filter, and retention.
   Run: node server/runs.test.mjs  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_RUNS_KEEP = "3";   // small cap so retention is observable
process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-runs-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
const h = db.saveHarness(alice.id, { id: null, name: "Bot", graph: { nodes: [], edges: [] }, orgId: team.id });

test("record derives the org from the harness and stores the record", () => {
  const { id, orgId } = db.recordRun(alice.id, {
    harnessId: h.id, harnessName: "Bot", input: "where is order 1?", output: "shipped",
    status: "ok", startedAt: 1000, finishedAt: 1200, latencyMs: 200,
    usage: { input_tokens: 10, output_tokens: 4, cost: 0.002 },
    steps: [{ kind: "node_start", node: "solver" }, { kind: "tool_result", node: "solver", detail: { name: "lookup" } }],
  });
  assert.equal(orgId, team.id);
  const full = db.getRun(alice.id, id);
  assert.equal(full.output, "shipped");
  assert.equal(full.tokensIn, 10);
  assert.equal(full.latencyMs, 200);
  assert.equal(full.steps.length, 2);
  assert.equal(full.inputPreview, "where is order 1?");
});

test("list is org-scoped, newest-first, and can filter by harness", () => {
  db.recordRun(alice.id, { orgId: team.id, input: "second" });
  const all = db.listRuns(alice.id, { orgId: team.id });
  assert.ok(all.length >= 2);
  assert.ok(all[0].createdAt >= all[1].createdAt);   // newest first
  const forH = db.listRuns(alice.id, { orgId: team.id, harnessId: h.id });
  assert.ok(forH.every((r) => r.harnessId === h.id));
});

test("a non-member cannot record, list, or read", () => {
  const bob = db.createUser("bob@x.com", "password1");
  assert.throws(() => db.recordRun(bob.id, { orgId: team.id, input: "x" }), /Not a member/);
  assert.throws(() => db.listRuns(bob.id, { orgId: team.id }), /Not a member/);
  const anyRun = db.listRuns(alice.id, { orgId: team.id })[0];
  assert.throws(() => db.getRun(bob.id, anyRun.id), /Not a member/);
});

test("recording without a harness or org is refused", () => {
  assert.throws(() => db.recordRun(alice.id, { input: "orphan" }), /harnessId or orgId/);
});

test("retention keeps only the newest ERGON_RUNS_KEEP per org", () => {
  const solo = db.createOrg(alice.id, "Solo");
  for (let i = 0; i < 6; i++) db.recordRun(alice.id, { orgId: solo.id, input: `run ${i}` });
  const kept = db.listRuns(alice.id, { orgId: solo.id, limit: 200 });
  assert.equal(kept.length, 3);                       // cap = 3
  assert.equal(kept[0].inputPreview, "run 5");        // newest survive
});

console.log(`\nruns.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
