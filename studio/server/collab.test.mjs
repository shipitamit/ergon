/* Node-anchored comments against the real SQLite data layer (node:sqlite
   fallback, zero deps). Covers create (with node id), read ordering, empty-body
   rejection, RBAC on resolve/delete (editor or author), and no-access denial.
   Run: node server/collab.test.mjs  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-collab-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");           // org owner → "edit"
const team = db.createOrg(alice.id, "Team");
db.createUser("carol@x.com", "password1");
db.addMember(team.id, alice.id, "carol@x.com", "member");          // member → "view"
const carol = db.verifyUser("carol@x.com", "password1");
const mallory = db.createUser("mallory@x.com", "password1");       // no access
const h = db.saveHarness(alice.id, { id: null, name: "Bot", graph: { nodes: [], edges: [] }, orgId: team.id });

let c1, c2;
test("owner posts a node-anchored comment", () => {
  c1 = db.createComment(h.id, alice.id, { nodeId: "n1", body: "needs work" });
  assert.ok(c1.id && c1.nodeId === "n1" && c1.resolved === false);
  assert.equal(c1.authorEmail, "alice@x.com");
});

test("a viewer can read and post (comments aren't an edit)", () => {
  c2 = db.createComment(h.id, carol.id, { nodeId: "n1", body: "agree, and…" });
  const list = db.listComments(h.id, carol.id);
  assert.equal(list.length, 2);
  assert.ok(list[0].createdAt <= list[1].createdAt, "ordered oldest-first");
});

test("empty / whitespace body is rejected", () => {
  assert.throws(() => db.createComment(h.id, alice.id, { nodeId: "n1", body: "   " }), /empty/);
});

test("resolve: an editor or the author may; a non-author viewer may not", () => {
  assert.throws(() => db.resolveComment(c1.id, carol.id, true), /editor or the author/);  // c1 by alice; carol is a viewer
  db.resolveComment(c1.id, alice.id, true);                                               // editor ok
  assert.equal(db.listComments(h.id, alice.id).find((x) => x.id === c1.id).resolved, true);
  db.resolveComment(c2.id, carol.id, true);                                               // author ok on her own
  assert.equal(db.listComments(h.id, alice.id).find((x) => x.id === c2.id).resolved, true);
});

test("delete: author deletes own; editor deletes any; viewer can't delete others'", () => {
  assert.throws(() => db.deleteComment(c1.id, carol.id), /editor or the author/);
  db.deleteComment(c2.id, carol.id);                                                      // author
  assert.ok(db.listComments(h.id, alice.id).every((x) => x.id !== c2.id));
  db.deleteComment(c1.id, alice.id);                                                      // editor
  assert.equal(db.listComments(h.id, alice.id).length, 0);
});

test("someone with no org access can neither read nor post", () => {
  assert.throws(() => db.listComments(h.id, mallory.id), /Not found/);
  assert.throws(() => db.createComment(h.id, mallory.id, { body: "x" }), /Not found/);
});

test("erasing the org removes its comments", () => {
  const c = db.createComment(h.id, alice.id, { nodeId: "n2", body: "temp" });
  assert.ok(db.listComments(h.id, alice.id).length === 1);
  db.eraseOrg(team.id, alice.id);
  // harness (and its comments) are gone; a fresh read path can't resolve the harness
  assert.throws(() => db.listComments(h.id, alice.id), /Not found/);
  void c;
});

console.log(`\ncollab.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
