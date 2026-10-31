/* Trace search over the real SQLite runs store: text query across input+output,
   status / failures, latency & cost floors, the time window, limit, and RBAC.
   created_at is now(); one run is backdated through a second connection to test
   the window. Run: node server/search.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-search-")), "t.db");
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
const h1 = db.saveHarness(alice.id, { id: null, name: "A", graph: { nodes: [], edges: [] }, orgId: team.id });
const h2 = db.saveHarness(alice.id, { id: null, name: "B", graph: { nodes: [], edges: [] }, orgId: team.id });

const rec = (hid, status, input, output, latencyMs, cost) => db.recordRun(alice.id, {
  harnessId: hid, orgId: team.id, status, input, output, latencyMs,
  usage: { cost },
}).id;

rec(h1.id, "ok", "deploy the pipeline", "done", 100, 0.01);
rec(h1.id, "error", "reset password flow", "boom", 2000, 0);
rec(h2.id, "ok", "summarize the report", "pipeline summary", 500, 0.05);
const r4 = rec(h2.id, "ok", "translate text", "ok", 50, 0.2);

test("text query matches input or output, case-insensitively", () => {
  const hits = db.searchRuns(alice.id, { orgId: team.id, q: "PIPELINE" });
  assert.equal(hits.length, 2);   // r1 (input) + r3 (output)
});

test("failed filter returns only non-ok runs", () => {
  const hits = db.searchRuns(alice.id, { orgId: team.id, failed: true });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].status, "error");
});

test("exact status filter", () => {
  assert.equal(db.searchRuns(alice.id, { orgId: team.id, status: "error" }).length, 1);
  assert.equal(db.searchRuns(alice.id, { orgId: team.id, status: "ok" }).length, 3);
});

test("harness filter scopes results", () => {
  assert.equal(db.searchRuns(alice.id, { orgId: team.id, harnessId: h1.id }).length, 2);
});

test("latency and cost floors", () => {
  assert.equal(db.searchRuns(alice.id, { orgId: team.id, minLatencyMs: 500 }).length, 2);  // 2000, 500
  assert.equal(db.searchRuns(alice.id, { orgId: team.id, minCost: 0.1 }).length, 1);         // 0.2
});

test("limit caps the result set, newest-first", () => {
  const hits = db.searchRuns(alice.id, { orgId: team.id, limit: 1 });
  assert.equal(hits.length, 1);
});

// backdate r4 by 3 days to test the window
const raw = await openRaw();
raw.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(Date.now() - 3 * DAY, r4);
raw.close?.();

test("from window excludes older runs", () => {
  const hits = db.searchRuns(alice.id, { orgId: team.id, from: Date.now() - 2 * DAY });
  assert.equal(hits.length, 3);   // r4 is 3 days old → excluded
});

test("access is org-scoped", () => {
  const bob = db.createUser("bob@x.com", "password1");
  assert.throws(() => db.searchRuns(bob.id, { orgId: team.id }), /Not a member/);
});

test("orgId is required", () => {
  assert.throws(() => db.searchRuns(alice.id, {}), /orgId is required/);
});

console.log(`\nsearch.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
