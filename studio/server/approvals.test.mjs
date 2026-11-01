/* Human-in-the-loop approval inbox against the real SQLite store: file, list
   (incl. status filter), read, decide (approve/reject), the already-decided and
   expired guards, and RBAC. Run: node server/approvals.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-appr-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
const carol = db.createUser("carol@x.com", "password1");
db.addMember(team.id, alice.id, "carol@x.com", "member");

test("file a request → pending, detail round-trips", () => {
  const r = db.createApprovalRequest(team.id, alice.id, { title: "Refund $500", detail: { amount: 500 }, runId: "run1" });
  assert.equal(r.status, "pending");
  assert.equal(r.title, "Refund $500");
  assert.deepEqual(r.detail, { amount: 500 });
  assert.equal(r.requestedBy, alice.id);
  assert.throws(() => db.createApprovalRequest(team.id, alice.id, { title: "" }), /needs a title/);
});

test("list is org-scoped and filterable by status; members can read", () => {
  db.createApprovalRequest(team.id, alice.id, { title: "second" });
  const all = db.listApprovalRequests(team.id, carol.id);
  assert.ok(all.length >= 2);
  const pending = db.listApprovalRequests(team.id, alice.id, { status: "pending" });
  assert.ok(pending.every((r) => r.status === "pending"));
});

test("a member approves with a note; decision records who + when", () => {
  const r = db.createApprovalRequest(team.id, alice.id, { title: "deploy prod" });
  const decided = db.decideApprovalRequest(carol.id, r.id, { decision: "approve", note: "lgtm" });
  assert.equal(decided.status, "approved");
  assert.equal(decided.decidedBy, carol.id);
  assert.equal(decided.decisionNote, "lgtm");
  assert.ok(decided.decidedAt >= decided.createdAt);
});

test("reject works and is terminal", () => {
  const r = db.createApprovalRequest(team.id, alice.id, { title: "risky" });
  assert.equal(db.decideApprovalRequest(alice.id, r.id, { decision: "reject" }).status, "rejected");
  assert.throws(() => db.decideApprovalRequest(alice.id, r.id, { decision: "approve" }), /already rejected/);
});

test("decision must be approve or reject", () => {
  const r = db.createApprovalRequest(team.id, alice.id, { title: "x" });
  assert.throws(() => db.decideApprovalRequest(alice.id, r.id, { decision: "maybe" }), /approve.*reject/);
});

test("an expired request can't be decided and reads as expired", () => {
  const r = db.createApprovalRequest(team.id, alice.id, { title: "stale", expiresAt: Date.now() - 1000 });
  assert.throws(() => db.decideApprovalRequest(alice.id, r.id, { decision: "approve" }), /expired/);
  assert.equal(db.getApprovalRequest(alice.id, r.id).status, "expired");
});

test("access is org-scoped: a non-member can't file, read, or decide", () => {
  const bob = db.createUser("bob@x.com", "password1");
  assert.throws(() => db.createApprovalRequest(team.id, bob.id, { title: "x" }), /Not a member/);
  assert.throws(() => db.listApprovalRequests(team.id, bob.id), /Not a member/);
  const r = db.createApprovalRequest(team.id, alice.id, { title: "y" });
  assert.throws(() => db.getApprovalRequest(bob.id, r.id), /Not a member/);
  assert.throws(() => db.decideApprovalRequest(bob.id, r.id, { decision: "approve" }), /Not a member/);
});

console.log(`\napprovals.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
