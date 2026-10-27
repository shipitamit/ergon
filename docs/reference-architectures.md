# Reference architectures

Three topologies for running Ergon, from a laptop to a multi-instance fleet.
Each builds on the same two halves — the Studio app (accounts, orgs, runs,
gateway) and the SDK serve runner — and the same forward-only migrations.

## 1. Single-node (default)

Everything in one process, SQLite on disk. Zero dependencies to stand up; right
for a solo user, a demo, or a small team on one box.

```
┌─────────────────────────────┐
│  Studio (proxy + Vite)      │
│  routes.mjs → db.mjs (SQLite, WAL)   ergon.db
│  in-memory rate limiting             (file)
└─────────────────────────────┘
```

```bash
npm --prefix studio install && npm --prefix studio run dev
```

- Data: `ergon.db` (override with `ERGON_DB`). Back up with `npm run backup`.
- Limits: in-memory (per process). Fine with one instance.
- Not for: more than one app instance (SQLite is single-writer).

## 2. Postgres + Valkey HA

The production stack: a networked database and a shared rate-limit/cache store,
so the app can run as **multiple instances** behind a load balancer. This is the
default `docker-compose.yml`.

```
            ┌───────── load balancer ─────────┐
            ▼                                   ▼
   ┌───────────────┐                   ┌───────────────┐
   │ Studio inst. A│                   │ Studio inst. B│
   └──────┬────────┘                   └──────┬────────┘
          │  DATABASE_URL                     │  REDIS_URL
          ▼                                   ▼
   ┌───────────────┐                   ┌───────────────┐
   │ Postgres      │                   │ Valkey        │
   │ (pgvector)    │                   │ (rate limits) │
   └───────────────┘                   └───────────────┘
```

```bash
docker compose up --build        # set ANTHROPIC_API_KEY (+ SESSION_SECRET) in .env
```

- `DATABASE_URL` → `db.postgres.mjs`; migrations 0001–0010 run on start.
- `REDIS_URL` → cross-instance rate limiting (per-IP and per-org) via Valkey
  (Redis-protocol compatible).
- pgvector image so the RAG store works out of the box.
- Health: `/healthz`, `/readyz`; graceful shutdown; DB snapshots to a volume.

## 3. Serving fleet behind the gateway

Separate the **control plane** (the Studio app) from the **data plane** (served
harnesses). Each harness runs as an `ergon serve` instance; the Studio's gateway
is the tenant-aware edge that key-authenticates, enforces budgets + per-org
limits, records the run, and forwards to the right runner (registered as a
deployment's `target_url`).

```
   client ──Bearer <org API key>──▶  Studio gateway  /api/gw/<slug>/run
                                         │  (auth · budget · limit · record)
                                         ▼  forward
                          ┌──────────────┴──────────────┐
                          ▼                              ▼
                 ergon serve (harness A)        ergon serve (harness B)
                 docker: sdk/Dockerfile         (scale each independently)
```

- Publish: register a deployment (slug → harness + `target_url`) in the Studio.
- Scale: run N replicas of each `ergon serve` behind the runner's own LB; the
  gateway forwards to the `target_url`.
- Policy stays central: revoke a key, hit a budget, or change a limit in the
  Studio and the gateway enforces it on the next call — the runners stay simple.
- Serve image: `docker build -t ergon-serve ./sdk`; the compose `serve` profile
  (`docker compose --profile serve up serve`) runs one for a mounted harness.

## Choosing

| Need | Topology |
| --- | --- |
| Try it / solo / one box | 1 — single-node SQLite |
| Team, HA, multiple app instances | 2 — Postgres + Valkey |
| Many harnesses served as APIs, central policy | 3 — serving fleet + gateway |

Topologies 2 and 3 compose: the control plane runs on Postgres + Valkey, and the
serving fleet sits behind its gateway.

## Verifying the Postgres path

The data layer is dual-backend and the Postgres functions are logic-verified
offline (fake-pool parity in `backends.test.mjs`). To verify against a **real**
Postgres, the `pg-it` integration test boots the pgvector image and runs an
end-to-end smoke against it:

```bash
docker compose up -d db                # the pgvector Postgres service
DATABASE_URL=postgres://ergon:ergon@localhost:5432/ergon \
  node studio/server/pg_smoke.mjs      # runs the core flow on real Postgres
```

CI runs this automatically (`.github/workflows/pg-it.yml`) with a Postgres
service container, so the live wire is checked on every push — not just the
offline parity.
