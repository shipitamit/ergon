# SOC 2 controls matrix

How Ergon's built-in features map to the SOC 2 Trust Services Criteria (TSC).
This is a **readiness aid**, not an attestation: a SOC 2 report is issued by an
independent auditor against your operating environment over a period. The point
here is to show which controls the software already implements, which are
partial, and which are a process the operator (you) must run.

Status legend: **Built** = implemented in code and tested · **Partial** =
mechanism exists, operator configuration/discipline completes it · **Process** =
not code; an organizational control.

## Security (Common Criteria)

| TSC area | Control | Ergon feature | Status |
| --- | --- | --- | --- |
| CC6.1 Logical access | Authentication | Password (bcrypt/scrypt) + httpOnly/SameSite sessions; OIDC SSO (PKCE) | Built |
| CC6.1 | Role-based authorization | Org + RBAC on every route (owner/admin/member) | Built |
| CC6.1 | Programmatic credentials | Org API keys: hashed-at-rest, shown once, scoped, revocable | Built |
| CC6.2 | Provisioning / deprovisioning | Member add/remove; key revoke; SSO account linking | Built |
| CC6.3 | Least privilege | API keys confined to harness/kv/run/gateway; member = view | Built |
| CC6.6 | Boundary protection | Per-IP + per-org rate limiting; gateway key-auth | Built |
| CC6.7 | Transmission | HTTPS + `Secure` cookies when `NODE_ENV=production` | Partial (operator terminates TLS) |
| CC6.1 | Secret management | Env / external secret managers; never returned to client | Partial (operator pipeline) |
| CC7.2 | Monitoring | Append-only per-org audit log; run history | Built |
| CC7.2 | Anomaly / alerting | OTLP telemetry export (Langfuse/Grafana) | Partial (operator wires alerts) |
| CC7.3/7.4 | Incident response | Vulnerability reporting (`SECURITY.md`) | Process |
| CC8.1 | Change management | Forward-only migrations; CI test suite; semver releases | Built (code) / Process (approvals) |

## Availability

| Control | Ergon feature | Status |
| --- | --- | --- |
| Backups | `npm run backup` (gzipped DB snapshots) + documented restore | Partial (operator schedules + off-sites) |
| Horizontal scale | Postgres data layer + Redis-shared rate limiting; health/readiness probes | Built |
| Capacity controls | Per-org budgets + quotas | Built |

## Confidentiality

| Control | Ergon feature | Status |
| --- | --- | --- |
| Data classification | Field-aware redaction in session logs | Built |
| Secret handling | Secrets never persisted to graphs or returned to clients | Built |
| Retention | `ERGON_RUNS_KEEP` run retention; documented data lifecycle | Partial (operator sets policy) |

## Privacy

| Control | Ergon feature | Status |
| --- | --- | --- |
| Access / portability | Per-org data **export** (portable JSON) | Built |
| Right to erasure | Owner-only org **erase** (all org-scoped rows + key svc users) | Built |
| Consent / notice | Privacy notice to end users | Process |

## What's explicitly not covered by the software

A SOC 2 engagement also requires organizational controls the code cannot
provide: personnel security and onboarding/offboarding, vendor management, a
risk-assessment program, formal change-approval records, physical/datacenter
controls (inherited from your cloud provider), and continuous monitoring with
an on-call/incident process. Use the "Built" rows as evidence and the
"Partial/Process" rows as your implementation checklist.
