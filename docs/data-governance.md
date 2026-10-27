# Data governance

What Ergon's collaboration tier stores, where it lives, how long it's kept, and
how to get it out or delete it. The SDK on its own is stateless beyond local
session files; this document is about the Studio's server-side data layer.

## What is stored

All server data lives in one database (SQLite by default, or Postgres via
`DATABASE_URL`). Tables:

| Table | Holds | Notes |
| --- | --- | --- |
| `users` | email, password hash, created-at | SSO accounts carry a sentinel hash; service accounts use the `svcu_` id prefix |
| `sessions` | opaque session tokens | httpOnly cookie value |
| `orgs`, `org_members` | organizations and role membership | access model |
| `harnesses` | the harness graph JSON, per org | the user's designed agents |
| `runs` | per-run input/output, status, latency, tokens, cost, step timeline | retention-bounded |
| `audit_log` | append-only security events, per org | actor, action, target, timestamp |
| `api_keys` | key metadata + **SHA-256 hash** (never the secret) | org-scoped |
| `budgets` | spend caps / request quotas | per org, per period |
| `deployments` | published slug → harness + runner URL | per org |
| `identities` | OIDC subject → user | SSO linkage |
| `kv` | per-user run-session / timeline values | keyed by user |

Provider API keys are **not** stored in the database — they come from the
environment or an external secret manager and are never written to a harness
graph or returned to the client.

## Retention

- **Run history** is capped per org by `ERGON_RUNS_KEEP` (default 500); older
  runs are pruned automatically on write.
- **Audit log** is retained in full (append-only); prune with operator policy if
  required by your retention rules.
- Other tables persist until the owning user or org deletes them.

## Export (data portability)

An owner or admin can export an organization's data as portable JSON:

```
GET /api/orgs/:id/export
```

The bundle includes the org, members (email + role), harness graphs, run
metadata (up to 1000 most-recent), the recent audit log, budgets, deployments,
and API-key metadata. **Secrets are excluded** — no password hashes, no key
hashes, no plaintext key material. The export itself is recorded in the audit
log.

## Right to erasure

An **owner** can permanently erase an organization and all of its data:

```
DELETE /api/orgs/:id
```

Erasure deletes every org-scoped row — deployments, budgets, runs, audit log,
API keys, harnesses, and memberships — and the service-account users the org's
keys created, then the org record itself, in a single transaction. Real human
users and other organizations they belong to are untouched. This is
irreversible; take an export first if you need a copy.

## Operator responsibilities

Encryption at rest and in transit, database backups and their off-site storage,
access to the database host, and an end-user privacy notice are operator
controls — see `docs/soc2-controls.md`.
