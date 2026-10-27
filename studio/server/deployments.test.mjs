/* Deployments (hosted control plane) against the real SQLite data layer
   (node:sqlite fallback, zero deps). Covers create (owner/admin, slug + URL
   validation, uniqueness), member listing, gateway resolution, RBAC, and
   delete. Run: node server/deployments.test.mjs  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-dep-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
db.addMember(team.id, alice.id, (db.createUser("carol@x.com", "password1"), "carol@x.com"), "member");
const carol = db.verifyUser("carol@x.com", "password1");
const h = db.saveHarness(alice.id, { id: null, name: "Bot", graph: { nodes: [], edges: [] }, orgId: team.id });

test("owner registers a deployment; slug + URL are validated", () => {
  const d = db.createDeployment(team.id, alice.id, { slug: "support-bot", harnessId: h.id, targetUrl: "http://runner:8900" });
  assert.equal(d.slug, "support-bot");
  assert.throws(() => db.createDeployment(team.id, alice.id, { slug: "Bad Slug" }), /slug must be/);
  assert.throws(() => db.createDeployment(team.id, alice.id, { slug: "ok-slug", targetUrl: "ftp://x" }), /http\(s\)/);
});

test("slugs are globally unique", () => {
  assert.throws(() => db.createDeployment(team.id, alice.id, { slug: "support-bot" }), /already taken/);
});

test("a plain member cannot create or delete, but can list", () => {
  assert.throws(() => db.createDeployment(team.id, carol.id, { slug: "nope-bot" }), /owner or admin/);
  assert.ok(db.listDeployments(team.id, carol.id).some((d) => d.slug === "support-bot"));
});

test("the gateway resolves a slug to org + harness + runner URL", () => {
  const r = db.resolveDeployment("support-bot");
  assert.equal(r.orgId, team.id);
  assert.equal(r.harnessId, h.id);
  assert.equal(r.targetUrl, "http://runner:8900");
  assert.equal(r.status, "active");
  assert.equal(db.resolveDeployment("does-not-exist"), null);
});

test("delete removes it (owner/admin) and the slug frees up", () => {
  const d = db.listDeployments(team.id, alice.id).find((x) => x.slug === "support-bot");
  assert.throws(() => db.deleteDeployment(team.id, carol.id, d.id), /owner or admin/);
  db.deleteDeployment(team.id, alice.id, d.id);
  assert.equal(db.resolveDeployment("support-bot"), null);
  // slug can be reused after deletion
  assert.ok(db.createDeployment(team.id, alice.id, { slug: "support-bot" }).id);
});

test("create and delete are recorded in the audit log", () => {
  const d = db.createDeployment(team.id, alice.id, { slug: "audited-bot" });
  db.deleteDeployment(team.id, alice.id, d.id);
  const log = db.listAudit(team.id, alice.id, { limit: 500 });
  assert.ok(log.some((e) => e.action === "deployment.create" && e.targetId === d.id));
  assert.ok(log.some((e) => e.action === "deployment.delete" && e.targetId === d.id));
});

console.log(`\ndeployments.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
