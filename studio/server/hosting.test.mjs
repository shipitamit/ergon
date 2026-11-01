/* Managed hosting: the lifecycle service over the real SQLite store and the
   in-memory FakeMachinesDriver. Covers provision→ready (registers a routable
   deployment), the provisioning→ready health gate via refresh(), stop/restart
   (flip the deployment target), launch failure, logs, and RBAC.
   Run: node server/hosting.test.mjs */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-hosting-")), "t.db");
const db = await import("./db.mjs");
const hosting = await import("./hosting.mjs");
const { FakeMachinesDriver } = await import("./hosting-driver.mjs");

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const alice = db.createUser("alice@x.com", "password1");
const team = db.createOrg(alice.id, "Team");
const carol = db.createUser("carol@x.com", "password1");
db.addMember(team.id, alice.id, "carol@x.com", "member");
const h = db.saveHarness(alice.id, { id: null, name: "Bot", graph: { nodes: [], edges: [] }, orgId: team.id });

await test("provision launches, health-gates, and registers a routable deployment", async () => {
  const driver = new FakeMachinesDriver();   // ready immediately
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-prod", image: "ergon/runner:1" }, { driver });
  assert.equal(r.status, "ready");
  assert.ok(r.machineId && r.url && r.deploymentId, "machine + url + deployment recorded");
  // the existing gateway can now resolve the slug to the live runner
  const dep = db.resolveDeployment("bot-prod");
  assert.equal(dep.status, "active");
  assert.equal(dep.targetUrl, r.url);
  assert.equal(db.activeDeploymentForHarness(h.id).targetUrl, r.url);
});

await test("provisioning→ready: a slow machine stays provisioning, refresh() promotes it", async () => {
  const driver = new FakeMachinesDriver({ readyAfter: 3 });
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-slow" }, { driver, pollMax: 1 });
  assert.equal(r.status, "provisioning");
  assert.equal(r.deploymentId, null, "no deployment until healthy");
  assert.equal(db.resolveDeployment("bot-slow"), null);
  await hosting.refresh(db, alice.id, r.id, { driver });        // poll 2 → still starting
  let r2 = db.getManagedRunner(alice.id, r.id);
  assert.equal(r2.status, "provisioning");
  r2 = await hosting.refresh(db, alice.id, r.id, { driver });   // poll 3 → ready
  assert.equal(r2.status, "ready");
  assert.ok(r2.deploymentId);
  assert.equal(db.resolveDeployment("bot-slow").status, "active");
});

await test("stop halts the machine and parks the deployment (gateway stops routing)", async () => {
  const driver = new FakeMachinesDriver();
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-stop" }, { driver });
  const s = await hosting.stop(db, alice.id, r.id, { driver });
  assert.equal(s.status, "stopped");
  assert.equal(db.resolveDeployment("bot-stop").status, "stopped");
  // activeDeploymentForHarness only returns 'active' rows
  const act = db.listDeployments(team.id, alice.id).find((d) => d.slug === "bot-stop");
  assert.equal(act.status, "stopped");
});

await test("restart brings it back and re-activates the deployment", async () => {
  const driver = new FakeMachinesDriver();
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-restart" }, { driver });
  await hosting.stop(db, alice.id, r.id, { driver });
  const back = await hosting.restart(db, alice.id, r.id, { driver });
  assert.equal(back.status, "ready");
  assert.equal(db.resolveDeployment("bot-restart").status, "active");
});

await test("a launch failure is captured as an error runner, not a throw", async () => {
  const boom = { launch: async () => { throw new Error("capacity"); } };
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-fail" }, { driver: boom });
  assert.equal(r.status, "error");
  assert.ok(/capacity/.test(r.detail));
  assert.equal(db.resolveDeployment("bot-fail"), null, "no deployment registered on failure");
});

await test("logs come back for a running machine", async () => {
  const driver = new FakeMachinesDriver();
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-logs" }, { driver });
  const lines = await hosting.logs(db, alice.id, r.id, { driver });
  assert.ok(Array.isArray(lines) && lines.length >= 1);
});

await test("RBAC: a member cannot provision or stop; a non-member cannot list", async () => {
  const driver = new FakeMachinesDriver();
  await assert.rejects(hosting.provision(db, { orgId: team.id, userId: carol.id, harnessId: h.id, slug: "bot-nope" }, { driver }), /owner or admin/);
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-rbac" }, { driver });
  await assert.rejects(hosting.stop(db, carol.id, r.id, { driver }), /owner or admin/);
  const bob = db.createUser("bob@x.com", "password1");
  assert.throws(() => db.listManagedRunners(team.id, bob.id), /Not a member/);
});

await test("provision requires a slug", async () => {
  const driver = new FakeMachinesDriver();
  await assert.rejects(hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id }, { driver }), /slug is required/);
});

await test("buildRunnerEnv mints a working scoped key + lists referenced connections (no raw secrets)", async () => {
  // a connection the harness references
  const conn = db.createConnection(team.id, alice.id, { connectorId: "http", name: "api", config: { baseUrl: "https://x" }, secret: "sk-live-123" });
  const hc = db.saveHarness(alice.id, { id: null, name: "WithConn", orgId: team.id,
    graph: { nodes: [{ id: "n1", type: "agent", tools: [{ type: "custom", config: { connectionId: conn.id } }] }], edges: [] } });
  const { env, apiKeyId } = await hosting.buildRunnerEnv(db, { orgId: team.id, userId: alice.id, harnessId: hc.id, slug: "withconn", apiUrl: "https://ergon.example" });
  assert.ok(env.ERGON_API_KEY && apiKeyId, "a service key is minted");
  assert.equal(env.ERGON_ORG_ID, team.id);
  assert.equal(env.ERGON_API_URL, "https://ergon.example");
  assert.equal(env.ERGON_CONNECTIONS, conn.id, "the referenced connection is listed for run-time resolution");
  // the raw connection secret is NOT in the env — it's resolved at run time via the key
  assert.ok(!JSON.stringify(env).includes("sk-live-123"), "no plaintext credential baked into env");
  // and the minted key actually authenticates against the org
  const princ = db.verifyApiKey(env.ERGON_API_KEY);
  assert.ok(princ && princ.apiKey && princ.orgId === team.id, "minted key authenticates for the org");
});

await test("provision injects the runner env (key reaches the machine)", async () => {
  const driver = new FakeMachinesDriver();
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-env" }, { driver, apiUrl: "https://ergon.example" });
  assert.equal(r.status, "ready");
  // the fake driver stored the launch env on its machine record
  const machineEnv = driver._m.get(r.machineId).env;
  assert.ok(machineEnv.ERGON_API_KEY, "runner booted with a scoped key");
  assert.equal(machineEnv.ERGON_ORG_ID, team.id);
});

await test("remove tears down: stops the machine, revokes the scoped key, parks the deployment, deletes the record", async () => {
  const driver = new FakeMachinesDriver();
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-teardown" }, { driver });
  assert.ok(r.apiKeyId, "ready runner persisted its scoped key id");
  const secret = driver._m.get(r.machineId).env.ERGON_API_KEY;
  assert.ok(db.verifyApiKey(secret), "key authenticates before teardown");

  const out = await hosting.remove(db, alice.id, r.id, { driver });
  assert.equal(out.deleted, true);
  assert.equal(db.verifyApiKey(secret), null, "key no longer authenticates after teardown");
  assert.equal(driver._m.get(r.machineId).state, "stopped", "machine stopped");
  assert.equal(db.resolveDeployment("bot-teardown").status, "stopped", "deployment parked");
  assert.throws(() => db.getManagedRunner(alice.id, r.id), /not found|Not found/i);
});

await test("a launch failure revokes the just-minted key (no orphaned credential)", async () => {
  const boom = { launch: async () => { throw new Error("no capacity"); } };
  const before = db.listApiKeys(team.id, alice.id).filter((k) => !k.revokedAt).length;
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-failkey" }, { driver: boom });
  assert.equal(r.status, "error");
  assert.equal(r.apiKeyId, null, "no live key left on the errored runner");
  const after = db.listApiKeys(team.id, alice.id).filter((k) => !k.revokedAt).length;
  assert.equal(after, before, "net live-key count unchanged — the minted key was revoked");
});

await test("reconcile flags a ready runner whose machine has died (and parks its deployment)", async () => {
  const driver = new FakeMachinesDriver();
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-crash" }, { driver });
  assert.equal(r.status, "ready");
  driver._m.get(r.machineId).state = "stopped";   // simulate a crash
  const summary = await hosting.reconcileRunners(db, { driver });
  assert.ok(summary.failed >= 1);
  assert.equal(db.getManagedRunner(alice.id, r.id).status, "error");
  assert.equal(db.resolveDeployment("bot-crash").status, "stopped");
});

await test("reconcile with autoRestart recovers a crashed runner", async () => {
  const driver = new FakeMachinesDriver();
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-recover" }, { driver });
  driver._m.get(r.machineId).state = "error";
  const summary = await hosting.reconcileRunners(db, { driver, autoRestart: true });
  assert.ok(summary.recovered >= 1);
  assert.equal(db.getManagedRunner(alice.id, r.id).status, "ready");
  assert.equal(db.resolveDeployment("bot-recover").status, "active");
});

await test("reconcile promotes a still-provisioning runner that turned ready", async () => {
  const driver = new FakeMachinesDriver({ readyAfter: 5 });
  const r = await hosting.provision(db, { orgId: team.id, userId: alice.id, harnessId: h.id, slug: "bot-promote" }, { driver, pollMax: 1 });
  assert.equal(r.status, "provisioning");
  driver._m.get(r.machineId).state = "ready";   // it came up
  const summary = await hosting.reconcileRunners(db, { driver });
  assert.ok(summary.promoted >= 1);
  assert.equal(db.getManagedRunner(alice.id, r.id).status, "ready");
  assert.equal(db.resolveDeployment("bot-promote").status, "active");
});

await test("FlyMachinesDriver shapes the Machines REST calls correctly (fake transport)", async () => {
  const { FlyMachinesDriver } = await import("./hosting-driver.mjs");
  const calls = [];
  const http = async (method, url, { headers, json } = {}) => {
    calls.push({ method, url, headers: headers || {}, json });
    if (method === "POST" && url.endsWith("/machines")) return { id: "m-123", state: "created" };
    if (method === "GET") return { id: "m-123", state: "started" };
    return {};
  };
  const d = new FlyMachinesDriver({ app: "ergon-runners", token: "fly_tok", http });
  const launched = await d.launch({ image: "ergon/runner:2", region: "lhr", env: { ANTHROPIC_API_KEY: "x" } });
  assert.equal(launched.machineId, "m-123");
  assert.equal(launched.url, "https://ergon-runners.fly.dev");
  assert.equal(launched.state, "starting");            // fly "created" → starting
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.url, "https://api.machines.dev/v1/apps/ergon-runners/machines");
  assert.equal(post.headers.Authorization, "Bearer fly_tok");
  assert.equal(post.json.region, "lhr");
  assert.equal(post.json.config.image, "ergon/runner:2");
  assert.equal(post.json.config.env.ANTHROPIC_API_KEY, "x");
  const st = await d.status("m-123");
  assert.equal(st.state, "ready");                      // fly "started" → ready
});

console.log(`\nhosting.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
