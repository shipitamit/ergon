/* OIDC / SSO core (Phase 2.4 → 2.3 enterprise SSO).

   A small, dependency-light Authorization-Code + PKCE client. The only external
   dependency — `jose`, for JWKS-backed ID-token signature verification — is
   imported lazily inside the default verifier, so:
     • the server still boots and password auth still works if `jose` isn't
       installed (SSO is simply reported as unavailable until it is), matching
       the rest of the opt-in collaboration tier; and
     • tests can inject their own `verifyJwt` and exercise the whole flow offline
       (PKCE, state sealing, discovery parsing, claim checks) with no network and
       no `jose`.

   Config is environment-driven (all required to enable SSO):
     OIDC_ISSUER         e.g. https://accounts.example.com
     OIDC_CLIENT_ID
     OIDC_REDIRECT_URI   e.g. https://studio.example.com/api/auth/sso/callback
   Optional:
     OIDC_CLIENT_SECRET  (confidential clients; omit for public + PKCE)
     OIDC_SCOPE          (default "openid email profile")
     OIDC_STATE_SECRET   (HMAC key for the short-lived login-state cookie)
*/
import crypto from "node:crypto";

export function oidcConfig(env = process.env) {
  const issuer = env.OIDC_ISSUER, clientId = env.OIDC_CLIENT_ID, redirectUri = env.OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !redirectUri) return null;
  return {
    issuer: issuer.replace(/\/$/, ""),
    clientId,
    clientSecret: env.OIDC_CLIENT_SECRET || null,
    redirectUri,
    scope: env.OIDC_SCOPE || "openid email profile",
  };
}
export const ssoEnabled = (env = process.env) => !!oidcConfig(env);

// a stable-ish HMAC key for the login-state cookie. Prefer an explicit secret so
// it survives restarts and works across instances; fall back to a per-process
// random (fine for the short-lived state cookie on a single instance).
let _fallbackSecret = null;
export function stateSecret(env = process.env) {
  if (env.OIDC_STATE_SECRET) return env.OIDC_STATE_SECRET;
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (!_fallbackSecret) {
    _fallbackSecret = crypto.randomBytes(32).toString("base64url");
    console.warn("[oidc] no OIDC_STATE_SECRET/SESSION_SECRET set — using a per-process key; set one for multi-instance SSO.");
  }
  return _fallbackSecret;
}

/* ── PKCE + random tokens ── */
export const randomToken = (n = 32) => crypto.randomBytes(n).toString("base64url");
export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/* ── signed, self-contained login-state cookie (data.mac) ── */
export function sealState(obj, secret) {
  const data = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${mac}`;
}
export function openState(sealed, secret) {
  const [data, mac] = String(sealed || "").split(".");
  if (!data || !mac) throw new Error("Missing or malformed SSO state.");
  const expect = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("SSO state failed verification.");
  const parsed = JSON.parse(Buffer.from(data, "base64url").toString());
  if (parsed.exp && Date.now() > parsed.exp) throw new Error("SSO login expired — please try again.");
  return parsed;
}

/* ── discovery ── */
export async function discover(issuer, fetchImpl = fetch) {
  const url = issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`OIDC discovery failed (${r.status}).`);
  const d = await r.json();
  for (const k of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"])
    if (!d[k]) throw new Error(`OIDC discovery document is missing ${k}.`);
  return d;
}

/* ── authorization-request URL ── */
export function authUrl(disc, cfg, { state, nonce, codeChallenge }) {
  const u = new URL(disc.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", cfg.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/* ── code → tokens ── */
export async function exchangeCode(disc, cfg, { code, codeVerifier }, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: codeVerifier,
  });
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (cfg.clientSecret)
    headers.authorization = "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const r = await fetchImpl(disc.token_endpoint, { method: "POST", headers, body: body.toString() });
  if (!r.ok) throw new Error(`OIDC token exchange failed (${r.status}).`);
  const tok = await r.json();
  if (!tok.id_token) throw new Error("OIDC token response had no id_token.");
  return tok;
}

/* ── ID-token verification (signature via JWKS + claim checks) ── */
let _defaultVerifier = null;
async function defaultJwtVerifier() {
  if (_defaultVerifier) return _defaultVerifier;
  let jose;
  try { jose = await import("jose"); }
  catch { throw new Error("SSO requires the 'jose' package — run `npm install` in studio/."); }
  const cache = new Map();
  _defaultVerifier = async (token, { issuer, audience, jwksUri }) => {
    let ks = cache.get(jwksUri);
    if (!ks) { ks = jose.createRemoteJWKSet(new URL(jwksUri)); cache.set(jwksUri, ks); }
    const { payload } = await jose.jwtVerify(token, ks, { issuer, audience });
    return payload;
  };
  return _defaultVerifier;
}

export async function verifyIdToken(idToken, disc, cfg, { nonce, verifyJwt } = {}) {
  const verify = verifyJwt || (await defaultJwtVerifier());
  const payload = await verify(idToken, { issuer: disc.issuer, audience: cfg.clientId, jwksUri: disc.jwks_uri });
  if (nonce == null || payload.nonce !== nonce) throw new Error("OIDC nonce mismatch — possible replay.");
  if (!payload.sub) throw new Error("OIDC id_token has no subject (sub).");
  return payload;
}

/* ── the fields we persist from a verified login ── */
export function identityFromClaims(payload) {
  return {
    provider: "oidc",
    subject: String(payload.sub),
    email: payload.email ? String(payload.email).trim().toLowerCase() : null,
    emailVerified: payload.email_verified !== false, // treat absent as trusted; only explicit false blocks linking
    name: payload.name || payload.preferred_username || null,
  };
}
