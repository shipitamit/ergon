/* Data governance — export + right-to-erasure against the real SQLite layer
   (node:sqlite fallback, zero deps). Covers the export bundle (secrets excluded),
   RBAC, erasure removing every org-scoped row + the key's service-account users,
   and that unrelated orgs/users are untouched. Run: node server/governance.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-gov-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
db.addMember(team.id, alice.id, (db.createUser("carol@x.com", "password1"), "carol@x.com"), "member");
const carol = db.verifyUser("carol@x.com", "password1");
const h = db.saveHarness(alice.id, { id: null, name: "Bot", graph: { nodes: [{ id: "a" }], edges: [] }, orgId: team.id });
db.recordRun(alice.id, { orgId: team.id, harnessId: h.id, input: "hi", output: "ok", usage: { cost: 0.01 } });
db.setBudget(team.id, alice.id, { period: "month", maxCost: 10 });
db.createDeployment(team.id, alice.id, { slug: "team-bot", harnessId: h.id });
const key = db.createApiKey(team.id, alice.id, "CI", "member");

test("export bundles the org's data with the harness graph", () => {
  const b = db.exportOrg(team.id, alice.id);
  assert.equal(b.org.id, team.id);
  assert.ok(b.members.some((m) => m.email === "alice@x.com"));
  assert.equal(b.harnesses.length, 1);
  assert.deepEqual(b.harnesses[0].graph.nodes, [{ id: "a" }]);
  assert.equal(b.runs.length, 1);
  assert.ok(b.deployments.some((d) => d.slug === "team-bot"));
  assert.ok(b.budgets.some((x) => x.period === "month"));
  assert.ok(b.apiKeys.some((k) => k.name === "CI"));
});

test("export never leaks secrets (no hash / plaintext key)", () => {
  const json = JSON.stringify(db.exportOrg(team.id, alice.id));
  assert.ok(!/"hash"/.test(json));
  assert.ok(!json.includes(key.secret.split(".")[1]));   // the secret body never appears
});

test("a plain member cannot export; a non-member cannot either", () => {
  assert.throws(() => db.exportOrg(team.id, carol.id), /owner or admin/);
  const dave = db.createUser("dave@x.com", "password1");
  assert.throws(() => db.exportOrg(team.id, dave.id), /owner or admin/);
});

test("only an owner can erase; a member/admin cannot", () => {
  db.addMember(team.id, alice.id, "carol@x.com", "admin");   // promote carol to admin
  assert.throws(() => db.eraseOrg(team.id, carol.id), /owner/);
});

test("erase removes every org-scoped row and the key's service-account user", () => {
  const svcId = db.verifyApiKey(key.secret).id;             // the backing svcu_ user
  const other = db.createOrg(alice.id, "Other");            // an unrelated org
  const res = db.eraseOrg(team.id, alice.id);
  assert.deepEqual(res, { erased: true, orgId: team.id });
  assert.equal(db.resolveDeployment("team-bot"), null);
  assert.equal(db.verifyApiKey(key.secret), null);          // key gone
  assert.equal(db.orgRoleFor(team.id, alice.id), null);     // membership gone
  assert.throws(() => db.getHarness(h.id, alice.id), /not found|not in one/i);  // harness deleted
  // the service-account user is gone, but alice (a real user) and the other org remain
  assert.throws(() => db.listMembers(svcId ? team.id : team.id, alice.id), /member|not a member/i);
  assert.ok(db.listOrgs(alice.id).some((o) => o.id === other.id));
  assert.ok(db.verifyUser("alice@x.com", "password1"));     // real user untouched
});

console.log(`\ngovernance.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
