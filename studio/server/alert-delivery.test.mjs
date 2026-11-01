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
  const { sent } = await delivery.deliverTransitions(db, [{ orgId: org.id, state: "firing", message: "m", name: "r", metric: "spend", value: 2 }], { http, retries: 0 });
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
  const { sent } = await delivery.deliverTransitions(db, transitions, { http });
  assert.equal(sent, 1);
  assert.equal(calls[0].url, "https://hooks.slack/e2e");
  assert.ok(/FIRING/.test(calls[0].json.text) && /spend high/.test(calls[0].json.text));
});

await test("deliverToChannel retries with backoff, then succeeds", async () => {
  let n = 0;
  const http = async () => { n++; if (n < 3) throw new Error("flaky"); return { ok: true, status: 200 }; };
  const r = await delivery.deliverToChannel({ type: "webhook", target: "https://x" },
    { state: "firing", message: "m" }, { http, retries: 3, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(n, 3, "failed twice then succeeded on the third attempt");
});

await test("deliverToChannel gives up after exhausting retries", async () => {
  let n = 0;
  const http = async () => { n++; throw new Error("down"); };
  await assert.rejects(delivery.deliverToChannel({ type: "webhook", target: "https://x" },
    { state: "firing" }, { http, retries: 2, sleep: async () => {} }), /down/);
  assert.equal(n, 3, "initial + 2 retries");
});

await test("per-rule routing sends only to the rule's named channels", async () => {
  const org = db.createOrg(alice.id, "Routing");
  const a = db.createAlertChannel(org.id, alice.id, { type: "webhook", target: "https://a.example/r" });
  const b = db.createAlertChannel(org.id, alice.id, { type: "webhook", target: "https://b.example/r" });
  const calls = [];
  const http = async (m, url) => { calls.push(url); return { ok: true, status: 200 }; };
  // route a transition to only channel b
  const out = await delivery.deliverTransitions(db, [{ orgId: org.id, state: "firing", message: "m", channelIds: [b.id] }], { http });
  assert.equal(out.sent, 1);
  assert.ok(calls.some((u) => u.includes("b.example")) && !calls.some((u) => u.includes("a.example")));
  assert.equal(out.results[0].channelId, b.id);
});

await test("deliverTransitions reports per-channel outcomes (ok + error)", async () => {
  const org = db.createOrg(alice.id, "Outcomes");
  db.createAlertChannel(org.id, alice.id, { type: "webhook", target: "https://good.example/o" });
  db.createAlertChannel(org.id, alice.id, { type: "webhook", target: "https://bad.example/o" });
  const http = async (m, url) => { if (url.includes("bad")) throw new Error("boom"); return { ok: true, status: 200 }; };
  const out = await delivery.deliverTransitions(db, [{ orgId: org.id, state: "firing", message: "m" }], { http, retries: 0 });
  assert.equal(out.sent, 1); assert.equal(out.failed, 1);
  assert.ok(out.results.find((r) => !r.ok && /boom/.test(r.error)));
});

await test("cooldown suppresses a re-notify within the window and stamps on send", async () => {
  const org = db.createOrg(alice.id, "Cooldown");
  const h = db.saveHarness(alice.id, { id: null, name: "c", graph: { nodes: [], edges: [] }, orgId: org.id });
  db.createAlertChannel(org.id, alice.id, { type: "webhook", target: "https://cd.example/x" });
  const rule = db.createAlertRule(org.id, alice.id, { name: "flappy", metric: "spend", comparator: ">", threshold: 0, windowMs: DAY, cooldownMs: 60000 });
  const calls = [];
  const http = async () => { calls.push(1); return { ok: true, status: 200 }; };
  const T0 = 1_000_000;
  // first firing: delivered + cooldown stamped
  let out = await delivery.deliverTransitions(db, [{ orgId: org.id, ruleId: rule.id, state: "firing", message: "m", cooldownMs: 60000, lastNotifiedAt: null }], { http, now: () => T0 });
  assert.equal(out.sent, 1);
  assert.ok(db.listAlertRules(org.id, alice.id).find((r) => r.id === rule.id).lastNotifiedAt === T0, "cooldown clock stamped");
  // second firing 30s later with the stamped lastNotifiedAt → suppressed
  out = await delivery.deliverTransitions(db, [{ orgId: org.id, ruleId: rule.id, state: "firing", message: "m2", cooldownMs: 60000, lastNotifiedAt: T0 }], { http, now: () => T0 + 30000 });
  assert.equal(out.suppressed, 1); assert.equal(out.sent, 0);
  assert.equal(calls.length, 1, "no second POST within cooldown");
  // after the window → delivered again
  out = await delivery.deliverTransitions(db, [{ orgId: org.id, ruleId: rule.id, state: "firing", message: "m3", cooldownMs: 60000, lastNotifiedAt: T0 }], { http, now: () => T0 + 61000 });
  assert.equal(out.sent, 1);
});

console.log(`\nalert-delivery.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
