/* Over-HTTP integration test of the collaboration tier.

   Boots the REAL proxy.mjs (which lazily loads the real routes.mjs + db.mjs)
   on an ephemeral port and drives the whole signed-in flow with fetch —
   signup, cookie sessions, harness save, sharing, role enforcement, kv
   isolation — exercising the actual HTTP routes, cookies, and access checks,
   not just the data-layer functions.

   Uses an in-memory DB and the built-in node:sqlite / scrypt fallbacks, so it
   runs with zero external dependencies:  node server/auth.test.mjs
*/
import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;

/* a fetch that carries cookies per "browser" (account) */
function makeClient() {
  let cookie = "";
  return async (method, urlPath, body) => {
    const res = await fetch(BASE + urlPath, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setC = res.headers.get("set-cookie");
    if (setC) cookie = setC.split(";")[0];   // keep the af_session=… pair
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json, cookie };
  };
}

/* a fetch that authenticates with an Authorization: Bearer <key> header */
async function bearer(method, urlPath, token, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json };
}

async function waitForServer(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + "/api/auth/me"); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

let failures = 0;
const check = (name, cond) => { if (cond) console.log(`  ✓ ${name}`); else { console.log(`  ✗ ${name}`); failures++; } };

const server = spawn(process.execPath, [path.join(HERE, "proxy.mjs")], {
  env: { ...process.env, PORT: String(PORT), ERGON_DB: ":memory:", NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => { if (/enabled|listening/.test(String(d))) process.stdout.write(`  [server] ${String(d).trim()}\n`); });
server.stderr.on("data", (d) => process.stderr.write(`  [server:err] ${d}`));

try {
  await waitForServer();
  console.log("Signed-in flow over HTTP:");

  const alice = makeClient();
  const bob = makeClient();

  // ── auth ──
  let r = await alice("GET", "/api/auth/me");
  check("me is null before signup", r.status === 200 && r.json.user === null);

  // SSO is advertised off (no OIDC_* env) and its routes decline cleanly
  r = await alice("GET", "/api/auth/providers");
  check("providers reports password on, sso off", r.status === 200 && r.json.password === true && r.json.sso === false);
  r = await alice("GET", "/api/auth/sso/login");
  check("sso/login 404 when unconfigured", r.status === 404);

  r = await alice("POST", "/api/auth/signup", { email: "alice@example.com", password: "supersecret" });
  check("alice signup 200 + user", r.status === 200 && r.json.user?.email === "alice@example.com");
  check("alice got a session cookie", r.cookie.startsWith("af_session="));

  r = await alice("GET", "/api/auth/me");
  check("me reflects signed-in alice", r.json.user?.email === "alice@example.com");

  r = await alice("POST", "/api/auth/signup", { email: "alice@example.com", password: "supersecret" });
  check("duplicate email rejected", r.status === 400);

  r = await bob("POST", "/api/auth/signup", { email: "bob@example.com", password: "hunter2pw" });
  check("bob signup 200", r.status === 200);

  // wrong password path (fresh client)
  const stranger = makeClient();
  r = await stranger("POST", "/api/auth/login", { email: "alice@example.com", password: "wrong" });
  check("bad password rejected", r.status === 400);
  r = await stranger("GET", "/api/harnesses");
  check("unauth harness list 401", r.status === 401);

  // ── harness save (alice) ──
  r = await alice("POST", "/api/harnesses", { name: "Support Bot", graph: { version: 2, nodes: [{ id: "i", type: "input" }], edges: [] } });
  check("alice saves harness", r.status === 200 && r.json.harness?.id);
  const hid = r.json.harness.id;
  check("creator gets edit role on save", r.json.harness.role === "edit");

  r = await alice("GET", "/api/harnesses");
  check("alice lists her harness", r.status === 200 && r.json.harnesses.some((h) => h.id === hid));

  // ── access control: bob is in none of alice's orgs ──
  r = await bob("GET", `/api/harnesses/${hid}`);
  check("bob cannot read a harness outside his orgs", r.status === 400);
  r = await bob("POST", "/api/harnesses", { id: hid, name: "hijack", graph: { nodes: [], edges: [] } });
  check("bob cannot edit it", r.status === 400);
  r = await bob("DELETE", `/api/harnesses/${hid}`);
  check("bob cannot delete it", r.status === 400);

  // ── put the harness in an org, add bob as a member (view) ──
  r = await alice("POST", "/api/orgs", { name: "Acme" });
  check("alice creates an org", r.status === 200 && r.json.org?.id);
  const oid = r.json.org.id;
  r = await alice("POST", `/api/harnesses/${hid}/org`, { orgId: oid });
  check("alice assigns the harness to the org", r.status === 200 && r.json.harness.orgId === oid);
  r = await alice("POST", `/api/orgs/${oid}/members`, { email: "bob@example.com", role: "member" });
  check("alice adds bob as member", r.status === 200 && r.json.members.some((m) => m.email === "bob@example.com" && m.role === "member"));

  r = await bob("GET", `/api/harnesses/${hid}`);
  check("member bob can read (view)", r.status === 200 && r.json.harness.role === "view");
  r = await bob("POST", "/api/harnesses", { id: hid, name: "still no", graph: { nodes: [], edges: [] } });
  check("member cannot edit", r.status === 400);
  r = await bob("DELETE", `/api/harnesses/${hid}`);
  check("member cannot delete", r.status === 400);

  // adding a non-existent account is rejected
  r = await alice("POST", `/api/orgs/${oid}/members`, { email: "ghost@example.com", role: "member" });
  check("add unknown email rejected", r.status === 400);
  // a member cannot manage membership
  r = await bob("POST", `/api/orgs/${oid}/members`, { email: "alice@example.com", role: "admin" });
  check("member cannot manage membership", r.status === 400);

  // ── promote bob to admin → he can edit ──
  r = await alice("POST", `/api/orgs/${oid}/members`, { email: "bob@example.com", role: "admin" });
  check("alice promotes bob to admin", r.json.members.some((m) => m.email === "bob@example.com" && m.role === "admin"));

  r = await bob("POST", "/api/harnesses", { id: hid, name: "Edited by Bob", graph: { version: 2, nodes: [{ id: "i", type: "input" }, { id: "a", type: "agent" }], edges: [] } });
  check("admin can save", r.status === 200);
  r = await alice("GET", `/api/harnesses/${hid}`);
  check("owner sees bob's edit", r.json.harness.name === "Edited by Bob");

  // ── collaboration: node comments + presence ──
  r = await bob("POST", `/api/harnesses/${hid}/comments`, { nodeId: "a", body: "tighten this prompt" });
  check("member posts a node comment", r.status === 200 && r.json.comment?.id && r.json.comment.authorEmail === "bob@example.com");
  const cmtId = r.json.comment.id;
  r = await alice("GET", `/api/harnesses/${hid}/comments`);
  check("owner sees the comment on the shared harness", r.status === 200 && r.json.comments.some((c) => c.id === cmtId && c.nodeId === "a"));
  r = await alice("POST", `/api/harnesses/${hid}/comments`, { body: "" });
  check("empty comment rejected", r.status === 400);
  r = await alice("PATCH", `/api/harnesses/${hid}/comments/${cmtId}`, { resolved: true });
  check("editor resolves a comment", r.status === 200 && r.json.comment.resolved === true);
  r = await bob("DELETE", `/api/harnesses/${hid}/comments/${cmtId}`);
  check("author deletes their own comment", r.status === 200 && r.json.deleted === true);
  r = await stranger("GET", `/api/harnesses/${hid}/comments`);
  check("an outsider cannot read comments", r.status === 401 || r.status === 400);
  // presence: alice announces herself on node 'a'; bob's heartbeat sees her
  r = await alice("POST", `/api/harnesses/${hid}/presence`, { selection: "a" });
  check("presence heartbeat returns a viewer list", r.status === 200 && Array.isArray(r.json.viewers));
  r = await bob("POST", `/api/harnesses/${hid}/presence`, { selection: "i" });
  check("bob sees alice present on node 'a'", r.json.viewers.some((v) => v.email === "alice@example.com" && v.selection === "a"));

  // ── kv isolation (server-side sessions) ──
  await alice("POST", "/api/kv", { key: "ergon:1", value: "aliceRun" });
  await bob("POST", "/api/kv", { key: "ergon:1", value: "bobRun" });
  r = await alice("GET", "/api/kv?key=ergon:1");
  check("alice kv is hers", r.json.value === "aliceRun");
  r = await bob("GET", "/api/kv?key=ergon:1");
  check("bob kv is his (isolated)", r.json.value === "bobRun");
  r = await alice("GET", "/api/kv?prefix=ergon:");
  check("kv list scoped to owner", r.json.keys.length === 1 && r.json.keys[0] === "ergon:1");

  // ── removing bob from the org revokes access ──
  r = await alice("DELETE", `/api/orgs/${oid}/members`, { email: "bob@example.com" });
  check("alice removes bob", Array.isArray(r.json.members) && !r.json.members.some((m) => m.email === "bob@example.com"));
  r = await bob("GET", `/api/harnesses/${hid}`);
  check("bob loses access after removal", r.status === 400);

  // ── concurrent-save guard (optimistic concurrency) ──
  // alice re-logs-in fresh, both alice2 and bob (edit) load the same version
  const alice3 = makeClient();
  await alice3("POST", "/api/auth/login", { email: "alice@example.com", password: "supersecret" });
  r = await alice3("POST", "/api/harnesses", { name: "Concurrent", graph: { version: 2, nodes: [], edges: [] } });
  const chid = r.json.harness.id;
  const v0 = r.json.harness.updated_at;
  check("save returns a version (updated_at)", typeof v0 === "number");
  // give bob edit via an org (admin)
  r = await alice3("POST", "/api/orgs", { name: "Concurrent Co" });
  const coid = r.json.org.id;
  await alice3("POST", `/api/harnesses/${chid}/org`, { orgId: coid });
  await alice3("POST", `/api/orgs/${coid}/members`, { email: "bob@example.com", role: "admin" });

  // both load v0
  r = await bob("GET", `/api/harnesses/${chid}`);
  const bobV = r.json.harness.updated_at;
  check("bob loaded same version", bobV === v0);

  // alice saves first with correct version → succeeds, version advances
  await new Promise((res) => setTimeout(res, 2));   // ensure a distinct timestamp
  r = await alice3("POST", "/api/harnesses", { id: chid, name: "Alice edit", graph: { version: 2, nodes: [{ id: "a", type: "agent" }], edges: [] }, expectedVersion: v0 });
  check("alice save with current version succeeds", r.status === 200 && r.json.harness.updated_at !== v0);
  const v1 = r.json.harness.updated_at;

  // bob now saves with the STALE version → 409 conflict, carries current
  r = await bob("POST", "/api/harnesses", { id: chid, name: "Bob edit", graph: { version: 2, nodes: [], edges: [] }, expectedVersion: bobV });
  check("bob stale save is 409 conflict", r.status === 409 && r.json.conflict === true);
  check("conflict payload carries current harness", r.json.current?.name === "Alice edit" && r.json.current?.updated_at === v1);

  // bob resolves by force-overwriting → succeeds
  r = await bob("POST", "/api/harnesses", { id: chid, name: "Bob forced", graph: { version: 2, nodes: [], edges: [] }, force: true });
  check("bob force-overwrite succeeds", r.status === 200 && r.json.harness.name === "Bob forced");

  // a save with no expectedVersion (e.g. first-time client) is allowed (not a conflict)
  r = await alice3("POST", "/api/harnesses", { id: chid, name: "Alice no-version", graph: { version: 2, nodes: [], edges: [] } });
  check("save without expectedVersion is allowed", r.status === 200);

  // clean up
  await alice3("DELETE", `/api/harnesses/${chid}`);

  // ── service accounts / API keys (bearer auth) ──
  // a fresh harness alice owns; bind the keys to whichever org it landed in
  r = await alice("POST", "/api/harnesses", { name: "Keyed", graph: { nodes: [], edges: [] } });
  const khid = r.json.harness.id;
  const aliceOrg = r.json.harness.orgId;
  r = await alice("POST", `/api/orgs/${aliceOrg}/keys`, { name: "CI", role: "member" });
  check("owner creates a read key (secret returned once)", r.status === 200 && r.json.key.secret.startsWith("esk_"));
  const readTok = r.json.key.secret;
  r = await alice("POST", `/api/orgs/${aliceOrg}/keys`, { name: "Deployer", role: "admin" });
  const writeTok = r.json.key.secret;

  r = await bearer("GET", "/api/harnesses", readTok);
  check("bearer key lists org harnesses", r.status === 200 && r.json.harnesses.some((h) => h.id === khid));
  r = await bearer("GET", `/api/harnesses/${khid}`, readTok);
  check("read key gets view role", r.status === 200 && r.json.harness.role === "view");
  r = await bearer("POST", "/api/harnesses", readTok, { id: khid, name: "nope", graph: {} });
  check("read key cannot save", r.status === 400);
  r = await bearer("POST", "/api/harnesses", writeTok, { id: khid, name: "by key", graph: {} });
  check("write key can save", r.status === 200 && r.json.harness.name === "by key");

  // keys are confined to data routes — never org administration
  r = await bearer("GET", `/api/orgs/${aliceOrg}/members`, writeTok);
  check("key blocked from org admin routes (403)", r.status === 403);
  // collaboration is a human surface — API keys may not comment or announce presence
  r = await bearer("GET", `/api/harnesses/${khid}/comments`, writeTok);
  check("key blocked from comments (403)", r.status === 403);
  r = await bearer("POST", `/api/harnesses/${khid}/presence`, writeTok, { selection: "x" });
  check("key blocked from presence (403)", r.status === 403);

  // ── run history: record via cookie + via bearer key, then read back ──
  r = await alice("POST", "/api/runs", { harnessId: khid, harnessName: "Keyed", input: "hi there",
    output: "ok", status: "ok", latencyMs: 12, usage: { input_tokens: 4, output_tokens: 1, cost: 0.0 },
    steps: [{ kind: "node_start", node: "a" }] });
  check("cookie user records a run", r.status === 200 && !!r.json.id);
  const runId = r.json.id;
  // a write key may record a run (served/automated runs)
  r = await bearer("POST", "/api/runs", writeTok, { harnessId: khid, input: "via key", output: "done", status: "ok" });
  check("bearer key records a run", r.status === 200 && !!r.json.id);
  r = await alice("GET", `/api/runs?orgId=${aliceOrg}`);
  check("runs list is org-scoped and newest-first", r.status === 200 && r.json.runs.length >= 2
        && r.json.runs[0].createdAt >= r.json.runs[1].createdAt);
  r = await alice("GET", `/api/runs/${runId}`);
  check("run detail carries steps + output", r.status === 200 && r.json.run.output === "ok"
        && r.json.run.steps.length === 1);
  // a read key stays confined to harness/kv/runs; it may read runs but not org admin
  r = await bearer("GET", `/api/runs?orgId=${aliceOrg}`, readTok);
  check("read key can list runs", r.status === 200);

  // ── budgets: a tiny quota, then run-admission is refused with 402 ──
  r = await alice("POST", `/api/orgs/${aliceOrg}/budgets`, { period: "total", maxRequests: 1 });
  check("owner sets a request quota", r.status === 200 && r.json.budgets.some((b) => b.maxRequests === 1));
  // one run already recorded above (>=1) → the quota is met, next record is 402
  r = await alice("POST", "/api/runs", { harnessId: khid, input: "over", output: "x", status: "ok" });
  check("run admission refused over budget (402)", r.status === 402 && r.json.budget === true);
  r = await alice("GET", `/api/orgs/${aliceOrg}/budgets/status`);
  check("budget status reports the quota exceeded", r.status === 200 && r.json.status.some((b) => b.requestsExceeded));
  // clear the budget so later checks are unaffected
  const budId = (await alice("GET", `/api/orgs/${aliceOrg}/budgets`)).json.budgets[0].id;
  await alice("DELETE", `/api/orgs/${aliceOrg}/budgets/${budId}`);

  // ── hosted control plane: register a deployment, then hit the gateway ──
  r = await alice("POST", `/api/orgs/${aliceOrg}/deployments`, { slug: "alice-bot", harnessId: khid });
  check("owner registers a deployment", r.status === 200 && r.json.deployment.slug === "alice-bot");
  r = await alice("GET", `/api/orgs/${aliceOrg}/deployments`);
  check("deployment is listed", r.status === 200 && r.json.deployments.some((d) => d.slug === "alice-bot"));
  // gateway without a key → 401
  r = await makeClient()("POST", "/api/gw/alice-bot/run", { input: "hi" });
  check("gateway without a key is 401", r.status === 401);
  // gateway with the write key, no runner attached → 503 (auth + policy passed)
  r = await bearer("POST", "/api/gw/alice-bot/run", writeTok, { input: "hi" });
  check("gateway key-auths then 503 (no runner attached)", r.status === 503);
  // a key for a different org is rejected on the gateway
  const otherOrg = (await alice("POST", "/api/orgs", { name: "Other" })).json.org.id;
  const otherKey = (await alice("POST", `/api/orgs/${otherOrg}/keys`, { name: "k", role: "member" })).json.key.secret;
  r = await bearer("POST", "/api/gw/alice-bot/run", otherKey, { input: "hi" });
  check("gateway rejects a key from another org (403)", r.status === 403);

  // ── triggers: management (auth) + public webhook ingress (tokened) ──
  // khid has a deployment ('alice-bot') but no target_url, so a fire is a clean no-runner.
  r = await alice("POST", `/api/harnesses/${khid}/triggers`, { type: "webhook" });
  check("owner creates a webhook trigger (token minted)", r.status === 200 && r.json.trigger.type === "webhook" && !!r.json.trigger.token);
  const hookTok = r.json.trigger.token;
  r = await alice("POST", `/api/harnesses/${khid}/triggers`, { type: "schedule", cron: "nope" });
  check("invalid cron is rejected", r.status === 400);
  r = await alice("POST", `/api/harnesses/${khid}/triggers`, { type: "schedule", cron: "0 9 * * *", payload: "daily" });
  check("owner creates a schedule trigger (next fire set)", r.status === 200 && r.json.trigger.nextFireAt > Date.now());
  r = await alice("GET", `/api/harnesses/${khid}/triggers`);
  check("triggers list both", r.status === 200 && r.json.triggers.length === 2);
  r = await bearer("GET", `/api/harnesses/${khid}/triggers`, writeTok);
  check("key blocked from triggers (403)", r.status === 403);
  // public ingress — no cookie, token in the URL
  const rawPost = async (pathStr, body) => {
    const res = await fetch(BASE + pathStr, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, json };
  };
  r = await rawPost(`/api/hook/${hookTok}`, { input: "ping" });
  check("webhook fires but reports no-runner (deployment has no target_url)", r.status === 503 && /runner/i.test(r.json.error || ""));
  r = await rawPost(`/api/hook/bogus-token`, { input: "x" });
  check("unknown webhook token is 404", r.status === 404);
  r = await stranger("GET", `/api/harnesses/${khid}/triggers`);
  check("an outsider cannot list triggers", r.status === 401 || r.status === 400);

  // ── connector catalog + managed connections ──
  r = await alice("GET", "/api/connectors?q=slack");
  check("catalog search returns slack", r.status === 200 && r.json.connectors.some((c) => c.id === "slack"));
  r = await bearer("GET", "/api/connectors", writeTok);
  check("API key blocked from the catalog (403)", r.status === 403);
  r = await alice("POST", `/api/orgs/${aliceOrg}/connections`, { connectorId: "slack", name: "Acme Slack", secret: "xoxb-abc-1234" });
  check("owner creates a connection (last4, no secret)", r.status === 200 && r.json.connection.last4 === "1234" && !("secret" in r.json.connection));
  const connId = r.json.connection.id;
  r = await alice("POST", `/api/orgs/${aliceOrg}/connections`, { connectorId: "http", name: "", config: {} });
  check("invalid connection is rejected (400)", r.status === 400);
  r = await alice("GET", `/api/orgs/${aliceOrg}/connections`);
  check("connections list is secret-free", r.status === 200 && r.json.connections.every((c) => !("secret" in c)));
  r = await bob("POST", `/api/orgs/${aliceOrg}/connections`, { connectorId: "http", name: "sneaky", config: { baseUrl: "https://x.y" } });
  check("a non-admin cannot create a connection", r.status === 400);
  r = await alice("PATCH", `/api/orgs/${aliceOrg}/connections/${connId}`, { secret: "xoxb-rotated-9876" });
  check("owner rotates the secret (last4 updates)", r.status === 200 && r.json.connection.last4 === "9876");
  // OAuth start: unconfigured provider → 400 (paste a token instead)
  r = await alice("GET", `/api/orgs/${aliceOrg}/connections/oauth/start?connectorId=slack`);
  check("oauth start is 400 when the provider isn't configured on this deploy", r.status === 400 && /paste a token/i.test(r.json.error || ""));
  // runner resolver: a service-account key resolves the connection's material
  r = await bearer("POST", `/api/orgs/${aliceOrg}/connections/${connId}/resolve`, writeTok);
  check("a runner key resolves connection material (Bearer header)", r.status === 200 && r.json.connection.authHeaders.Authorization === "Bearer xoxb-rotated-9876");
  // a key from another org cannot resolve it
  r = await bearer("POST", `/api/orgs/${aliceOrg}/connections/${connId}/resolve`, otherKey);
  check("a key from another org cannot resolve (403)", r.status === 403);
  r = await alice("DELETE", `/api/orgs/${aliceOrg}/connections/${connId}`);
  check("owner deletes the connection", r.status === 200 && r.json.deleted === true);

  // ── data governance: export the throwaway 'Other' org, then erase it ──
  r = await alice("GET", `/api/orgs/${otherOrg}/export`);
  check("owner exports org data (no secrets)", r.status === 200 && r.json.org.id === otherOrg && !JSON.stringify(r.json).includes('"hash"'));
  r = await alice("DELETE", `/api/orgs/${otherOrg}`);
  check("owner erases the org", r.status === 200 && r.json.erased === true);
  r = await alice("GET", `/api/orgs/${otherOrg}/export`);
  check("export after erase is refused", r.status === 400);

  // revoke stops the key immediately
  const keyId = (await alice("GET", `/api/orgs/${aliceOrg}/keys`)).json.keys.find((k) => k.name === "CI").id;
  await alice("DELETE", `/api/orgs/${aliceOrg}/keys/${keyId}`);
  r = await bearer("GET", "/api/harnesses", readTok);
  check("revoked key no longer authenticates (401)", r.status === 401);
  await alice("DELETE", `/api/harnesses/${khid}`);

  // ── logout clears the session ──
  r = await alice("POST", "/api/auth/logout");
  check("alice logout 200", r.status === 200);
  r = await alice("GET", "/api/harnesses");
  check("session invalid after logout", r.status === 401);

  // ── owner delete ──
  const alice2 = makeClient();
  await alice2("POST", "/api/auth/login", { email: "alice@example.com", password: "supersecret" });
  r = await alice2("DELETE", `/api/harnesses/${hid}`);
  check("owner can delete", r.status === 200 && r.json.deleted);
  r = await alice2("GET", "/api/harnesses");
  check("harness gone after delete", !r.json.harnesses.some((h) => h.id === hid));

} catch (e) {
  console.error("TEST HARNESS ERROR:", e);
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? "\nALL SIGNED-IN HTTP TESTS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
