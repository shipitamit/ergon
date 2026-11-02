# Security

Ergon is an agent SDK plus a self-hostable Studio. This document covers how to
report a vulnerability and the security properties the collaboration tier is
built with. It is an engineering account, not a compliance certification — see
`docs/soc2-controls.md` for how these map to SOC 2 Trust Services criteria and
what is built versus a process the operator still owns.

## Reporting a vulnerability

**Please do not open a public issue for a security report.** Instead, report it
privately through GitHub Security Advisories:

> [**Report a vulnerability**](https://github.com/shipitamit/ergon/security/advisories/new)
> — github.com/shipitamit/ergon → **Security** tab → **Report a vulnerability**

This keeps the report confidential between you and the maintainers until a fix
is released. Include a description, reproduction steps, and the impact you see.

We aim to acknowledge within a few business days and to coordinate a fix and a
disclosure timeline with you.

## What the tier is built with

- **Authentication.** Email + password (hashed with bcrypt, or a `node:crypto`
  scrypt fallback), httpOnly + SameSite session cookies, and optional **SSO**
  via OpenID Connect (authorization-code + PKCE, nonce, signed state). SSO
  accounts carry a non-verifiable sentinel password hash, so they cannot be
  signed into with a password.
- **Authorization.** Access is org + RBAC only: every harness belongs to one
  organization, and a member's access is their org role (owner/admin → edit,
  member → view). Every harness, run, kv and org route enforces the role
  server-side.
- **Programmatic access.** Org-scoped **API keys** (service accounts): the
  secret is shown once and only its SHA-256 is stored; keys are confined to the
  harness / kv / run / gateway surface; revocation cuts access immediately.
- **Audit.** An append-only, per-org audit log records org, membership, harness,
  key, budget, and deployment changes, plus SSO sign-ins and data exports.
- **Spend & abuse controls.** Per-org budgets (spend caps / request quotas,
  enforced at run admission) and per-IP + per-org rate limiting (Redis-backed
  across instances when configured).
- **Data governance.** Per-org **data export** (portable JSON, secrets excluded)
  and owner-only **right-to-erasure** that deletes every org-scoped row and the
  service-account users its keys created.
- **Secrets.** Provider keys are read from the environment or an external secret
  manager (AWS/GCP/Azure adapters); they are never returned to the client and
  never written to the harness graph. `.ergon-settings.json` / `.key` are
  git-ignored.
- **Transport.** Intended to run behind HTTPS so the session cookie is `Secure`;
  set `NODE_ENV=production`.

## Honest limits

This is an app scaffold, not a hardened multi-tenant SaaS. A production
deployment should add HTTPS termination, a reviewed secrets pipeline, CSRF
hardening if moving off `SameSite=Lax`, dependency and image scanning, and an
independent security review. The SOC 2 controls matrix marks which items are
built in code versus a process the operator must run.
