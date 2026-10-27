/* Service accounts / API keys against the real SQLite data layer (node:sqlite
   fallback, zero deps). Covers issuing (owner/admin only), one-time secret,
   bearer verification → org-member principal, role mapping, revocation cutting
   access, and that service accounts are hidden from the member list.
   Run: node server/apikeys.test.mjs  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-keys-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const carol = db.createUser("carol@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
db.addMember(team.id, alice.id, "carol@x.com", "member");

test("owner can create a key; the secret is returned once and well-formed", () => {
  const k = db.createApiKey(team.id, alice.id, "CI", "admin");
  assert.ok(k.secret.startsWith("esk_"));
  assert.ok(k.secret.includes("."));
  assert.equal(k.role, "admin");
  // listing never exposes the secret
  const listed = db.listApiKeys(team.id, alice.id);
  assert.ok(listed.some((x) => x.id === k.id));
  assert.ok(!JSON.stringify(listed).includes(k.secret.split(".")[1]));
});

test("a plain member cannot create or list keys", () => {
  assert.throws(() => db.createApiKey(team.id, carol.id, "nope", "member"), /owner or admin/);
  assert.throws(() => db.listApiKeys(team.id, carol.id), /owner or admin/);
});

test("verifyApiKey resolves the secret to an org-member principal", () => {
  const k = db.createApiKey(team.id, alice.id, "reader", "member");
  const p = db.verifyApiKey(k.secret);
  assert.ok(p && p.apiKey === true);
  assert.equal(p.orgId, team.id);
  assert.equal(db.orgRoleFor(team.id, p.id), "member");   // backing svc user is a member
});

test("key role governs harness access (member=view, admin=edit)", () => {
  const h = db.saveHarness(alice.id, { id: null, name: "Bot", graph: { nodes: [], edges: [] }, orgId: team.id });
  const reader = db.verifyApiKey(db.createApiKey(team.id, alice.id, "r", "member").secret);
  const writer = db.verifyApiKey(db.createApiKey(team.id, alice.id, "w", "admin").secret);
  assert.equal(db.getHarness(h.id, reader.id).role, "view");
  assert.equal(db.getHarness(h.id, writer.id).role, "edit");
  // a read-only key cannot save
  assert.throws(() => db.saveHarness(reader.id, { id: h.id, name: "no", graph: {} }), /edit access/);
  const saved = db.saveHarness(writer.id, { id: h.id, name: "yes", graph: {} });
  assert.equal(saved.name, "yes");
});

test("a bad or tampered secret does not verify", () => {
  const k = db.createApiKey(team.id, alice.id, "x", "member");
  assert.equal(db.verifyApiKey(k.secret + "x"), null);
  assert.equal(db.verifyApiKey("esk_nope.abc"), null);
  assert.equal(db.verifyApiKey("garbage"), null);
});

test("revoking a key stops verification and cuts the backing membership", () => {
  const k = db.createApiKey(team.id, alice.id, "temp", "admin");
  const p = db.verifyApiKey(k.secret);
  assert.ok(p);
  db.revokeApiKey(team.id, alice.id, k.id);
  assert.equal(db.verifyApiKey(k.secret), null);
  assert.equal(db.orgRoleFor(team.id, p.id), null);       // no longer a member
  // listing marks it revoked
  assert.ok(db.listApiKeys(team.id, alice.id).find((x) => x.id === k.id).revokedAt);
});

test("service accounts never appear in the human member list", () => {
  db.createApiKey(team.id, alice.id, "hidden", "member");
  const emails = db.listMembers(team.id, alice.id).map((m) => m.email);
  assert.ok(emails.includes("alice@x.com"));
  assert.ok(!emails.some((e) => e.endsWith("@keys.ergon.local")));
});

test("key issue + revoke are recorded in the audit log", () => {
  const k = db.createApiKey(team.id, alice.id, "audited", "member");
  db.revokeApiKey(team.id, alice.id, k.id);
  const log = db.listAudit(team.id, alice.id, { limit: 500 });
  assert.ok(log.some((e) => e.action === "apikey.create" && e.targetId === k.id));
  assert.ok(log.some((e) => e.action === "apikey.revoke" && e.targetId === k.id));
});

console.log(`\napikeys.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
