/* OIDC/SSO core tests — fully offline. No network, no `jose`: discovery and
   token exchange use an injected fetch, and id_token verification uses an
   injected verifyJwt. Exercises PKCE, the sealed-state cookie, discovery
   validation, the auth-request URL, token exchange, claim checks, and config.
   Run: node server/oidc.test.mjs  */
import assert from "node:assert";
import crypto from "node:crypto";
import * as oidc from "./oidc.mjs";

let passed = 0, failed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const CFG = { issuer: "https://idp.example.com", clientId: "client123", clientSecret: "shh", redirectUri: "https://app.example.com/api/auth/sso/callback", scope: "openid email profile" };
const DISC = {
  issuer: "https://idp.example.com",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
};
const okFetch = (payload, ok = true, status = 200) => async () => ({ ok, status, json: async () => payload });

await test("pkcePair: challenge is the base64url S256 of the verifier", () => {
  const { verifier, challenge } = oidc.pkcePair();
  const expect = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expect);
  assert.ok(verifier.length >= 40);
});

await test("sealState/openState round-trips and carries the fields", () => {
  const secret = "k";
  const sealed = oidc.sealState({ state: "s1", nonce: "n1", verifier: "v1", exp: Date.now() + 1000 }, secret);
  const out = oidc.openState(sealed, secret);
  assert.equal(out.state, "s1"); assert.equal(out.nonce, "n1"); assert.equal(out.verifier, "v1");
});

await test("openState rejects tampering and a wrong secret", () => {
  const sealed = oidc.sealState({ state: "s" }, "k");
  const [data] = sealed.split(".");
  assert.throws(() => oidc.openState(`${data}.deadbeef`, "k"), /verification/);
  assert.throws(() => oidc.openState(sealed, "other"), /verification/);
  assert.throws(() => oidc.openState("", "k"), /Missing|malformed/);
});

await test("openState rejects an expired state", () => {
  const sealed = oidc.sealState({ state: "s", exp: Date.now() - 1 }, "k");
  assert.throws(() => oidc.openState(sealed, "k"), /expired/);
});

await test("discover validates required endpoints", async () => {
  const d = await oidc.discover(CFG.issuer, okFetch(DISC));
  assert.equal(d.token_endpoint, DISC.token_endpoint);
  await assert.rejects(() => oidc.discover(CFG.issuer, okFetch({ issuer: "x" })), /missing/);
  await assert.rejects(() => oidc.discover(CFG.issuer, okFetch({}, false, 500)), /discovery failed/);
});

await test("authUrl carries PKCE + state + nonce with S256", () => {
  const u = new URL(oidc.authUrl(DISC, CFG, { state: "st", nonce: "no", codeChallenge: "ch" }));
  assert.equal(u.origin + u.pathname, "https://idp.example.com/authorize");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "client123");
  assert.equal(u.searchParams.get("redirect_uri"), CFG.redirectUri);
  assert.equal(u.searchParams.get("code_challenge"), "ch");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.get("nonce"), "no");
});

await test("exchangeCode posts PKCE verifier + Basic auth and returns tokens", async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => ({ id_token: "idt", access_token: "at" }) }; };
  const tok = await oidc.exchangeCode(DISC, CFG, { code: "c", codeVerifier: "v" }, fetchImpl);
  assert.equal(tok.id_token, "idt");
  assert.equal(seen.url, DISC.token_endpoint);
  assert.match(seen.opts.body, /grant_type=authorization_code/);
  assert.match(seen.opts.body, /code_verifier=v/);
  const basic = "Basic " + Buffer.from("client123:shh").toString("base64");
  assert.equal(seen.opts.headers.authorization, basic);
});

await test("exchangeCode surfaces a non-OK response and a missing id_token", async () => {
  await assert.rejects(() => oidc.exchangeCode(DISC, CFG, { code: "c", codeVerifier: "v" }, okFetch({}, false, 400)), /token exchange failed/);
  await assert.rejects(() => oidc.exchangeCode(DISC, CFG, { code: "c", codeVerifier: "v" }, okFetch({ access_token: "a" })), /no id_token/);
});

await test("verifyIdToken checks issuer/audience, nonce, and sub", async () => {
  let passedOpts = null;
  const verifyJwt = async (token, opts) => { passedOpts = opts; return { sub: "u1", nonce: "n1", email: "A@x.com" }; };
  const claims = await oidc.verifyIdToken("idt", DISC, CFG, { nonce: "n1", verifyJwt });
  assert.equal(claims.sub, "u1");
  assert.equal(passedOpts.issuer, DISC.issuer);
  assert.equal(passedOpts.audience, CFG.clientId);
  assert.equal(passedOpts.jwksUri, DISC.jwks_uri);
  // nonce mismatch and missing sub both reject
  await assert.rejects(() => oidc.verifyIdToken("idt", DISC, CFG, { nonce: "WRONG", verifyJwt }), /nonce/);
  const noSub = async () => ({ nonce: "n1" });
  await assert.rejects(() => oidc.verifyIdToken("idt", DISC, CFG, { nonce: "n1", verifyJwt: noSub }), /subject/);
});

await test("identityFromClaims normalizes email + treats absent email_verified as trusted", () => {
  assert.deepEqual(oidc.identityFromClaims({ sub: "s", email: "Bob@X.com", name: "Bob" }),
    { provider: "oidc", subject: "s", email: "bob@x.com", emailVerified: true, name: "Bob" });
  assert.equal(oidc.identityFromClaims({ sub: "s", email: "a@b.c", email_verified: false }).emailVerified, false);
  assert.equal(oidc.identityFromClaims({ sub: 42 }).subject, "42");
});

await test("oidcConfig/ssoEnabled read the environment", () => {
  assert.equal(oidc.ssoEnabled({}), false);
  const env = { OIDC_ISSUER: "https://i/", OIDC_CLIENT_ID: "c", OIDC_REDIRECT_URI: "https://r/cb" };
  assert.equal(oidc.ssoEnabled(env), true);
  const cfg = oidc.oidcConfig(env);
  assert.equal(cfg.issuer, "https://i");   // trailing slash trimmed
  assert.equal(cfg.scope, "openid email profile");
  assert.equal(cfg.clientSecret, null);    // public client when no secret
});

console.log(`\noidc.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
