/* Version history against the real SQLite data layer (node:sqlite fallback,
   zero deps). Covers: a version is recorded on create and on each save, the
   timeline is newest-first, a version's full graph round-trips, access is
   org-scoped, and the per-harness history is capped. Run:
   node server/versions.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-ver-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const u = db.createUser("ver@x.com", "password1");
const g1 = { nodes: [{ id: "a", type: "input", config: {} }], edges: [] };
const h = db.saveHarness(u.id, { name: "H", graph: g1 });

test("creating a harness records the first version", () => {
  const vs = db.listVersions(h.id, u.id);
  assert.equal(vs.length, 1);
  assert.equal(vs[0].nodeCount, 1);
  assert.equal(vs[0].authorEmail, "ver@x.com");
});

test("each save appends a version, newest first", () => {
  db.saveHarness(u.id, { id: h.id, name: "H", graph: { nodes: [...g1.nodes, { id: "b", type: "agent", config: { name: "x" } }], edges: [] } });
  const vs = db.listVersions(h.id, u.id);
  assert.equal(vs.length, 2);
  assert.ok(vs[0].version > vs[1].version, "newest first");
  assert.equal(vs[0].nodeCount, 2);
});

test("getVersion returns that version's full graph", () => {
  const vs = db.listVersions(h.id, u.id);
  const oldest = db.getVersion(h.id, vs[1].id, u.id);   // the create snapshot
  assert.equal(oldest.graph.nodes.length, 1);
  const newest = db.getVersion(h.id, vs[0].id, u.id);
  assert.equal(newest.graph.nodes.length, 2);
});

test("history is access-scoped: an outsider cannot list or fetch", () => {
  const other = db.createUser("out@x.com", "password1");
  assert.throws(() => db.listVersions(h.id, other.id));
  const vs = db.listVersions(h.id, u.id);
  assert.throws(() => db.getVersion(h.id, vs[0].id, other.id));
});

test("the per-harness history is capped (≤ 50)", () => {
  for (let i = 0; i < 55; i++) db.saveHarness(u.id, { id: h.id, name: "H", graph: { nodes: [{ id: "a", type: "input", config: { n: i } }], edges: [] } });
  const vs = db.listVersions(h.id, u.id);
  assert.equal(vs.length, 50);
  assert.ok(vs[0].version > vs[49].version, "still ordered newest-first after prune");
});

console.log(`\nversions.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
