/* HTTP routes for accounts, harnesses, sharing, and server-side sessions.

   Loaded lazily by proxy.mjs. If the data deps (better-sqlite3, bcryptjs)
   aren't installed, proxy.mjs skips this entirely and runs as the pure model
   proxy — so the collaboration tier is strictly opt-in.

   Auth: email+password, bcrypt-hashed; an httpOnly cookie holds an opaque
   session token. All harness/kv routes require a valid session and enforce
   ownership / share role server-side.
*/
import * as db from "./db.index.mjs";
import * as presence from "./presence.mjs";
import {
  oidcConfig, ssoEnabled, discover, authUrl, exchangeCode, verifyIdToken,
  pkcePair, randomToken, sealState, openState, stateSecret, identityFromClaims,
} from "./oidc.mjs";
import { forwardRun } from "./gateway.mjs";
import { fireTrigger } from "./triggers.mjs";
import { listConnectors, getConnector } from "./connectors.mjs";
import { pkcePair as oauthPkce, oauthConfigFor, oauthAvailable, buildAuthUrl, exchangeCode as oauthExchangeCode } from "./oauth-connections.mjs";

const COOKIE = "af_session";
const SSO_COOKIE = "af_sso";
const json = (res, code, obj, extraHeaders = {}) =>
  res.writeHead(code, { "content-type": "application/json", ...extraHeaders }).end(JSON.stringify(obj));

// ── per-IP rate limiters — Redis-backed if REDIS_URL is set (shared across
//    instances), else in-memory per-process. Both are awaited uniformly. ──
import { makeLimiterFactory } from "./ratelimit.mjs";
const { limiter: authLimiter, backend: rlBackend } =
  await makeLimiterFactory({ windowMs: 15 * 60_000, max: 10, prefix: "rl:auth:" });   // brute-force guard
const { limiter: apiLimiter } =
  await makeLimiterFactory({ windowMs: 60_000, max: 240, prefix: "rl:api:" });         // general data-route throttle
const { limiter: orgLimiter } =
  await makeLimiterFactory({ windowMs: 60_000, max: 600, prefix: "rl:org:" });          // per-org quota for API-key traffic
if (rlBackend === "redis") console.log("[ratelimit] using Redis (shared across instances)");
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown";

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (raw.length > 8_000_000) throw new Error("payload too large");
  return raw ? JSON.parse(raw) : {};
}
function setCookie(token, maxAgeDays = 30) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeDays * 86400}${secure}`;
}
function clearCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
// short-lived cookie carrying the sealed login state (PKCE verifier + nonce)
// across the IdP round-trip. SameSite=Lax so it survives the top-level redirect back.
function setSsoCookie(val) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SSO_COOKIE}=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`;
}
function clearSsoCookie() {
  return `${SSO_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
const CONN_OAUTH_COOKIE = "af_conn_oauth";
function setConnOauthCookie(val) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${CONN_OAUTH_COOKIE}=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`;
}
const clearConnOauthCookie = () => `${CONN_OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
// public base URL for OAuth redirect_uri: explicit env, else derived from the request.
function publicOrigin(req) {
  if (process.env.ERGON_PUBLIC_URL) return process.env.ERGON_PUBLIC_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (process.env.NODE_ENV === "production" ? "https" : "http");
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}
const connRedirectUri = (req) => `${publicOrigin(req)}/api/connections/oauth/callback`;
// OIDC discovery is cached per issuer (it rarely changes); refreshed on restart.
let _discCache = null, _discIssuer = null;
async function getDisc(cfg) {
  if (_discCache && _discIssuer === cfg.issuer) return _discCache;
  _discCache = await discover(cfg.issuer);
  _discIssuer = cfg.issuer;
  return _discCache;
}

/* Returns true if it handled the request. */
export async function handleApiRoutes(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (!p.startsWith("/api/auth") && !p.startsWith("/api/harnesses") &&
      !p.startsWith("/api/kv") && !p.startsWith("/api/orgs") && !p.startsWith("/api/runs") &&
      !p.startsWith("/api/gw") && !p.startsWith("/api/hook") && !p.startsWith("/api/connectors") &&
      !p.startsWith("/api/connections")) return false;

  const ip = clientIp(req);
  // stricter throttle on credential endpoints (brute-force guard), general throttle elsewhere
  const isAuthAttempt = (p === "/api/auth/login" || p === "/api/auth/signup") && req.method === "POST";
  if (isAuthAttempt && !(await authLimiter(ip))) { json(res, 429, { error: "Too many attempts. Try again in a few minutes." }); return true; }
  if (!(await apiLimiter(ip))) { json(res, 429, { error: "Rate limit exceeded." }); return true; }

  // Resolve the caller: a session cookie (human) or an Authorization: Bearer
  // <key> (service account). Bearer principals carry { apiKey:true, orgId }.
  let me = await db.userForToken(parseCookies(req)[COOKIE]);
  let viaKey = false;
  if (!me) {
    const authz = req.headers.authorization || "";
    if (authz.startsWith("Bearer ")) { me = await db.verifyApiKey(authz.slice(7).trim()); viaKey = !!me; }
  }
  const requireAuth = () => { if (!me) { json(res, 401, { error: "Not signed in." }); return false; } return true; };

  // API keys are for automation against harness/kv data only — never org
  // administration or the auth surface. A runner may also *resolve* a connection
  // (it needs the credential to make the call), so that one path is permitted.
  const isConnResolve = /^\/api\/orgs\/[^/]+\/connections\/[^/]+\/resolve$/.test(p);
  if (viaKey && !(p.startsWith("/api/harnesses") || p.startsWith("/api/kv") || p.startsWith("/api/runs") || p.startsWith("/api/gw") || isConnResolve)) {
    json(res, 403, { error: "API keys may only access the harness, kv, run, and gateway endpoints." });
    return true;
  }
  // per-org quota on API-key traffic (bound to one org); keyed by that org.
  if (viaKey && !(await orgLimiter(me.orgId))) {
    json(res, 429, { error: "Organization API rate limit exceeded." });
    return true;
  }

  try {
    // ── public webhook ingress: POST /api/hook/:token (no auth — the token is the key) ──
    const hookMatch = p.match(/^\/api\/hook\/([^/]+)$/);
    if (hookMatch && req.method === "POST") {
      const token = decodeURIComponent(hookMatch[1]);
      const trig = await db.getTriggerByToken(token);
      if (!trig) { json(res, 404, { error: "Unknown or revoked webhook token." }); return true; }
      if (!trig.enabled) { json(res, 403, { error: "This webhook is disabled." }); return true; }
      // read the body flexibly: JSON {input} → that; any other JSON / text → the raw payload
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) { json(res, 413, { error: "payload too large" }); return true; } }
      let input = raw;
      try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object" && "input" in parsed) input = typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input); } catch { /* keep raw text */ }
      const out = await fireTrigger(db, trig, input);
      json(res, out.status || (out.ok ? 200 : 502), out.ok ? { ok: true, runId: out.runId, output: out.body?.text ?? out.body } : (out.body || { error: "trigger failed" }));
      return true;
    }

    // ── hosted control-plane gateway: POST /api/gw/:slug/run[/stream] ──
    const gwMatch = p.match(/^\/api\/gw\/([^/]+)\/run(\/stream)?$/);
    if (gwMatch && req.method === "POST") {
      if (!viaKey) { json(res, 401, { error: "The gateway requires an API key: Authorization: Bearer <key>." }); return true; }
      const slug = decodeURIComponent(gwMatch[1]);
      const stream = !!gwMatch[2];
      const dep = await db.resolveDeployment(slug);
      if (!dep || dep.status !== "active") { json(res, 404, { error: "No active deployment for that slug." }); return true; }
      if (dep.orgId !== me.orgId) { json(res, 403, { error: "This API key is not for the deployment's organization." }); return true; }
      const gate = await db.checkBudget(dep.orgId);
      if (!gate.allowed) { json(res, 402, { error: `Organization budget exceeded: ${gate.reason}`, budget: true }); return true; }
      const { input } = await readBody(req);
      const t0 = Date.now();
      const out = await forwardRun(dep.targetUrl, { input, stream });
      const recordOutcome = async (status, output, usage) => {
        try {
          await db.recordRun(me.id, { harnessId: dep.harnessId, orgId: dep.orgId, input: input || "",
            output: output || "", status, startedAt: t0, finishedAt: Date.now(), latencyMs: Date.now() - t0, usage: usage || {} });
        } catch { /* recording is best-effort */ }
      };
      if (out.kind === "stream") {
        res.writeHead(out.status, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "close" });
        try {
          const reader = out.stream.body.getReader();
          const dec = new TextDecoder();
          for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(dec.decode(value)); }
        } catch { /* client or runner dropped */ }
        res.end();
        await recordOutcome("ok", "", {});
        return true;
      }
      await recordOutcome(out.kind === "ok" ? "ok" : "error", out.kind === "ok" ? (out.body.text || "") : "", out.usage);
      json(res, out.status, out.body);
      return true;
    }

    // ── auth ──
    if (p === "/api/auth/signup" && req.method === "POST") {
      const { email, password } = await readBody(req);
      const user = await db.createUser(email, password);
      const token = await db.createSession(user.id);
      return json(res, 200, { user }, { "set-cookie": setCookie(token) }), true;
    }
    if (p === "/api/auth/login" && req.method === "POST") {
      const { email, password } = await readBody(req);
      const user = await db.verifyUser(email, password);
      const token = await db.createSession(user.id);
      return json(res, 200, { user }, { "set-cookie": setCookie(token) }), true;
    }
    if (p === "/api/auth/logout" && req.method === "POST") {
      await db.destroySession(parseCookies(req)[COOKIE]);
      return json(res, 200, { ok: true }, { "set-cookie": clearCookie() }), true;
    }
    if (p === "/api/auth/me" && req.method === "GET") {
      return json(res, 200, { user: me || null }), true;
    }
    // which sign-in methods this deployment offers (UI shows/hides the SSO button)
    if (p === "/api/auth/providers" && req.method === "GET") {
      return json(res, 200, { password: true, sso: ssoEnabled() }), true;
    }
    // ── SSO (OIDC authorization-code + PKCE) ──
    if (p === "/api/auth/sso/login" && req.method === "GET") {
      const cfg = oidcConfig();
      if (!cfg) { json(res, 404, { error: "SSO is not configured." }); return true; }
      const disc = await getDisc(cfg);
      const { verifier, challenge } = pkcePair();
      const state = randomToken(), nonce = randomToken();
      const sealed = sealState({ state, nonce, verifier, exp: Date.now() + 600_000 }, stateSecret());
      const location = authUrl(disc, cfg, { state, nonce, codeChallenge: challenge });
      res.writeHead(302, { location, "set-cookie": setSsoCookie(sealed) }).end();
      return true;
    }
    if (p === "/api/auth/sso/callback" && req.method === "GET") {
      const cfg = oidcConfig();
      if (!cfg) { json(res, 404, { error: "SSO is not configured." }); return true; }
      const idpErr = url.searchParams.get("error");
      if (idpErr) { json(res, 400, { error: `SSO failed: ${idpErr}` }, { "set-cookie": clearSsoCookie() }); return true; }
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      let st;
      try { st = openState(parseCookies(req)[SSO_COOKIE], stateSecret()); }
      catch (e) { json(res, 400, { error: e.message }, { "set-cookie": clearSsoCookie() }); return true; }
      if (!code || !state || state !== st.state) {
        json(res, 400, { error: "SSO state mismatch — please try signing in again." }, { "set-cookie": clearSsoCookie() });
        return true;
      }
      const disc = await getDisc(cfg);
      const tok = await exchangeCode(disc, cfg, { code, codeVerifier: st.verifier });
      const claims = await verifyIdToken(tok.id_token, disc, cfg, { nonce: st.nonce });
      const user = await db.findOrCreateUserByOidc(identityFromClaims(claims));
      const token = await db.createSession(user.id);
      // land back in the app, signed in; drop the one-shot state cookie
      res.writeHead(302, { location: "/", "set-cookie": [clearSsoCookie(), setCookie(token)] }).end();
      return true;
    }

    // ── harnesses ──
    if (p === "/api/harnesses" && req.method === "GET") {
      if (!requireAuth()) return true;
      return json(res, 200, { harnesses: await db.listHarnesses(me.id) }), true;
    }
    if (p === "/api/harnesses" && req.method === "POST") {
      if (!requireAuth()) return true;
      const { id, name, graph, orgId, expectedVersion, force } = await readBody(req);
      return json(res, 200, { harness: await db.saveHarness(me.id, { id, name, graph, orgId, expectedVersion, force }) }), true;
    }
    const hMatch = p.match(/^\/api\/harnesses\/([^/]+)$/);
    if (hMatch) {
      if (!requireAuth()) return true;
      const hid = decodeURIComponent(hMatch[1]);
      if (req.method === "GET") return json(res, 200, { harness: await db.getHarness(hid, me.id) }), true;
      if (req.method === "DELETE") return json(res, 200, await db.deleteHarness(hid, me.id)), true;
    }

    // ── run history ──
    if (p === "/api/runs" && req.method === "POST") {
      if (!requireAuth()) return true;
      const rec = await readBody(req);
      return json(res, 200, await db.recordRun(me.id, rec)), true;
    }
    if (p === "/api/runs" && req.method === "GET") {
      if (!requireAuth()) return true;
      return json(res, 200, { runs: await db.listRuns(me.id, {
        orgId: url.searchParams.get("orgId"),
        harnessId: url.searchParams.get("harnessId"),
        limit: url.searchParams.get("limit") != null ? Number(url.searchParams.get("limit")) : undefined,
        before: url.searchParams.get("before") != null ? Number(url.searchParams.get("before")) : null,
      }) }), true;
    }
    const runMatch = p.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
      if (!requireAuth()) return true;
      return json(res, 200, { run: await db.getRun(me.id, decodeURIComponent(runMatch[1])) }), true;
    }

    // ── organizations (the access model: harness access = org role) ──
    if (p === "/api/orgs" && req.method === "GET") {
      if (!requireAuth()) return true;
      return json(res, 200, { orgs: await db.listOrgs(me.id) }), true;
    }
    if (p === "/api/orgs" && req.method === "POST") {
      if (!requireAuth()) return true;
      const { name } = await readBody(req);
      return json(res, 200, { org: await db.createOrg(me.id, name) }), true;
    }
    const mMatch = p.match(/^\/api\/orgs\/([^/]+)\/members$/);
    if (mMatch) {
      if (!requireAuth()) return true;
      const oid = decodeURIComponent(mMatch[1]);
      if (req.method === "GET") return json(res, 200, { members: await db.listMembers(oid, me.id) }), true;
      if (req.method === "POST") {
        const { email, role } = await readBody(req);
        return json(res, 200, { members: await db.addMember(oid, me.id, email, role) }), true;
      }
      if (req.method === "DELETE") {
        const { email } = await readBody(req);
        return json(res, 200, { members: await db.removeMember(oid, me.id, email) }), true;
      }
    }
    // ── service accounts / API keys (owner/admin) ──
    const kMatch = p.match(/^\/api\/orgs\/([^/]+)\/keys$/);
    if (kMatch) {
      if (!requireAuth()) return true;
      const oid = decodeURIComponent(kMatch[1]);
      if (req.method === "GET") return json(res, 200, { keys: await db.listApiKeys(oid, me.id) }), true;
      if (req.method === "POST") {
        const { name, role } = await readBody(req);
        return json(res, 200, { key: await db.createApiKey(oid, me.id, name, role) }), true;
      }
    }
    const krMatch = p.match(/^\/api\/orgs\/([^/]+)\/keys\/([^/]+)$/);
    if (krMatch && req.method === "DELETE") {
      if (!requireAuth()) return true;
      return json(res, 200, await db.revokeApiKey(decodeURIComponent(krMatch[1]), me.id, decodeURIComponent(krMatch[2]))), true;
    }
    // ── data governance: export + right-to-erasure ──
    const exMatch = p.match(/^\/api\/orgs\/([^/]+)\/export$/);
    if (exMatch && req.method === "GET") {
      if (!requireAuth()) return true;
      return json(res, 200, await db.exportOrg(decodeURIComponent(exMatch[1]), me.id)), true;
    }
    const orgDelMatch = p.match(/^\/api\/orgs\/([^/]+)$/);
    if (orgDelMatch && req.method === "DELETE") {
      if (!requireAuth()) return true;
      return json(res, 200, await db.eraseOrg(decodeURIComponent(orgDelMatch[1]), me.id)), true;
    }

    // ── deployments (hosted control plane; owner/admin manage, members list) ──
    const depMatch = p.match(/^\/api\/orgs\/([^/]+)\/deployments$/);
    if (depMatch) {
      if (!requireAuth()) return true;
      const oid = decodeURIComponent(depMatch[1]);
      if (req.method === "GET") return json(res, 200, { deployments: await db.listDeployments(oid, me.id) }), true;
      if (req.method === "POST") {
        const { slug, harnessId, targetUrl } = await readBody(req);
        return json(res, 200, { deployment: await db.createDeployment(oid, me.id, { slug, harnessId, targetUrl }) }), true;
      }
    }
    const depDelMatch = p.match(/^\/api\/orgs\/([^/]+)\/deployments\/([^/]+)$/);
    if (depDelMatch && req.method === "DELETE") {
      if (!requireAuth()) return true;
      return json(res, 200, await db.deleteDeployment(decodeURIComponent(depDelMatch[1]), me.id, decodeURIComponent(depDelMatch[2]))), true;
    }

    // ── connector catalog (read-only, signed-in) ──
    if (p === "/api/connectors" && req.method === "GET") {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "The connector catalog is a signed-in surface." }); return true; }
      const cat = listConnectors({ q: url.searchParams.get("q") || "", category: url.searchParams.get("category") || "" })
        .map((c) => ({ ...c, oauthFlow: oauthAvailable(c, process.env) }));   // reflect whether OAuth is live on this deployment
      return json(res, 200, { connectors: cat }), true;
    }

    // ── managed connections (per-org; owner/admin manage, members read secret-free) ──
    const connMatch = p.match(/^\/api\/orgs\/([^/]+)\/connections$/);
    if (connMatch) {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Connections are a signed-in surface." }); return true; }
      const oid = decodeURIComponent(connMatch[1]);
      if (req.method === "GET") return json(res, 200, { connections: await db.listConnections(oid, me.id) }), true;
      if (req.method === "POST") {
        const { connectorId, name, config, secret } = await readBody(req);
        return json(res, 200, { connection: await db.createConnection(oid, me.id, { connectorId, name, config, secret }) }), true;
      }
    }
    const connItemMatch = p.match(/^\/api\/orgs\/([^/]+)\/connections\/([^/]+)$/);
    if (connItemMatch) {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Connections are a signed-in surface." }); return true; }
      const oid = decodeURIComponent(connItemMatch[1]), cid = decodeURIComponent(connItemMatch[2]);
      if (req.method === "PATCH") { const { name, config, secret } = await readBody(req); return json(res, 200, { connection: await db.updateConnection(oid, me.id, cid, { name, config, secret }) }), true; }
      if (req.method === "DELETE") return json(res, 200, await db.deleteConnection(oid, me.id, cid)), true;
    }

    // ── runner-side resolver: decrypt + (OAuth) refresh, return run-time material.
    //    Allowed for an org member (cookie) or a service-account API key for the org. ──
    const connResolveMatch = p.match(/^\/api\/orgs\/([^/]+)\/connections\/([^/]+)\/resolve$/);
    if (connResolveMatch && req.method === "POST") {
      if (!requireAuth()) return true;
      const oid = decodeURIComponent(connResolveMatch[1]), cid = decodeURIComponent(connResolveMatch[2]);
      if (viaKey && me.orgId !== oid) { json(res, 403, { error: "This API key is not for that organization." }); return true; }
      if (!viaKey && !(await db.orgRoleFor(oid, me.id))) { json(res, 403, { error: "Not a member of this organization." }); return true; }
      return json(res, 200, { connection: await db.resolveConnection(oid, cid, { redirectUri: connRedirectUri(req) }) }), true;
    }

    // ── connection OAuth: start the authorize flow (owner/admin, cookie) ──
    const connOauthStart = p.match(/^\/api\/orgs\/([^/]+)\/connections\/oauth\/start$/);
    if (connOauthStart && req.method === "GET") {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Connections are a signed-in surface." }); return true; }
      const oid = decodeURIComponent(connOauthStart[1]);
      const role = await db.orgRoleFor(oid, me.id);
      if (role !== "owner" && role !== "admin") { json(res, 403, { error: "Only an owner or admin can connect an app." }); return true; }
      const connector = getConnector(url.searchParams.get("connectorId") || "");
      const cfg = oauthConfigFor(connector, process.env);
      if (!cfg) { json(res, 400, { error: "OAuth isn't configured for this connector on this deployment. Paste a token instead." }); return true; }
      const { verifier, challenge } = oauthPkce();
      const state = randomToken(18);
      const sealed = sealState({ state, verifier, orgId: oid, userId: me.id, connectorId: connector.id, exp: Date.now() + 600_000 }, stateSecret());
      const location = buildAuthUrl(cfg, { redirectUri: connRedirectUri(req), state, codeChallenge: challenge });
      return json(res, 200, { url: location }, { "set-cookie": setConnOauthCookie(sealed) }), true;
    }

    // ── connection OAuth: provider redirect lands here (public; state cookie carries context) ──
    if (p === "/api/connections/oauth/callback" && req.method === "GET") {
      const idpErr = url.searchParams.get("error");
      // Serve a tiny self-closing page that notifies the opener — works whether the
      // flow ran in a popup (preferred: no SPA reload, no lost edits) or a tab.
      const land = (ok, note) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8", "set-cookie": clearConnOauthCookie() });
        res.end(`<!doctype html><meta charset=utf-8><title>${ok ? "Connected" : "Connection failed"}</title>` +
          `<body style="font-family:system-ui;background:#0C0F16;color:#E6E9F0;display:grid;place-items:center;height:100vh;margin:0">` +
          `<div style="text-align:center"><div style="font-size:15px;font-weight:600">${ok ? "✓ Connected" : "Connection failed"}</div>` +
          `<div style="font-size:12px;color:#9AA0AC;margin-top:6px">${ok ? "You can close this window." : String(note).replace(/[<>&]/g, "")}</div></div>` +
          `<script>try{window.opener&&window.opener.postMessage({ergonConnected:${JSON.stringify(String(note))},ok:${ok}},"*")}catch(e){}` +
          `setTimeout(function(){try{window.close()}catch(e){}},${ok ? 900 : 3500})</script></body>`);
        return true;
      };
      if (idpErr) return land(false, idpErr);
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      let st; try { st = openState(parseCookies(req)[CONN_OAUTH_COOKIE], stateSecret()); } catch { return land(false, "state"); }
      if (!code || !state || state !== st.state) return land(false, "state");
      try {
        const connector = getConnector(st.connectorId);
        const cfg = oauthConfigFor(connector, process.env);
        if (!cfg) return land(false, "unconfigured");
        const tok = await oauthExchangeCode(cfg, { code, codeVerifier: st.verifier, redirectUri: connRedirectUri(req) }, fetch);
        await db.upsertOAuthConnection(st.orgId, st.userId, {
          connectorId: connector.id, name: `${connector.name} (OAuth)`,
          access: tok.access, refresh: tok.refresh, expiresAt: tok.expiresAt, config: { scope: tok.scope || null },
        });
        return land(true, connector.id);
      } catch (e) { return land(false, "exchange"); }
    }

    // ── budgets & quotas (owner/admin manage; members read status) ──
    const bMatch = p.match(/^\/api\/orgs\/([^/]+)\/budgets$/);
    if (bMatch) {
      if (!requireAuth()) return true;
      const oid = decodeURIComponent(bMatch[1]);
      if (req.method === "GET") return json(res, 200, { budgets: await db.listBudgets(oid, me.id) }), true;
      if (req.method === "POST") {
        const { period, maxCost, maxRequests } = await readBody(req);
        return json(res, 200, { budgets: await db.setBudget(oid, me.id, { period, maxCost, maxRequests }) }), true;
      }
    }
    const bsMatch = p.match(/^\/api\/orgs\/([^/]+)\/budgets\/status$/);
    if (bsMatch && req.method === "GET") {
      if (!requireAuth()) return true;
      return json(res, 200, { status: await db.budgetStatus(decodeURIComponent(bsMatch[1]), me.id) }), true;
    }
    const bdMatch = p.match(/^\/api\/orgs\/([^/]+)\/budgets\/([^/]+)$/);
    if (bdMatch && req.method === "DELETE") {
      if (!requireAuth()) return true;
      return json(res, 200, await db.deleteBudget(decodeURIComponent(bdMatch[1]), me.id, decodeURIComponent(bdMatch[2]))), true;
    }

    const aMatch = p.match(/^\/api\/orgs\/([^/]+)\/audit$/);
    if (aMatch && req.method === "GET") {
      if (!requireAuth()) return true;
      const oid = decodeURIComponent(aMatch[1]);
      const limit = url.searchParams.get("limit");
      const before = url.searchParams.get("before");
      return json(res, 200, { entries: await db.listAudit(oid, me.id, { limit: limit != null ? Number(limit) : undefined, before: before != null ? Number(before) : null }) }), true;
    }
    const ohMatch = p.match(/^\/api\/harnesses\/([^/]+)\/org$/);
    if (ohMatch) {
      if (!requireAuth()) return true;
      if (req.method === "POST") {
        const hid = decodeURIComponent(ohMatch[1]);
        const { orgId } = await readBody(req);
        return json(res, 200, { harness: await db.setHarnessOrg(hid, me.id, orgId || null) }), true;
      }
    }

    // ── collaboration: node-anchored comments (humans only) ──
    const cListMatch = p.match(/^\/api\/harnesses\/([^/]+)\/comments$/);
    if (cListMatch) {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Comments require a signed-in user." }); return true; }
      const hid = decodeURIComponent(cListMatch[1]);
      if (req.method === "GET") return json(res, 200, { comments: await db.listComments(hid, me.id) }), true;
      if (req.method === "POST") {
        const { nodeId, body } = await readBody(req);
        return json(res, 200, { comment: await db.createComment(hid, me.id, { nodeId: nodeId || null, body }) }), true;
      }
    }
    const cItemMatch = p.match(/^\/api\/harnesses\/([^/]+)\/comments\/([^/]+)$/);
    if (cItemMatch) {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Comments require a signed-in user." }); return true; }
      const cid = decodeURIComponent(cItemMatch[2]);
      if (req.method === "PATCH") { const { resolved } = await readBody(req); return json(res, 200, { comment: await db.resolveComment(cid, me.id, !!resolved) }), true; }
      if (req.method === "DELETE") return json(res, 200, await db.deleteComment(cid, me.id)), true;
    }

    // ── triggers: webhook + schedule entry points (humans only) ──
    const trgListMatch = p.match(/^\/api\/harnesses\/([^/]+)\/triggers$/);
    if (trgListMatch) {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Triggers require a signed-in user." }); return true; }
      const hid = decodeURIComponent(trgListMatch[1]);
      if (req.method === "GET") return json(res, 200, { triggers: await db.listTriggers(hid, me.id) }), true;
      if (req.method === "POST") {
        const { type, cron, payload } = await readBody(req);
        return json(res, 200, { trigger: await db.createTrigger(me.id, hid, { type, cron, payload }) }), true;
      }
    }
    const trgItemMatch = p.match(/^\/api\/harnesses\/([^/]+)\/triggers\/([^/]+)$/);
    if (trgItemMatch) {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Triggers require a signed-in user." }); return true; }
      const tid = decodeURIComponent(trgItemMatch[2]);
      if (req.method === "PATCH") { const { enabled, cron, payload } = await readBody(req); return json(res, 200, { trigger: await db.updateTrigger(me.id, tid, { enabled, cron, payload }) }), true; }
      if (req.method === "DELETE") return json(res, 200, await db.deleteTrigger(me.id, tid)), true;
    }

    // ── version history: list saved versions, fetch one (humans only) ──
    const vItemMatch = p.match(/^\/api\/harnesses\/([^/]+)\/versions\/([^/]+)$/);
    if (vItemMatch && req.method === "GET") {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Version history requires a signed-in user." }); return true; }
      return json(res, 200, { version: await db.getVersion(decodeURIComponent(vItemMatch[1]), decodeURIComponent(vItemMatch[2]), me.id) }), true;
    }
    const vListMatch = p.match(/^\/api\/harnesses\/([^/]+)\/versions$/);
    if (vListMatch && req.method === "GET") {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Version history requires a signed-in user." }); return true; }
      return json(res, 200, { versions: await db.listVersions(decodeURIComponent(vListMatch[1]), me.id) }), true;
    }

    // ── collaboration: live presence heartbeat (humans only, in-memory) ──
    const presMatch = p.match(/^\/api\/harnesses\/([^/]+)\/presence$/);
    if (presMatch && req.method === "POST") {
      if (!requireAuth()) return true;
      if (viaKey) { json(res, 403, { error: "Presence requires a signed-in user." }); return true; }
      const hid = decodeURIComponent(presMatch[1]);
      await db.getHarness(hid, me.id);                      // throws unless the caller has access
      const { selection, cursor } = await readBody(req);
      const viewers = presence.heartbeat(hid, { id: me.id, email: me.email }, selection ?? null, cursor ?? null);
      return json(res, 200, { viewers }), true;
    }

    // ── kv (server-side run-sessions / timeline) ──
    if (p === "/api/kv" && req.method === "GET") {
      if (!requireAuth()) return true;
      const key = url.searchParams.get("key");
      const prefix = url.searchParams.get("prefix");
      if (key != null) return json(res, 200, { key, value: await db.kvGet(me.id, key) }), true;
      return json(res, 200, { keys: await db.kvList(me.id, prefix || "") }), true;
    }
    if (p === "/api/kv" && req.method === "POST") {
      if (!requireAuth()) return true;
      const { key, value, harnessId } = await readBody(req);
      return json(res, 200, await db.kvSet(me.id, key, value, harnessId || null)), true;
    }
    if (p === "/api/kv" && req.method === "DELETE") {
      if (!requireAuth()) return true;
      const { key } = await readBody(req);
      return json(res, 200, await db.kvDelete(me.id, key)), true;
    }

    json(res, 404, { error: "unknown api route" });
    return true;
  } catch (e) {
    if (e && e.name === "ConflictError") {
      json(res, 409, { error: e.message, conflict: true, current: e.current });
      return true;
    }
    if (e && e.code === "budget") {
      json(res, 402, { error: String(e.message || e), budget: true });
      return true;
    }
    json(res, 400, { error: String(e.message || e) });
    return true;
  }
}
