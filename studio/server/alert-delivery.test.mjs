/* Alert delivery: channel CRUD + RBAC (real SQLite), payload shaping for
   webhook vs slack, best-effort batch delivery to an org's enabled channels
   (fake http), the test ping, and the evaluator→delivery path end to end.
   Run: node server/alert-delivery.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-deliver-")), "t.db");
const db = await import("./db.mjs");
const delivery = await import("./alert-delivery.mjs");
const { evaluateAlerts } = await import("./alerts.mjs");

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }
const DAY = 86400_000;

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
const carol = db.createUser("carol@x.com", "password1");
db.addMember(team.id, alice.id, "carol@x.com", "member");

// a fake transport that records every POST
function recorder() {
  const calls = [];
  const http = async (method, url, { json } = {}) => { calls.push({ method, url, json }); return { ok: true, status: 200 }; };
  return { http, calls };
}

await test("create validates type + https target; member can't, non-member can't read", () => {
  assert.throws(() => db.createAlertChannel(team.id, alice.id, { type: "sms", target: "https://x" }), /type must be/);
  assert.throws(() => db.createAlertChannel(team.id, alice.id, { type: "webhook", target: "http://insecure" }), /https/);
  const ch = db.createAlertChannel(team.id, alice.id, { type: "webhook", target: "https://hooks.example/abc" });
  assert.ok(ch.id && ch.enabled);
  assert.equal(db.listAlertChannels(team.id, carol.id).length, 1);   // member reads
  assert.throws(() => db.createAlertChannel(team.id, carol.id, { type: "webhook", target: "https://y" }), /owner or admin/);
  const bob = db.createUser("bob@x.com", "password1");
  assert.throws(() => db.listAlertChannels(team.id, bob.id), /Not a member/);
});

await test("payload shaping differs for slack vs webhook", () => {
  const t = { ruleId: "r1", orgId: team.id, state: "firing", value: 0.7, name: "errors", metric: "error_rate", threshold: 0.5, message: "errors: error_rate = 0.7 > 0.5" };
  const slack = delivery.payloadFor({ type: "slack" }, t);
  assert.ok(typeof slack.text === "string" && /FIRING/.test(slack.text) && slack.text.includes("error_rate = 0.7"));
  const hook = delivery.payloadFor({ type: "webhook" }, t);
  assert.equal(hook.event, "alert");
  assert.equal(hook.state, "firing");
  assert.equal(hook.rule.name, "errors");
  assert.equal(hook.value, 0.7);
});

await test("deliverToChannel POSTs the payload to the channel target", async () => {
  const { http, calls } = recorder();
  await delivery.deliverToChannel({ type: "slack", target: "https://hooks.slack/abc" },
    { state: "resolved", message: "ok now", name: "x", metric: "spend", value: 0 }, { http });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hooks.slack/abc");
  assert.ok(/RESOLVED/.test(calls[0].json.text));
});

await test("deliverTransitions fans out to an org's enabled channels; disabled skipped; best-effort", async () => {
  // second org so channel counts are isolated
  const org = db.createOrg(alice.id, "Ops");
  db.createAlertChannel(org.id, alice.id, { type: "webhook", target: "https://a.example/1" });
  const off = db.createAlertChannel(org.id, alice.id, { type: "webhook", target: "https://b.example/2" });
  db.updateAlertChannel(alice.id, off.id, { enabled: false });
  const bad = db.createAlertChannel(org.id, alice.id, { type: "slack", target: "https://c.example/3" });

  const calls = [];
  const http = async (method, url, { json } = {}) => {
    calls.push({ url });
    if (url.includes("c.example")) throw new Error("boom");   // one channel fails
    return { ok: true, status: 200 };
  };
  const sent = await delivery.deliverTransitions(db, [{ orgId: org.id, state: "firing", message: "m", name: "r", metric: "spend", value: 2 }], { http });
  // attempted 2 enabled (a + c), c failed → 1 successful send; b (disabled) never attempted
  assert.equal(sent, 1);
  assert.ok(calls.some((c) => c.url.includes("a.example")));
  assert.ok(calls.some((c) => c.url.includes("c.example")));
  assert.ok(!calls.some((c) => c.url.includes("b.example")), "disabled channel not attempted");
});

await test("testChannel sends a sample ping", async () => {
  const { http, calls } = recorder();
  await delivery.testChannel({ type: "webhook", target: "https://hooks.example/t", orgId: team.id }, { http });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].json.event, "alert");
  assert.ok(/test/i.test(calls[0].json.message));
});

await test("end to end: a firing rule evaluated → delivered to the channel", async () => {
  const org = db.createOrg(alice.id, "E2E");
  const h = db.saveHarness(alice.id, { id: null, name: "e2e", graph: { nodes: [], edges: [] }, orgId: org.id });
  db.createAlertChannel(org.id, alice.id, { type: "slack", target: "https://hooks.slack/e2e" });
  db.createAlertRule(org.id, alice.id, { name: "spend high", metric: "spend", comparator: ">", threshold: 1.0, windowMs: DAY });
  db.recordRun(alice.id, { harnessId: h.id, orgId: org.id, status: "ok", usage: { cost: 0.8 } });
  db.recordRun(alice.id, { harnessId: h.id, orgId: org.id, status: "ok", usage: { cost: 0.8 } });  // 1.6 > 1.0

  const transitions = (await evaluateAlerts(db)).filter((t) => t.orgId === org.id);
  assert.equal(transitions.length, 1);
  const { http, calls } = recorder();
  const sent = await delivery.deliverTransitions(db, transitions, { http });
  assert.equal(sent, 1);
  assert.equal(calls[0].url, "https://hooks.slack/e2e");
  assert.ok(/FIRING/.test(calls[0].json.text) && /spend high/.test(calls[0].json.text));
});

console.log(`\nalert-delivery.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
