/* Generic OAuth 2.0 authorization-code flow (with PKCE) for connectors.

   Distinct from oidc.mjs, which is OIDC *login* (expects an id_token). This is
   plain OAuth for third-party API access: authorize → code → access/refresh
   tokens, plus refresh. Per-provider endpoints live in the connector catalog;
   client credentials come from the environment, so a deployment opts a provider
   in by registering an OAuth app and setting two env vars. With no credentials
   configured, the provider simply offers the paste-a-token path instead.

   Everything here is pure and takes an injected fetch, so the whole flow is
   unit-testable without a network or a real provider. */
import crypto from "node:crypto";

export const pkcePair = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

// Resolve a connector's OAuth client config from the environment.
// ERGON_OAUTH_<ID>_CLIENT_ID / _CLIENT_SECRET, e.g. ERGON_OAUTH_SLACK_CLIENT_ID.
export function oauthConfigFor(connector, env = process.env) {
  if (!connector || !connector.oauth) return null;
  const up = String(connector.id).toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const clientId = env[`ERGON_OAUTH_${up}_CLIENT_ID`];
  const clientSecret = env[`ERGON_OAUTH_${up}_CLIENT_SECRET`];
  if (!clientId) return null;   // provider not configured on this deployment
  return { clientId, clientSecret: clientSecret || null, ...connector.oauth };
}

export const oauthAvailable = (connector, env = process.env) => !!oauthConfigFor(connector, env);

export function buildAuthUrl(cfg, { redirectUri, state, codeChallenge }) {
  const u = new URL(cfg.authUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  if (cfg.scopes) u.searchParams.set("scope", Array.isArray(cfg.scopes) ? cfg.scopes.join(" ") : cfg.scopes);
  u.searchParams.set("state", state);
  if (codeChallenge) { u.searchParams.set("code_challenge", codeChallenge); u.searchParams.set("code_challenge_method", "S256"); }
  if (cfg.extraAuthParams) for (const [k, v] of Object.entries(cfg.extraAuthParams)) u.searchParams.set(k, v);
  return u.toString();
}

// normalize a token response into { access, refresh, expiresAt, scope, raw }
function _normalizeToken(tok) {
  // Slack nests the user/bot token differently; support the common shapes.
  const access = tok.access_token || tok.authed_user?.access_token || tok.bot?.bot_access_token || null;
  const refresh = tok.refresh_token || null;
  const expiresIn = Number(tok.expires_in || tok.authed_user?.expires_in || 0);
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;
  return { access, refresh, expiresAt, scope: tok.scope || null, raw: tok };
}

export async function exchangeCode(cfg, { code, codeVerifier, redirectUri }, fetchImpl = fetch) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: cfg.clientId });
  if (codeVerifier) body.set("code_verifier", codeVerifier);
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  const r = await fetchImpl(cfg.tokenUrl, { method: "POST", headers, body: body.toString() });
  if (!r.ok) throw new Error(`OAuth token exchange failed (${r.status}).`);
  const tok = await r.json();
  if (tok.ok === false) throw new Error(`OAuth error: ${tok.error || "unknown"}`);   // Slack-style
  const norm = _normalizeToken(tok);
  if (!norm.access) throw new Error("OAuth token response carried no access token.");
  return norm;
}

export async function refreshTokens(cfg, { refreshToken, redirectUri }, fetchImpl = fetch) {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId });
  if (redirectUri) body.set("redirect_uri", redirectUri);
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  const r = await fetchImpl(cfg.tokenUrl, { method: "POST", headers, body: body.toString() });
  if (!r.ok) throw new Error(`OAuth token refresh failed (${r.status}).`);
  const norm = _normalizeToken(await r.json());
  if (!norm.access) throw new Error("OAuth refresh carried no access token.");
  if (!norm.refresh) norm.refresh = refreshToken;   // many providers omit a new refresh token
  return norm;
}

// a token with <60s of life left is treated as expired, to avoid mid-call expiry
export const isExpired = (expiresAt, nowMs = Date.now()) => !!expiresAt && expiresAt - 60_000 <= nowMs;
