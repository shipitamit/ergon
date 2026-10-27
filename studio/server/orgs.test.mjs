/* Tests for the pure org + RBAC access model (Phase 2.1), against the real SQLite
   data layer (node:sqlite fallback, zero deps). Every harness belongs to exactly
   one org; access = the member's org role (owner/admin → edit, member → view);
   signup auto-creates a personal org. Run: node server/orgs.test.mjs  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-orgs-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const bob = db.createUser("bob@x.com", "password1");
const carol = db.createUser("carol@x.com", "password1");

test("signup auto-creates a personal org (owner)", () => {
  const orgs = db.listOrgs(alice.id);
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].role, "owner");
  assert.ok(/workspace/i.test(orgs[0].name));
});

test("a new harness lands in the creator's personal org", () => {
  const h = db.saveHarness(alice.id, { id: null, name: "Solo bot", graph: { nodes: [], edges: [] } });
  assert.ok(h.orgId);
  const mine = db.listHarnesses(alice.id);
  assert.ok(mine.some((x) => x.id === h.id && x.role === "edit"));
  // not visible to an unrelated user
  assert.ok(!db.listHarnesses(bob.id).some((x) => x.id === h.id));
});

const team = db.createOrg(alice.id, "Team");

test("createOrg makes a non-personal org with the creator as owner", () => {
  assert.equal(team.role, "owner");
  assert.equal(db.orgRoleFor(team.id, alice.id), "owner");
});

test("members get access to org harnesses by role (admin edit, member view)", () => {
  db.addMember(team.id, alice.id, "bob@x.com", "admin");
  db.addMember(team.id, alice.id, "carol@x.com", "member");
  const h = db.saveHarness(alice.id, { id: null, name: "Team bot", graph: { nodes: [], edges: [] }, orgId: team.id });
  assert.equal(db.getHarness(h.id, bob.id).role, "edit");    // admin
  assert.equal(db.getHarness(h.id, carol.id).role, "view");  // member
  assert.ok(db.listHarnesses(carol.id).some((x) => x.id === h.id));
});

test("a member cannot create or save in the org (view only)", () => {
  assert.throws(() => db.saveHarness(carol.id, { id: null, name: "nope", graph: {}, orgId: team.id }), /edit access/);
  const h = db.saveHarness(alice.id, { id: null, name: "Editable", graph: { nodes: [], edges: [] }, orgId: team.id });
  assert.throws(() => db.saveHarness(carol.id, { id: h.id, name: "no", graph: {} }), /edit access/);
  // admin (bob) can save
  const saved = db.saveHarness(bob.id, { id: h.id, name: "Editable v2", graph: {} });
  assert.equal(saved.name, "Editable v2");
});

test("non-members see nothing and get no role", () => {
  const h = db.saveHarness(alice.id, { id: null, name: "Private", graph: {}, orgId: team.id });
  const dave = db.createUser("dave@x.com", "password1");
  assert.throws(() => db.getHarness(h.id, dave.id), /not in one of your organizations/);
  assert.ok(!db.listHarnesses(dave.id).some((x) => x.id === h.id));
});

test("only owner/admin can delete an org harness", () => {
  const h = db.saveHarness(alice.id, { id: null, name: "Del", graph: {}, orgId: team.id });
  assert.throws(() => db.deleteHarness(h.id, carol.id), /owner or admin/);  // member
  assert.deepEqual(db.deleteHarness(h.id, bob.id), { deleted: true });      // admin
});

test("moving a harness between orgs needs manage + edit in the target", () => {
  const h = db.saveHarness(alice.id, { id: null, name: "Mover", graph: {}, orgId: team.id });
  const other = db.createOrg(alice.id, "Other");
  const moved = db.setHarnessOrg(h.id, alice.id, other.id);
  assert.equal(moved.orgId, other.id);
  // carol (not a member of 'other') loses access
  assert.ok(!db.listHarnesses(carol.id).some((x) => x.id === h.id));
});

test("only an owner can grant the owner role; last owner can't be removed", () => {
  assert.throws(() => db.addMember(team.id, bob.id, "carol@x.com", "owner"), /Only an owner/);  // bob is admin
  const solo = db.createOrg(alice.id, "Solo");
  assert.throws(() => db.removeMember(solo.id, alice.id, "alice@x.com"), /last owner/);
});

test("a plain member cannot add members", () => {
  assert.throws(() => db.addMember(team.id, carol.id, "dave@x.com", "member"), /owner or admin/);
});

console.log(`\norgs.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
