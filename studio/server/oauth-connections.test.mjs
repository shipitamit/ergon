/* Generic OAuth2 flow (pure, fake fetch). Run: node server/oauth-connections.test.mjs */
import assert from "node:assert";
import { pkcePair, oauthConfigFor, oauthAvailable, buildAuthUrl, exchangeCode, refreshTokens, isExpired } from "./oauth-connections.mjs";

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const slack = { id: "slack", oauth: { authUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access", scopes: ["chat:write", "channels:read"] } };

await test("oauthConfigFor reads env credentials; absent → null", () => {
  assert.equal(oauthConfigFor(slack, {}), null);
  const cfg = oauthConfigFor(slack, { ERGON_OAUTH_SLACK_CLIENT_ID: "cid", ERGON_OAUTH_SLACK_CLIENT_SECRET: "csec" });
  assert.equal(cfg.clientId, "cid");
  assert.equal(cfg.clientSecret, "csec");
  assert.equal(cfg.tokenUrl, slack.oauth.tokenUrl);
  assert.ok(oauthAvailable(slack, { ERGON_OAUTH_SLACK_CLIENT_ID: "cid" }));
  assert.ok(!oauthAvailable({ id: "x" }, {}));
});

await test("buildAuthUrl carries client, redirect, scope, state, PKCE", () => {
  const { challenge } = pkcePair();
  const cfg = oauthConfigFor(slack, { ERGON_OAUTH_SLACK_CLIENT_ID: "cid" });
  const url = new URL(buildAuthUrl(cfg, { redirectUri: "https://app/cb", state: "st8", codeChallenge: challenge }));
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app/cb");
  assert.equal(url.searchParams.get("scope"), "chat:write channels:read");
  assert.equal(url.searchParams.get("state"), "st8");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

await test("exchangeCode normalizes a standard token response", async () => {
  const fake = async (u, opts) => {
    assert.ok(opts.body.includes("grant_type=authorization_code"));
    assert.ok(opts.body.includes("code_verifier=ver"));
    return { ok: true, json: async () => ({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "chat:write" }) };
  };
  const cfg = oauthConfigFor(slack, { ERGON_OAUTH_SLACK_CLIENT_ID: "cid", ERGON_OAUTH_SLACK_CLIENT_SECRET: "cs" });
  const t = await exchangeCode(cfg, { code: "abc", codeVerifier: "ver", redirectUri: "https://app/cb" }, fake);
  assert.equal(t.access, "at-1");
  assert.equal(t.refresh, "rt-1");
  assert.ok(t.expiresAt > Date.now());
});

await test("exchangeCode surfaces a provider error (Slack ok:false)", async () => {
  const fake = async () => ({ ok: true, json: async () => ({ ok: false, error: "invalid_code" }) });
  const cfg = oauthConfigFor(slack, { ERGON_OAUTH_SLACK_CLIENT_ID: "cid" });
  await assert.rejects(() => exchangeCode(cfg, { code: "x", redirectUri: "https://app/cb" }, fake), /invalid_code/);
});

await test("refreshTokens keeps the old refresh token when the provider omits one", async () => {
  const fake = async () => ({ ok: true, json: async () => ({ access_token: "at-2", expires_in: 3600 }) });
  const cfg = oauthConfigFor(slack, { ERGON_OAUTH_SLACK_CLIENT_ID: "cid" });
  const t = await refreshTokens(cfg, { refreshToken: "rt-1", redirectUri: "https://app/cb" }, fake);
  assert.equal(t.access, "at-2");
  assert.equal(t.refresh, "rt-1", "carried the prior refresh token forward");
});

await test("isExpired treats near-expiry as expired, null as not", () => {
  assert.ok(isExpired(Date.now() + 30_000));   // 30s left → expired (60s skew)
  assert.ok(!isExpired(Date.now() + 120_000));
  assert.ok(!isExpired(null));
});

console.log(`\noauth-connections.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
