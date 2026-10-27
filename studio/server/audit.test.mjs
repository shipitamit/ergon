/* Tests for the per-org audit log (Phase 2.2), against the real SQLite data
   layer (node:sqlite fallback, zero deps). Security-relevant mutations append
   an append-only entry to their org's log; only owners/admins can read it.
   Run: node server/audit.test.mjs  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-audit-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const bob = db.createUser("bob@x.com", "password1");
const carol = db.createUser("carol@x.com", "password1");
const team = db.createOrg(alice.id, "Team");

test("createOrg records an org.create entry", () => {
  const log = db.listAudit(team.id, alice.id);
  assert.ok(log.some((e) => e.action === "org.create" && e.detail && e.detail.name === "Team"));
});

test("adding and removing members is recorded with the actor + target email", () => {
  db.addMember(team.id, alice.id, "bob@x.com", "admin");
  db.addMember(team.id, alice.id, "carol@x.com", "member");
  db.removeMember(team.id, alice.id, "carol@x.com");
  const log = db.listAudit(team.id, alice.id);
  const add = log.find((e) => e.action === "member.add" && e.detail.email === "bob@x.com");
  assert.ok(add, "member.add present");
  assert.equal(add.actorEmail, "alice@x.com");
  assert.equal(add.detail.role, "admin");
  assert.ok(log.some((e) => e.action === "member.remove" && e.detail.email === "carol@x.com"));
});

test("harness create / update / delete / move are recorded", () => {
  const h = db.saveHarness(alice.id, { id: null, name: "Bot", graph: { nodes: [], edges: [] }, orgId: team.id });
  db.saveHarness(alice.id, { id: h.id, name: "Bot v2", graph: { nodes: [], edges: [] } });
  const other = db.createOrg(alice.id, "Other");
  db.setHarnessOrg(h.id, alice.id, other.id);
  // delete back in 'other'
  db.deleteHarness(h.id, alice.id);
  const teamLog = db.listAudit(team.id, alice.id);
  assert.ok(teamLog.some((e) => e.action === "harness.create" && e.targetId === h.id));
  assert.ok(teamLog.some((e) => e.action === "harness.update" && e.targetId === h.id));
  assert.ok(teamLog.some((e) => e.action === "harness.move" && e.detail.toOrgId === other.id));
  const otherLog = db.listAudit(other.id, alice.id);
  assert.ok(otherLog.some((e) => e.action === "harness.delete" && e.targetId === h.id));
});

test("entries come back newest-first", () => {
  const log = db.listAudit(team.id, alice.id);
  for (let i = 1; i < log.length; i++) assert.ok(log[i - 1].ts >= log[i].ts, "descending ts");
});

test("an admin can read the log; a plain member and non-members cannot", () => {
  // bob is admin → allowed
  assert.ok(Array.isArray(db.listAudit(team.id, bob.id)));
  // carol was removed → not a member anymore
  assert.throws(() => db.listAudit(team.id, carol.id), /owner or admin/);
  const dave = db.createUser("dave@x.com", "password1");
  assert.throws(() => db.listAudit(team.id, dave.id), /owner or admin/);
});

test("the 'before' cursor pages backwards through entries", () => {
  const all = db.listAudit(team.id, alice.id, { limit: 500 });
  assert.ok(all.length >= 4);
  const firstPage = db.listAudit(team.id, alice.id, { limit: 2 });
  assert.equal(firstPage.length, 2);
  const next = db.listAudit(team.id, alice.id, { limit: 2, before: firstPage[firstPage.length - 1].ts });
  assert.ok(next.length >= 1);
  // no overlap: every entry in the next page is older than the cursor
  for (const e of next) assert.ok(e.ts < firstPage[firstPage.length - 1].ts);
});

test("limit is clamped to a sane range", () => {
  const huge = db.listAudit(team.id, alice.id, { limit: 100000 });
  assert.ok(huge.length <= 500);
  const zero = db.listAudit(team.id, alice.id, { limit: 0 });
  assert.ok(zero.length >= 1);  // floored to 1, not 0
});

test("logAudit with no org is a silent no-op (never throws)", () => {
  assert.doesNotThrow(() => db.logAudit(null, alice.id, "noop", {}));
});

console.log(`\naudit.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
