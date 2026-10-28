/* Triggers: DB CRUD + token/due selection against real SQLite, plus the fire
   service with a fake forward (no network). Run: node server/triggers.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-trg-")), "t.db");
const db = await import("./db.mjs");
const { fireTrigger, scheduleTick } = await import("./triggers.mjs");

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const u = db.createUser("trg@x.com", "password1");
const orgId = db.listOrgs(u.id)[0].id;
const h = db.saveHarness(u.id, { name: "H", graph: { nodes: [], edges: [] } });

await test("create a webhook trigger → gets a token, enabled, no cron", () => {
  const t = db.createTrigger(u.id, h.id, { type: "webhook" });
  assert.ok(t.token && t.token.length > 10, "token minted");
  assert.equal(t.type, "webhook");
  assert.equal(t.enabled, true);
  assert.equal(t.nextFireAt, null);
});

await test("create a schedule trigger → validates cron, sets next_fire", () => {
  const t = db.createTrigger(u.id, h.id, { type: "schedule", cron: "*/5 * * * *", payload: "tick" });
  assert.ok(t.nextFireAt > Date.now(), "next fire scheduled in the future");
  assert.throws(() => db.createTrigger(u.id, h.id, { type: "schedule", cron: "nope" }), /Invalid cron/);
});

await test("list is newest-first; token lookup resolves the webhook", () => {
  const list = db.listTriggers(h.id, u.id);
  assert.equal(list.length, 2);
  const wh = list.find((t) => t.type === "webhook");
  const byTok = db.getTriggerByToken(wh.token);
  assert.equal(byTok.id, wh.id);
  assert.equal(db.getTriggerByToken("bogus"), null);
});

await test("access is edit-scoped: an outsider can't create/list", () => {
  const other = db.createUser("out@x.com", "password1");
  assert.throws(() => db.listTriggers(h.id, other.id));
  assert.throws(() => db.createTrigger(other.id, h.id, { type: "webhook" }));
});

await test("enable/disable toggles and re-anchors a schedule", () => {
  const sched = db.listTriggers(h.id, u.id).find((t) => t.type === "schedule");
  const off = db.updateTrigger(u.id, sched.id, { enabled: false });
  assert.equal(off.enabled, false);
  const on = db.updateTrigger(u.id, sched.id, { enabled: true });
  assert.ok(on.enabled && on.nextFireAt > Date.now());
});

await test("fireTrigger with no deployment records a 'no-runner' outcome", async () => {
  const wh = db.listTriggers(h.id, u.id).find((t) => t.type === "webhook");
  const r = await fireTrigger(db, wh, "hello");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-runner");
  assert.equal(db.listTriggers(h.id, u.id).find((t) => t.id === wh.id).lastStatus, "no-runner");
});

await test("fireTrigger with an attached runner forwards + records a run", async () => {
  db.createDeployment(orgId, u.id, { slug: "trg-dep", harnessId: h.id, targetUrl: "https://runner.example" });
  const wh = db.listTriggers(h.id, u.id).find((t) => t.type === "webhook");
  let seen = null;
  const fakeForward = async (url, { input }) => { seen = { url, input }; return { status: 200, kind: "ok", body: { text: "RESULT" }, usage: { input_tokens: 3, output_tokens: 5, cost: 0.001 } }; };
  const r = await fireTrigger(db, wh, "payload-in", { forward: fakeForward });
  assert.equal(r.ok, true);
  assert.equal(seen.url, "https://runner.example");
  assert.equal(seen.input, "payload-in");
  assert.ok(r.runId, "a run was recorded");
  const run = db.getRun(u.id, r.runId);
  assert.equal(run.output, "RESULT", "run output stored");
  assert.equal(run.status, "ok");
  assert.equal(db.listTriggers(h.id, u.id).find((t) => t.id === wh.id).lastStatus, "ok");
});

await test("scheduleTick fires only due schedule triggers and advances them", async () => {
  // force the schedule trigger due now
  const sched = db.listTriggers(h.id, u.id).find((t) => t.type === "schedule");
  db.markTriggerFired(sched.id, { firedAt: Date.now(), status: "ok", nextFireAt: Date.now() - 1000 });
  const before = db.listTriggers(h.id, u.id).find((t) => t.id === sched.id).fireCount;
  const fakeForward = async () => ({ status: 200, kind: "ok", body: { text: "SCHED" }, usage: {} });
  const n = await scheduleTick(db, { forward: fakeForward });
  assert.ok(n >= 1, "at least one fired");
  const after = db.listTriggers(h.id, u.id).find((t) => t.id === sched.id);
  assert.ok(after.fireCount > before, "fire count advanced");
  assert.ok(after.nextFireAt > Date.now(), "next fire pushed into the future");
});

// ── durable, coordinated scheduler ──
await test("atomic claim: two concurrent claims of the same due slot — only one wins (no double-fire)", () => {
  const sched = db.createTrigger(u.id, h.id, { type: "schedule", cron: "*/5 * * * *", payload: "p" });
  // force it due now
  db.markTriggerFired(sched.id, { firedAt: Date.now(), status: "ok", nextFireAt: Date.now() - 1000 });
  const slot = db.listTriggers(h.id, u.id).find((t) => t.id === sched.id).nextFireAt;
  const a = db.claimDueScheduleTriggers(Date.now());
  const b = db.claimDueScheduleTriggers(Date.now());   // second worker / overlapping tick
  const claimedA = a.filter((c) => c.trigger.id === sched.id);
  const claimedB = b.filter((c) => c.trigger.id === sched.id);
  assert.equal(claimedA.length, 1, "first claim gets the slot");
  assert.equal(claimedB.length, 0, "second claim gets nothing — already claimed");
  assert.equal(claimedA[0].scheduledFor, slot, "claim covers the exact due slot");
  const after = db.listTriggers(h.id, u.id).find((t) => t.id === sched.id);
  assert.ok(after.nextFireAt > Date.now(), "slot advanced at claim time");
});

await test("a durable fire record is written per claimed slot, recorded on completion", () => {
  const sched = db.createTrigger(u.id, h.id, { type: "schedule", cron: "*/5 * * * *", payload: "x" });
  db.markTriggerFired(sched.id, { firedAt: Date.now(), status: "ok", nextFireAt: Date.now() - 1000 });
  const [claim] = db.claimDueScheduleTriggers(Date.now()).filter((c) => c.trigger.id === sched.id);
  assert.ok(claim && claim.fireId, "claimed with a fire id");
  let fires = db.listTriggerFires(sched.id, u.id);
  assert.equal(fires.length, 1);
  assert.equal(fires[0].status, "claimed");
  db.recordFireResult(claim.fireId, { status: "ok", runId: "run_abc" });
  fires = db.listTriggerFires(sched.id, u.id);
  assert.equal(fires[0].status, "ok");
  assert.equal(fires[0].run_id, "run_abc");
});

await test("scheduleTick uses the durable claim path: fires once, records the run, advances", async () => {
  const sched = db.createTrigger(u.id, h.id, { type: "schedule", cron: "*/5 * * * *", payload: "y" });
  db.markTriggerFired(sched.id, { firedAt: Date.now(), status: "ok", nextFireAt: Date.now() - 1000 });
  db.createDeployment(orgId, u.id, { slug: "sched-dep", harnessId: h.id, targetUrl: "https://runner.example" });
  const fakeForward = async () => ({ status: 200, kind: "ok", body: { text: "DONE" }, usage: {} });
  const n = await scheduleTick(db, { forward: fakeForward });
  assert.ok(n >= 1, "fired at least one");
  // a second tick immediately after finds nothing due (slot already advanced)
  const n2 = await scheduleTick(db, { forward: fakeForward });
  const firesThisTrigger = db.listTriggerFires(sched.id, u.id);
  assert.equal(firesThisTrigger.length, 1, "exactly one durable fire for this slot (no double-fire across ticks)");
  assert.equal(firesThisTrigger[0].status, "ok");
  assert.ok(firesThisTrigger[0].run_id, "the fire recorded its run id");
  const after = db.listTriggers(h.id, u.id).find((t) => t.id === sched.id);
  assert.ok(after.nextFireAt > Date.now(), "advanced into the future");
});

await test("catch-up: a schedule whose slot passed while 'down' is claimed on the next tick", () => {
  const sched = db.createTrigger(u.id, h.id, { type: "schedule", cron: "0 * * * *", payload: "z" });
  db.markTriggerFired(sched.id, { firedAt: Date.now(), status: "ok", nextFireAt: Date.now() - 3600_000 });  // an hour overdue
  const claimed = db.claimDueScheduleTriggers(Date.now()).filter((c) => c.trigger.id === sched.id);
  assert.equal(claimed.length, 1, "overdue slot is caught up");
});

await test("fires history is access-scoped", () => {
  const sched = db.listTriggers(h.id, u.id).find((t) => t.type === "schedule");
  const other = db.createUser("sch-out@x.com", "password1");
  assert.throws(() => db.listTriggerFires(sched.id, other.id));
});

await test("delete removes a trigger", () => {
  const wh = db.listTriggers(h.id, u.id).find((t) => t.type === "webhook");
  db.deleteTrigger(u.id, wh.id);
  assert.ok(!db.listTriggers(h.id, u.id).some((t) => t.id === wh.id));
});

console.log(`\ntriggers.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
