/* Live-Postgres integration smoke — the end-to-end data flow against a REAL
   Postgres (not the fake-pool parity in backends.test.mjs). It drives the whole
   collaboration surface through db.postgres.mjs and asserts the results, so the
   live wire (real types, constraints, transactions) is verified.

   Runs only when DATABASE_URL points at a Postgres; without it, it prints a
   skip and exits 0 — safe in the offline suite. CI (.github/workflows/pg-it.yml)
   sets DATABASE_URL to a service container and runs it on every push.

     DATABASE_URL=postgres://ergon:ergon@localhost:5432/ergon node server/pg_smoke.mjs
*/
import assert from "node:assert";

const url = process.env.DATABASE_URL;
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.log("pg_smoke: skipped (set DATABASE_URL to a Postgres to run the live integration test)");
  process.exit(0);
}

const db = await import("./db.postgres.mjs");
await db.init(url);                        // creates the schema (CREATE TABLE IF NOT EXISTS)

let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const uniq = `pg_${Date.now()}`;
const email = `${uniq}@example.com`;

try {
  console.log("pg_smoke: live Postgres integration");

  let owner, org, h, key, dep;
  await step("createUser + personal org", async () => {
    owner = await db.createUser(email, "password1");
    assert.ok(owner.id);
    assert.ok((await db.listOrgs(owner.id)).length >= 1);
  });

  await step("createOrg + membership role", async () => {
    org = await db.createOrg(owner.id, `Org ${uniq}`);
    assert.equal(await db.orgRoleFor(org.id, owner.id), "owner");
  });

  await step("saveHarness + getHarness (role = edit)", async () => {
    h = await db.saveHarness(owner.id, { name: "Bot", graph: { nodes: [{ id: "a" }], edges: [] }, orgId: org.id });
    const got = await db.getHarness(h.id, owner.id);
    assert.equal(got.role, "edit");
    assert.deepEqual(got.graph.nodes, [{ id: "a" }]);
  });

  await step("optimistic concurrency conflict", async () => {
    const v = (await db.getHarness(h.id, owner.id)).version;
    await db.saveHarness(owner.id, { id: h.id, name: "Bot v2", graph: {}, expectedVersion: v });
    await assert.rejects(() => db.saveHarness(owner.id, { id: h.id, name: "stale", graph: {}, expectedVersion: v }),
      (e) => e.name === "ConflictError");
  });

  await step("recordRun + listRuns + getRun", async () => {
    const { id } = await db.recordRun(owner.id, { harnessId: h.id, input: "hi", output: "ok", status: "ok",
      latencyMs: 12, usage: { input_tokens: 5, output_tokens: 2, cost: 0.001 }, steps: [{ kind: "node_start" }] });
    assert.ok((await db.listRuns(owner.id, { orgId: org.id })).some((r) => r.id === id));
    assert.equal((await db.getRun(owner.id, id)).output, "ok");
  });

  await step("audit log records mutations", async () => {
    const log = await db.listAudit(org.id, owner.id, { limit: 100 });
    assert.ok(log.some((e) => e.action === "org.create"));
    assert.ok(log.some((e) => e.action === "harness.create"));
  });

  await step("API key issue → bearer verify → revoke", async () => {
    key = await db.createApiKey(org.id, owner.id, "CI", "admin");
    const p = await db.verifyApiKey(key.secret);
    assert.ok(p && p.orgId === org.id);
    await db.revokeApiKey(org.id, owner.id, key.id);
    assert.equal(await db.verifyApiKey(key.secret), null);
  });

  await step("budget gate closes run admission (402-tagged)", async () => {
    await db.setBudget(org.id, owner.id, { period: "total", maxRequests: 1 });
    // one run already recorded above → quota met → next record refused
    await assert.rejects(() => db.recordRun(owner.id, { orgId: org.id, input: "over" }),
      (e) => e.code === "budget");
    const bud = (await db.listBudgets(org.id, owner.id)).find((b) => b.period === "total");
    await db.deleteBudget(org.id, owner.id, bud.id);
  });

  await step("deployment register + resolve + delete", async () => {
    dep = await db.createDeployment(org.id, owner.id, { slug: `dep-${uniq}`, harnessId: h.id, targetUrl: "http://runner:8900" });
    const r = await db.resolveDeployment(dep.slug);
    assert.equal(r.orgId, org.id);
    await db.deleteDeployment(org.id, owner.id, dep.id);
    assert.equal(await db.resolveDeployment(dep.slug), null);
  });

  await step("comments: post → list → resolve → delete", async () => {
    const c = await db.createComment(h.id, owner.id, { nodeId: "a", body: "looks good" });
    assert.ok(c.id && c.resolved === false && c.authorEmail === email);
    assert.ok((await db.listComments(h.id, owner.id)).some((x) => x.id === c.id));
    await db.resolveComment(c.id, owner.id, true);
    assert.equal((await db.listComments(h.id, owner.id)).find((x) => x.id === c.id).resolved, true);
    await db.deleteComment(c.id, owner.id);
    assert.ok((await db.listComments(h.id, owner.id)).every((x) => x.id !== c.id));
  });

  await step("export bundles data; erase removes the org", async () => {
    const bundle = await db.exportOrg(org.id, owner.id);
    assert.equal(bundle.org.id, org.id);
    assert.ok(bundle.harnesses.length >= 1);
    assert.ok(!JSON.stringify(bundle).includes('"hash"'));
    await db.eraseOrg(org.id, owner.id);
    await assert.rejects(() => db.getHarness(h.id, owner.id), /not found|not in one/i);
  });

  console.log(`\npg_smoke: ${passed} steps passed on live Postgres`);
  await db._close?.();
  process.exit(0);
} catch (e) {
  console.error(`\npg_smoke FAILED after ${passed} steps:`, e.message);
  try { await db._close?.(); } catch { /* ignore */ }
  process.exit(1);
}
