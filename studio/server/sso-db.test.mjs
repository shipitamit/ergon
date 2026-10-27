/* SSO identity linking against the real SQLite data layer (node:sqlite fallback,
   zero deps). Covers first-login provisioning, stable re-login, account linking
   by verified email, the unverified-email guard, and that an SSO account can't
   be signed into with a password. Run: node server/sso-db.test.mjs  */
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.ERGON_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ergon-sso-")), "t.db");
const db = await import("./db.mjs");

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

const id = (email, extra = {}) => ({ provider: "oidc", subject: `sub-${email}`, email, emailVerified: true, name: "T", ...extra });

test("first SSO login provisions a user + personal org (owner)", () => {
  const r = db.findOrCreateUserByOidc(id("new@x.com"));
  assert.equal(r.created, true);
  assert.equal(r.email, "new@x.com");
  const orgs = db.listOrgs(r.id);
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].role, "owner");
});

test("a repeat SSO login resolves to the same user (no new account)", () => {
  const a = db.findOrCreateUserByOidc(id("repeat@x.com"));
  const b = db.findOrCreateUserByOidc(id("repeat@x.com"));
  assert.equal(a.id, b.id);
  assert.equal(b.created, false);
  assert.equal(b.linked, false);
});

test("SSO links onto an existing password account by verified email", () => {
  const pw = db.createUser("link@x.com", "password1");
  const sso = db.findOrCreateUserByOidc(id("link@x.com"));
  assert.equal(sso.id, pw.id);     // same user
  assert.equal(sso.linked, true);
  assert.equal(sso.created, false);
});

test("linking is refused when the IdP did not verify the email", () => {
  db.createUser("unverified@x.com", "password1");
  assert.throws(() => db.findOrCreateUserByOidc(id("unverified@x.com", { emailVerified: false })), /did not verify/);
});

test("a login with no email claim and no known subject is refused", () => {
  assert.throws(() => db.findOrCreateUserByOidc({ provider: "oidc", subject: "nobody", email: null }), /needs an email/);
});

test("an SSO-provisioned account cannot be signed into with a password", () => {
  const r = db.findOrCreateUserByOidc(id("ssoonly@x.com"));
  assert.ok(r.created);
  assert.throws(() => db.verifyUser("ssoonly@x.com", "anything-at-all"), /Wrong email or password/);
});

test("the SSO login is recorded in the audit log", () => {
  const r = db.findOrCreateUserByOidc(id("audited@x.com"));
  const org = db.listOrgs(r.id)[0];
  const log = db.listAudit(org.id, r.id);
  assert.ok(log.some((e) => e.action === "auth.sso_signup"));
});

console.log(`\nsso-db.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
