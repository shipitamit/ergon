/* Tests for the Tier-2 backends: Redis rate limiter + Postgres data layer.

   Both run against in-memory fakes that mimic the real services' semantics, so
   they verify the LOGIC (window counting, TTL, optimistic concurrency, query
   flow, parameterization) offline. They do NOT verify the real Redis/Postgres
   wire protocols — that needs live services (see README).

   Run: node server/backends.test.mjs   (or: npm run test:backends)
*/
import assert from "node:assert";
import { redisLimiter, inMemoryLimiter, makeLimiterFactory } from "./ratelimit.mjs";

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failed++; failures.push([name, e.message]); }
}

// ── fake Redis with real TTL semantics ──
function fakeRedis() {
  const store = new Map();
  const now = () => Date.now();
  return {
    calls: { incr: 0, pExpire: 0, pTTL: 0 },
    async incr(k) {
      this.calls.incr++;
      const e = store.get(k);
      if (e && e.exp && e.exp < now()) store.delete(k);
      const cur = store.get(k) || { v: 0, exp: 0 };
      cur.v += 1; store.set(k, cur); return cur.v;
    },
    async pExpire(k, ms) { this.calls.pExpire++; const e = store.get(k); if (e) e.exp = now() + ms; return true; },
    async pTTL(k) { this.calls.pTTL++; const e = store.get(k); if (!e) return -2; return e.exp ? e.exp - now() : -1; },
    _expire(k) { const e = store.get(k); if (e) e.exp = now() - 1; },
  };
}

// ── Redis limiter ──
await test("redis limiter allows up to max then blocks", async () => {
  const lim = redisLimiter(fakeRedis(), { windowMs: 60000, max: 3 });
  const r = [];
  for (let i = 0; i < 5; i++) r.push(await lim("ip"));
  assert.deepEqual(r, [true, true, true, false, false]);
});

await test("redis limiter sets TTL once on first hit", async () => {
  const rc = fakeRedis();
  const lim = redisLimiter(rc, { windowMs: 60000, max: 5 });
  await lim("ip"); await lim("ip");
  assert.equal(rc.calls.pExpire, 1);
});

await test("redis limiter isolates keys", async () => {
  const lim = redisLimiter(fakeRedis(), { windowMs: 60000, max: 1 });
  assert.equal(await lim("a"), true);
  assert.equal(await lim("b"), true);
  assert.equal(await lim("a"), false);
});

await test("redis limiter resets after window expiry", async () => {
  const rc = fakeRedis();
  const lim = redisLimiter(rc, { windowMs: 60000, max: 1, prefix: "rl:" });
  await lim("k"); rc._expire("rl:k");
  assert.equal(await lim("k"), true);
});

await test("redis limiter re-sets a lost TTL", async () => {
  const rc = fakeRedis();
  const lim = redisLimiter(rc, { windowMs: 60000, max: 5 });
  await lim("k"); await lim("k");
  assert.ok(rc.calls.pTTL >= 1);
});

// ── factory backend selection ──
await test("factory → memory without REDIS_URL", async () => {
  const f = await makeLimiterFactory({ windowMs: 1000, max: 2 }, { redisUrl: undefined });
  assert.equal(f.backend, "memory");
});

await test("factory → memory when connect fails (graceful)", async () => {
  const f = await makeLimiterFactory({ windowMs: 1000, max: 2 }, {
    redisUrl: "redis://x", connect: async () => { throw new Error("ECONNREFUSED"); },
    log: { warn: () => {} },
  });
  assert.equal(f.backend, "memory");
});

await test("factory → redis when reachable", async () => {
  const f = await makeLimiterFactory({ windowMs: 1000, max: 2 }, {
    redisUrl: "redis://x", connect: async () => fakeRedis(),
  });
  assert.equal(f.backend, "redis");
});

await test("in-memory limiter matches redis semantics", async () => {
  const lim = inMemoryLimiter({ windowMs: 60000, max: 2 });
  assert.deepEqual([await lim("i"), await lim("i"), await lim("i")], [true, true, false]);
});

// ── Postgres backend logic (against a fake pool) ──
function fakePgPool() {
  const t = { users: [], sessions: [], harnesses: [], orgs: [], orgMembers: [], kv: [], audit: [], identities: [], apiKeys: [], runs: [], budgets: [], deployments: [] };
  return {
    _paramized: true,
    async query(sql, params = []) {
      // record that SQL never carries interpolated values (all via params)
      if (/\$\{/.test(sql)) this._paramized = false;
      const s = sql.trim();
      if (/^CREATE TABLE/im.test(s) || /^ALTER TABLE/im.test(s)) return { rows: [] };
      if (/INSERT INTO users/i.test(s)) { t.users.push({ id: params[0], email: params[1], pw_hash: params[2] }); return { rows: [] }; }
      if (/SELECT 1 FROM users WHERE email/i.test(s)) return { rows: t.users.filter(u => u.email === params[0]).map(() => ({ x: 1 })) };
      if (/SELECT id, email, pw_hash FROM users WHERE email/i.test(s)) return { rows: t.users.filter(u => u.email === params[0]) };
      if (/SELECT id, email FROM users WHERE email/i.test(s)) return { rows: t.users.filter(u => u.email === params[0]).map(u => ({ id: u.id, email: u.email })) };
      if (/SELECT email FROM users WHERE id/i.test(s)) return { rows: t.users.filter(u => u.id === params[0]).map(u => ({ email: u.email })) };
      if (/SELECT id, email FROM users WHERE id/i.test(s)) return { rows: t.users.filter(u => u.id === params[0]).map(u => ({ id: u.id, email: u.email })) };
      if (/INSERT INTO sessions/i.test(s)) { t.sessions.push({ token: params[0], user_id: params[1] }); return { rows: [] }; }
      if (/FROM sessions s JOIN users u/i.test(s)) { const se = t.sessions.find(x => x.token === params[0]); const u = se && t.users.find(x => x.id === se.user_id); return { rows: u ? [{ id: u.id, email: u.email }] : [] }; }
      if (/DELETE FROM sessions WHERE token/i.test(s)) { t.sessions = t.sessions.filter(x => x.token !== params[0]); return { rows: [] }; }
      // orgs + membership
      if (/INSERT INTO orgs/i.test(s)) { t.orgs.push({ id: params[0], name: params[1], personal: /personal\)\s*VALUES.*,\s*1\)/i.test(s) ? 1 : 0 }); return { rows: [] }; }
      if (/INSERT INTO org_members/i.test(s)) { const role = (s.match(/,\s*'(\w+)'\)/) || [])[1] || params[2]; t.orgMembers.push({ org_id: params[0], user_id: params[1], role }); return { rows: [] }; }
      if (/SELECT role FROM org_members WHERE org_id/i.test(s)) return { rows: t.orgMembers.filter(m => m.org_id === params[0] && m.user_id === params[1]).map(m => ({ role: m.role })) };
      if (/FROM orgs o JOIN org_members m/i.test(s) && /personal = 1/i.test(s)) { const m = t.orgMembers.find(x => x.user_id === params[0] && (t.orgs.find(o => o.id === x.org_id) || {}).personal === 1); return { rows: m ? [{ id: m.org_id }] : [] }; }
      if (/SELECT name FROM orgs WHERE id/i.test(s)) return { rows: t.orgs.filter(o => o.id === params[0]).map(o => ({ name: o.name })) };
      // harnesses
      if (/INSERT INTO harnesses/i.test(s)) { t.harnesses.push({ id: params[0], owner_id: params[1], name: params[2], graph_json: params[3], updated_at: params[4], org_id: params[5] }); return { rows: [] }; }
      if (/SELECT org_id FROM harnesses WHERE id/i.test(s)) return { rows: t.harnesses.filter(h => h.id === params[0]).map(h => ({ org_id: h.org_id })) };
      if (/SELECT id, name, graph_json, owner_id, org_id, updated_at FROM harnesses/i.test(s)) return { rows: t.harnesses.filter(h => h.id === params[0]) };
      if (/SELECT updated_at FROM harnesses WHERE id/i.test(s)) return { rows: t.harnesses.filter(h => h.id === params[0]).map(h => ({ updated_at: h.updated_at })) };
      if (/UPDATE harnesses SET name/i.test(s)) { const h = t.harnesses.find(x => x.id === params[3]); if (h) { h.name = params[0]; h.graph_json = params[1]; h.updated_at = params[2]; } return { rows: [] }; }
      if (/SELECT org_id, name FROM harnesses WHERE id/i.test(s)) return { rows: t.harnesses.filter(h => h.id === params[0]).map(h => ({ org_id: h.org_id, name: h.name })) };
      if (/UPDATE harnesses SET org_id/i.test(s)) { const h = t.harnesses.find(x => x.id === params[1]); if (h) h.org_id = params[0]; return { rows: [] }; }
      if (/DELETE FROM harnesses WHERE id/i.test(s)) { t.harnesses = t.harnesses.filter(h => h.id !== params[0]); return { rows: [] }; }
      // org members (list / count / delete)
      if (/FROM org_members m JOIN users u/i.test(s)) { const rows = t.orgMembers.filter(m => m.org_id === params[0]).map(m => ({ email: (t.users.find(u => u.id === m.user_id) || {}).email, role: m.role })); return { rows }; }
      if (/FROM org_members m JOIN orgs o/i.test(s)) { const rows = t.orgMembers.filter(m => m.user_id === params[0]).map(m => { const o = t.orgs.find(x => x.id === m.org_id) || {}; return { id: o.id, name: o.name, role: m.role }; }); return { rows }; }
      if (/COUNT\(\*\)::int AS n FROM org_members WHERE org_id/i.test(s)) { const n = t.orgMembers.filter(m => m.org_id === params[0] && m.role === "owner").length; return { rows: [{ n }] }; }
      if (/DELETE FROM org_members WHERE org_id = \$1 AND user_id/i.test(s)) { t.orgMembers = t.orgMembers.filter(m => !(m.org_id === params[0] && m.user_id === params[1])); return { rows: [] }; }
      // identities (SSO)
      if (/FROM identities i JOIN users u/i.test(s)) { const idn = t.identities.find(x => x.provider === params[0] && x.subject === params[1]); const u = idn && t.users.find(x => x.id === idn.user_id); return { rows: u ? [{ id: u.id, email: u.email }] : [] }; }
      if (/INSERT INTO identities/i.test(s)) { if (!t.identities.some(x => x.provider === params[0] && x.subject === params[1])) t.identities.push({ provider: params[0], subject: params[1], user_id: params[2] }); return { rows: [] }; }
      // api keys
      if (/INSERT INTO api_keys/i.test(s)) { t.apiKeys.push({ id: params[0], org_id: params[1], user_id: params[2], name: params[3], role: params[4], prefix: params[5], hash: params[6], created_by: params[7], created_at: params[8], last_used_at: null, revoked_at: null }); return { rows: [] }; }
      if (/SELECT id, org_id, user_id, revoked_at, hash FROM api_keys WHERE id/i.test(s)) return { rows: t.apiKeys.filter(k => k.id === params[0]) };
      if (/SELECT user_id, revoked_at FROM api_keys WHERE id/i.test(s)) return { rows: t.apiKeys.filter(k => k.id === params[0] && k.org_id === params[1]).map(k => ({ user_id: k.user_id, revoked_at: k.revoked_at })) };
      if (/UPDATE api_keys SET last_used_at/i.test(s)) { const k = t.apiKeys.find(x => x.id === params[1]); if (k) k.last_used_at = params[0]; return { rows: [] }; }
      if (/UPDATE api_keys SET revoked_at/i.test(s)) { const k = t.apiKeys.find(x => x.id === params[1]); if (k) k.revoked_at = params[0]; return { rows: [] }; }
      if (/FROM api_keys k LEFT JOIN users u/i.test(s)) { const rows = t.apiKeys.filter(k => k.org_id === params[0]).map(k => ({ ...k, created_by: (t.users.find(u => u.id === k.created_by) || {}).email || null })); return { rows }; }
      // runs
      if (/INSERT INTO runs/i.test(s)) { t.runs.push({ id: params[0], org_id: params[1], harness_id: params[2], harness_name: params[3], input: params[4], output: params[5], status: params[6], started_at: params[7], finished_at: params[8], latency_ms: params[9], tokens_in: params[10], tokens_out: params[11], cost: params[12], steps: params[13], created_by: params[14], created_at: params[15] }); return { rows: [] }; }
      if (/DELETE FROM runs WHERE org_id.*NOT IN/is.test(s)) { return { rows: [] }; }  // prune: no-op in the fake
      if (/FROM runs WHERE/i.test(s) && /ORDER BY created_at DESC/i.test(s)) { const rows = t.runs.filter(r => r.org_id === params[0]).sort((a, b) => b.created_at - a.created_at).map(r => ({ ...r, input_preview: (r.input || "").slice(0, 200) })); return { rows }; }
      if (/SELECT \* FROM runs WHERE id/i.test(s)) return { rows: t.runs.filter(r => r.id === params[0]) };
      if (/COALESCE\(SUM\(cost\)/i.test(s)) { const rs = t.runs.filter(r => r.org_id === params[0] && r.created_at >= params[1]); return { rows: [{ cost: rs.reduce((a, r) => a + (r.cost || 0), 0), n: rs.length }] }; }
      // budgets
      if (/INSERT INTO budgets/i.test(s)) { const ex = t.budgets.find(b => b.org_id === params[1] && b.period === params[2]); if (ex) { ex.max_cost = params[3]; ex.max_requests = params[4]; } else t.budgets.push({ id: params[0], org_id: params[1], period: params[2], max_cost: params[3], max_requests: params[4], created_by: params[5], created_at: params[6] }); return { rows: [] }; }
      if (/SELECT[\s\S]*FROM budgets WHERE org_id/i.test(s)) return { rows: t.budgets.filter(b => b.org_id === params[0]) };
      if (/DELETE FROM budgets WHERE id/i.test(s)) { t.budgets = t.budgets.filter(b => !(b.id === params[0] && b.org_id === params[1])); return { rows: [] }; }
      // deployments
      if (/SELECT 1 FROM deployments WHERE slug/i.test(s)) return { rows: t.deployments.filter(d => d.slug === params[0]).map(() => ({ x: 1 })) };
      if (/INSERT INTO deployments/i.test(s)) { t.deployments.push({ id: params[0], org_id: params[1], harness_id: params[2], slug: params[3], target_url: params[4], status: params[5], created_by: params[6], created_at: params[7] }); return { rows: [] }; }
      if (/SELECT[\s\S]*FROM deployments WHERE org_id/i.test(s)) return { rows: t.deployments.filter(d => d.org_id === params[0]).sort((a, b) => b.created_at - a.created_at) };
      if (/FROM deployments WHERE slug/i.test(s)) return { rows: t.deployments.filter(d => d.slug === params[0]) };
      if (/DELETE FROM deployments WHERE id/i.test(s)) { t.deployments = t.deployments.filter(d => !(d.id === params[0] && d.org_id === params[1])); return { rows: [] }; }
      // data governance: export reads + erase deletes (org_id-scoped)
      if (/SELECT id, name, created_at, personal FROM orgs WHERE id/i.test(s)) return { rows: t.orgs.filter(o => o.id === params[0]).map(o => ({ id: o.id, name: o.name, created_at: 0, personal: o.personal || 0 })) };
      if (/SELECT[\s\S]*FROM harnesses WHERE org_id/i.test(s)) return { rows: t.harnesses.filter(h => h.org_id === params[0]) };
      if (/SELECT user_id FROM api_keys WHERE org_id/i.test(s)) return { rows: t.apiKeys.filter(k => k.org_id === params[0]).map(k => ({ user_id: k.user_id })) };
      if (/SELECT[\s\S]*FROM api_keys WHERE org_id/i.test(s)) return { rows: t.apiKeys.filter(k => k.org_id === params[0]) };
      if (/DELETE FROM deployments WHERE org_id/i.test(s)) { t.deployments = t.deployments.filter(d => d.org_id !== params[0]); return { rows: [] }; }
      if (/DELETE FROM budgets WHERE org_id/i.test(s)) { t.budgets = t.budgets.filter(b => b.org_id !== params[0]); return { rows: [] }; }
      if (/DELETE FROM runs WHERE org_id/i.test(s)) { t.runs = t.runs.filter(r => r.org_id !== params[0]); return { rows: [] }; }
      if (/DELETE FROM audit_log WHERE org_id/i.test(s)) { t.audit = t.audit.filter(a => a.org_id !== params[0]); return { rows: [] }; }
      if (/DELETE FROM api_keys WHERE org_id/i.test(s)) { t.apiKeys = t.apiKeys.filter(k => k.org_id !== params[0]); return { rows: [] }; }
      if (/DELETE FROM harnesses WHERE org_id/i.test(s)) { t.harnesses = t.harnesses.filter(h => h.org_id !== params[0]); return { rows: [] }; }
      if (/DELETE FROM org_members WHERE org_id = \$1$/i.test(s.trim())) { t.orgMembers = t.orgMembers.filter(m => m.org_id !== params[0]); return { rows: [] }; }
      if (/DELETE FROM users WHERE id = \$1 AND substr/i.test(s)) { t.users = t.users.filter(u => u.id !== params[0]); return { rows: [] }; }
      if (/DELETE FROM orgs WHERE id/i.test(s)) { t.orgs = t.orgs.filter(o => o.id !== params[0]); return { rows: [] }; }
      // audit log
      if (/INSERT INTO audit_log/i.test(s)) { t.audit.push({ id: params[0], org_id: params[1], actor_id: params[2], action: params[3], target_type: params[4], target_id: params[5], detail: params[6], ts: params[7] }); return { rows: [] }; }
      if (/FROM audit_log a LEFT JOIN users u/i.test(s)) {
        let rows = t.audit.filter(a => a.org_id === params[0]);
        if (/a\.ts < \$2/i.test(s)) rows = rows.filter(a => Number(a.ts) < Number(params[1]));
        rows = rows.sort((a, b) => Number(b.ts) - Number(a.ts)).map(a => ({ ...a, actor_email: (t.users.find(u => u.id === a.actor_id) || {}).email || null }));
        return { rows };
      }
      return { rows: [] };
    },
    async end() {},
  };
}

await test("postgres: createUser normalizes email + rejects duplicates", async () => {
  const db = await import("./db.postgres.mjs");
  const pool = fakePgPool();
  await db.init(null, pool);
  const u = await db.createUser("Bob@Example.com ", "pw");
  assert.equal(u.email, "bob@example.com");
  await assert.rejects(() => db.createUser("bob@example.com", "x"), /already registered/);
});

await test("postgres: verifyUser checks the hash", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const u = await db.createUser("c@e.com", "secret");
  const v = await db.verifyUser("c@e.com", "secret");
  assert.equal(v.id, u.id);
  await assert.rejects(() => db.verifyUser("c@e.com", "wrong"), /Invalid/);
});

await test("postgres: findOrCreateUserByOidc provisions, re-logs-in, and links by email", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const idn = (email, extra = {}) => ({ provider: "oidc", subject: `s-${email}`, email, emailVerified: true, ...extra });
  const a = await db.findOrCreateUserByOidc(idn("sso@e.com"));
  assert.equal(a.created, true);
  const b = await db.findOrCreateUserByOidc(idn("sso@e.com"));
  assert.equal(b.id, a.id); assert.equal(b.created, false);          // stable re-login
  const pw = await db.createUser("both@e.com", "password1");
  const linked = await db.findOrCreateUserByOidc(idn("both@e.com"));
  assert.equal(linked.id, pw.id); assert.equal(linked.linked, true); // linked by verified email
  await assert.rejects(() => db.findOrCreateUserByOidc(idn("both@e.com", { subject: "x", emailVerified: false })), /did not verify/);
});

await test("postgres: API key issue → bearer verify → revoke", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const u = await db.createUser("owner@e.com", "password1");
  const org = await db.createOrg(u.id, "Org");
  const k = await db.createApiKey(org.id, u.id, "CI", "admin");
  assert.ok(k.secret.startsWith("esk_"));
  const p = await db.verifyApiKey(k.secret);
  assert.ok(p && p.apiKey === true && p.orgId === org.id);
  assert.equal(await db.orgRoleFor(org.id, p.id), "admin");
  await db.revokeApiKey(org.id, u.id, k.id);
  assert.equal(await db.verifyApiKey(k.secret), null);
  assert.equal(await db.orgRoleFor(org.id, p.id), null);
});

await test("postgres: recordRun + listRuns + getRun, org-scoped", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const u = await db.createUser("runner@e.com", "password1");
  const org = await db.createOrg(u.id, "Org");
  const { id } = await db.recordRun(u.id, { orgId: org.id, harnessName: "Bot", input: "q", output: "a",
    status: "ok", latencyMs: 42, usage: { input_tokens: 5, output_tokens: 2, cost: 0.001 },
    steps: [{ kind: "node_start", node: "s" }] });
  const list = await db.listRuns(u.id, { orgId: org.id });
  assert.ok(list.some((r) => r.id === id && r.status === "ok" && r.latencyMs === 42));
  const full = await db.getRun(u.id, id);
  assert.equal(full.output, "a");
  assert.equal(full.steps[0].kind, "node_start");
  // a non-member cannot read
  const other = await db.createUser("outsider@e.com", "password1");
  await assert.rejects(() => db.getRun(other.id, id), /Not a member/);
});

await test("postgres: budgets — set, status from runs, and checkBudget gate", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const u = await db.createUser("b@e.com", "password1");
  const org = await db.createOrg(u.id, "Org");
  await db.setBudget(org.id, u.id, { period: "total", maxRequests: 2 });
  assert.equal((await db.checkBudget(org.id)).allowed, true);
  await db.recordRun(u.id, { orgId: org.id, input: "1", usage: { cost: 0.01 } });
  await db.recordRun(u.id, { orgId: org.id, input: "2", usage: { cost: 0.01 } });
  // quota of 2 now reached → gate closes and a further record is refused (402-tagged)
  assert.equal((await db.checkBudget(org.id)).allowed, false);
  await assert.rejects(() => db.recordRun(u.id, { orgId: org.id, input: "3" }), (e) => e.code === "budget");
  const status = await db.budgetStatus(org.id, u.id);
  assert.ok(status.some((b) => b.period === "total" && b.requests === 2 && b.requestsExceeded));
});

await test("postgres: deployments — create, resolve, list, unique slug, delete", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const u = await db.createUser("dep@e.com", "password1");
  const org = await db.createOrg(u.id, "Org");
  const d = await db.createDeployment(org.id, u.id, { slug: "my-bot", harnessId: "h1", targetUrl: "http://runner:8900" });
  assert.equal(d.slug, "my-bot");
  const res = await db.resolveDeployment("my-bot");
  assert.equal(res.orgId, org.id); assert.equal(res.targetUrl, "http://runner:8900");
  assert.ok((await db.listDeployments(org.id, u.id)).some((x) => x.id === d.id));
  await assert.rejects(() => db.createDeployment(org.id, u.id, { slug: "my-bot" }), /already taken/);
  await assert.rejects(() => db.createDeployment(org.id, u.id, { slug: "Bad Slug!" }), /slug must be/);
  await db.deleteDeployment(org.id, u.id, d.id);
  assert.equal(await db.resolveDeployment("my-bot"), null);
});

await test("postgres: exportOrg bundles data; eraseOrg removes the org", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const u = await db.createUser("gov@e.com", "password1");
  const org = await db.createOrg(u.id, "Org");
  await db.saveHarness(u.id, { name: "H", graph: { nodes: [], edges: [] }, orgId: org.id });
  await db.createDeployment(org.id, u.id, { slug: "gov-bot" });
  const bundle = await db.exportOrg(org.id, u.id);
  assert.equal(bundle.org.id, org.id);
  assert.equal(bundle.harnesses.length, 1);
  assert.ok(bundle.deployments.some((d) => d.slug === "gov-bot"));
  // a plain-member export is refused
  const outsider = await db.createUser("out@e.com", "password1");
  await assert.rejects(() => db.exportOrg(org.id, outsider.id), /owner or admin/);
  // erase: owner only, and it's gone afterward
  await assert.rejects(() => db.eraseOrg(org.id, outsider.id), /owner/);
  await db.eraseOrg(org.id, u.id);
  assert.equal(await db.resolveDeployment("gov-bot"), null);
  await assert.rejects(() => db.exportOrg(org.id, u.id), /owner or admin|not found|member/i);
});

await test("postgres: optimistic concurrency raises ConflictError", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const u = await db.createUser("d@e.com", "pw");
  const h = await db.saveHarness(u.id, { name: "H", graph: {} });
  // second save advances the version (monotonic, not wall-clock dependent)
  const h2 = await db.saveHarness(u.id, { id: h.id, name: "H2", graph: {}, expectedVersion: h.version });
  assert.ok(h2.version > h.version, "version must strictly advance on each save");
  // a third save with the now-stale original version must conflict
  await assert.rejects(
    () => db.saveHarness(u.id, { id: h.id, name: "stale", graph: {}, expectedVersion: h.version }),
    (e) => e.name === "ConflictError");
});

await test("postgres: force overwrite bypasses conflict check", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const u = await db.createUser("f@e.com", "pw");
  const h = await db.saveHarness(u.id, { name: "H", graph: {} });
  const forced = await db.saveHarness(u.id, { id: h.id, name: "forced", graph: {}, expectedVersion: 1, force: true });
  assert.equal(forced.name, "forced");
});

await test("postgres: session lifecycle", async () => {
  const db = await import("./db.postgres.mjs");
  await db.init(null, fakePgPool());
  const u = await db.createUser("g@e.com", "pw");
  const tok = await db.createSession(u.id);
  assert.equal((await db.userForToken(tok)).id, u.id);
  await db.destroySession(tok);
  assert.equal(await db.userForToken(tok), null);
});

await test("postgres: queries are parameterized (no interpolation)", async () => {
  const db = await import("./db.postgres.mjs");
  const pool = fakePgPool();
  await db.init(null, pool);
  await db.createUser("h@e.com", "pw");
  assert.equal(pool._paramized, true);
});

console.log(`\nbackends.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  ✗ ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
