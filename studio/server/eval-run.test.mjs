/* Run-in-UI: execute a dataset against a deployment (fake forward) and record a
   scored run. Run: node server/eval-run.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-evalrun-")), "t.db");
const db = await import("./db.mjs");
const { runDataset } = await import("./eval-run.mjs");

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
const h = db.saveHarness(alice.id, { id: null, name: "QA bot", graph: { nodes: [], edges: [] }, orgId: team.id });

const CASES = [
  { input: "2+2", expected: "4", scorer: { type: "contains" } },
  { input: "cap of france", expected: "paris", scorer: { type: "contains" } },
];

await test("runs each case through the deployment's forward and records a scored run", async () => {
  const ds = db.createEvalDataset(team.id, alice.id, { name: "qa", harnessId: h.id, cases: CASES });
  db.createDeployment(team.id, alice.id, { slug: "qa-dep", harnessId: h.id, targetUrl: "https://runner.example" });
  const seen = [];
  const forward = async (urlArg, { input }) => {
    seen.push({ urlArg, input });
    return { kind: "ok", body: { text: input === "2+2" ? "the answer is 4" : "I think London" } };
  };
  const run = await runDataset(db, { orgId: team.id, userId: alice.id, datasetId: ds.id }, { forward });
  assert.equal(run.total, 2);
  assert.equal(run.passed, 1);                 // 2+2 passes, france fails
  assert.equal(run.results[0].passed, true);
  assert.equal(run.results[1].passed, false);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].urlArg, "https://runner.example");
});

await test("fails clearly when the harness has no active deployment", async () => {
  const h2 = db.saveHarness(alice.id, { id: null, name: "undeployed", graph: { nodes: [], edges: [] }, orgId: team.id });
  const ds = db.createEvalDataset(team.id, alice.id, { name: "nodep", harnessId: h2.id, cases: CASES });
  await assert.rejects(runDataset(db, { orgId: team.id, userId: alice.id, datasetId: ds.id }, { forward: async () => ({ kind: "ok", body: { text: "" } }) }), /No active deployment/);
});

await test("a forward error scores as an empty output, not a crash", async () => {
  const ds = db.createEvalDataset(team.id, alice.id, { name: "flaky", harnessId: h.id, cases: [CASES[0]] });
  db.createDeployment(team.id, alice.id, { slug: "flaky-dep", harnessId: h.id, targetUrl: "https://runner2.example" });
  const run = await runDataset(db, { orgId: team.id, userId: alice.id, datasetId: ds.id, harnessId: h.id }, { forward: async () => { throw new Error("runner down"); } });
  assert.equal(run.total, 1);
  assert.equal(run.passed, 0);                 // empty output fails "contains 4"
});

console.log(`\neval-run.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
