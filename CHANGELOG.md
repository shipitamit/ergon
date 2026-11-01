# Changelog

All notable changes to Ergon. The SDK and Studio share one version and release
together (see [Versioning](#versioning)). This project adheres to
[Semantic Versioning](https://semver.org) and the spirit of
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

## [0.6.0] — 2026-11-01

Trust & operations. Rounds out the operability layer on top of 0.5.0's
observability + managed hosting: safety guardrails, human-in-the-loop approvals,
alert delivery, and eval-at-scale — the mechanical gaps that separate a capable
builder from one teams run in production.

### Added
- **Eval at scale.** Beyond the SDK's CI gate: named **eval datasets** per org
  (cases of `{input, expected, scorer}`) and stored, **scored runs** with a
  per-case breakdown and aggregate pass-rate/score. A deterministic server
  scorer (`eval-score.mjs`: exact / contains / not_contains / regex / numeric /
  json_valid, mirroring the SDK's) scores a run on record; `compareEvalRuns`
  surfaces **regressions and fixes** between two runs by case. Both backends,
  routes under `/api/orgs/:id/eval/*`, and a Studio **Evals** view (manage a
  dataset's cases, see pass-rate per run, drill into per-case results, compare
  the latest two). Runs are pushed via the API (`recordEvalRun`) from the SDK/CI.
- **Human-in-the-loop approval inbox.** A running agent (or a deployed runner,
  via its org key) can file an **approval request** and wait; a person reviews it
  in a Studio **Approvals inbox** and approves/rejects with a note. Per-org
  `approval_requests` store (both backends) with file / list / get / decide and
  pending-expiry; routes under `/api/orgs/:id/approvals` (members and runner keys
  file + poll, only a signed-in human decides). A new SDK `ApprovalClient`
  (`from_env()` on a managed runner) files and polls until decided — injectable
  HTTP + sleep, so the loop is offline-tested. This is the out-of-band
  counterpart to the in-process `ApprovalPolicy`.
- **Guardrails (SDK).** Drop-in safety checks attachable to an Agent via
  `input_guards=` (on the prompt, before the model) and `output_guards=` (on the
  final answer): `PIIGuard` (detect + redact emails/phones/cards[Luhn]/SSNs/
  IPs/API-keys), `ModerationGuard` (pattern blocklist or an injected model
  `classifier`), and `SchemaGuard` (output parses as JSON and matches a minimal
  JSON-schema shape). Each guard's `action` is redact / flag / block — a blocked
  input short-circuits before any model call, a blocked output is withheld; all
  deterministic and dependency-free, with `redact_pii` / `find_pii` /
  `apply_guards` usable standalone. Findings are logged to the session.
- **Alert delivery.** Alert rule transitions are now *sent*, not just recorded.
  Per-org **delivery channels** (webhook — structured JSON; Slack — incoming
  webhook) with owner/admin CRUD (`/api/orgs/:id/alert-channels`), a per-channel
  **test** ping, and a best-effort delivery module (`alert-delivery.mjs`, both
  over plain HTTPS POST so it's unit-tested offline). On each ok↔firing
  transition the evaluator fans out to the org's enabled channels — on the
  in-process tick and on a manual `…/alerts/evaluate` — so one failing channel
  never blocks the others. Studio gains a **Delivery channels** section in the
  Analytics → Alerts tab (add / test / delete). Email remains out (needs an SMTP
  provider; a webhook into an email service covers it meanwhile).

## [0.5.0] — 2026-10-31

Observability & managed hosting. Turns run data into an analytics, trace-search
and alerting surface, and lets Ergon operate a harness's runner itself (managed
cloud, MVP) instead of only routing to a self-run one — the two biggest gaps vs
the market-leading platforms.

### Added
- **Managed hosting (MVP).** Ergon can now operate a harness's
  runner itself, not just route to one the operator runs. A `managed_runners`
  store (both backends) plus a driver-agnostic lifecycle service (`hosting.mjs`):
  `provision` launches a runner through a **machines driver**, health-gates it,
  and — once ready — registers a deployment so the existing tenant-aware gateway
  (`POST /api/gw/:slug/run`) routes to it unchanged; `refresh` promotes a
  still-starting runner; `stop`/`restart` park and re-activate the deployment.
  Drivers: an in-memory `FakeMachinesDriver` (zero-infra default, also the test
  backend) and a `FlyMachinesDriver` (Fly.io Machines REST via an injectable
  HTTP transport, so its request shaping is tested offline), behind
  `makeMachinesDriver`. Endpoints under `/api/orgs/:id/runners` (owner/admin to
  mutate, members read). Config: `ERGON_HOSTING_DRIVER=fly` + `FLY_APP` /
  `FLY_API_TOKEN`; defaults to the fake driver. A Studio **"Deploy to Ergon
  Cloud"** view provisions a runner for a harness and shows status, URL, logs,
  and stop/restart/refresh/delete controls. **Secret provisioning** follows the
  Python export's model: rather than baking credentials into the machine image,
  a runner boots with a scoped, org-bound service API key + the server URL (and
  the list of connections its harness references) and resolves each connection's
  live material at run time via the existing key-authenticated resolver — no
  plaintext secret is written into the image or env. The scoped key is tracked
  on the runner and **revoked on teardown** (and if provisioning fails), so a
  removed or failed runner never leaves a live credential behind; `remove` also
  stops the machine and parks the deployment.
- **Observability — analytics & alerting (server-side).** Three additions over
  the runs store, both backends:
  - **Metrics API.** Org-scoped `metricsSummary` (`GET /api/metrics`): totals
    (run volume, error count + success rate, token and cost sums, average and
    p50/p95 latency), a time-bucketed series (`day`/`hour`) for trends, and a
    by-harness breakdown — all honouring a `from`/`to` window and a harness
    filter. (SQLite computes percentiles in JS over the retention-capped set;
    Postgres uses `percentile_cont`.)
  - **Trace search.** `searchRuns` (`GET /api/runs/search`): filter runs by a
    text query across input+output, exact status or any failure, latency and
    cost floors, time window, harness, with cursor pagination.
  - **Alert rules.** Per-org rules that watch a metric (`error_rate`, `spend`,
    `latency_p95`, `run_count`) over a lookback window and fire when it crosses
    a threshold. Owner/admin CRUD (`/api/orgs/:id/alerts`), member-readable
    events (`/api/orgs/:id/alert-events`), and a backend-agnostic evaluator
    (`alerts.mjs`) that records an event only on a state transition
    (ok↔firing) and runs on an in-process interval.
  - **Studio dashboard.** An "Analytics & alerts" view (signed-in) over the
    above: an Overview with metric tiles (runs, success rate, latency p50/p95,
    cost, tokens), runs/errors/cost sparkline trends and a by-harness table with
    a 24h/7d/30d range; a Trace-search tab (text query + failures-only); and an
    Alerts tab to create/toggle/delete rules, run an on-demand check, and read
    recent alert events.

## [0.4.0] — 2026-10-27

Durable runtime & production RAG. Makes multi-node flows and the trigger
scheduler crash-resilient, and turns RAG into a pluggable, offline-tested
adapter layer over the embedding providers and vector stores people run in
production.

### Added
- **RAG adapter set.** Production embedding providers (`CohereEmbedder`,
  `VoyageEmbedder`) and managed vector stores (`QdrantStore`, `ChromaStore`,
  `PineconeStore`, `WeaviateStore`, `MilvusStore`) that drop into the existing
  `Embedder` / `VectorStore` interfaces, plus `make_embedder` /
  `make_vector_store` factories. The managed
  adapters talk plain REST through an injectable HTTP transport that defaults to
  the standard library — no vendor SDK or `requests` dependency — so their
  request-shaping and response-parsing are unit-tested offline against a fake
  transport. New document loaders (`ergon.loaders`: text/markdown/csv/tsv in the
  stdlib, PDF via lazy pypdf, web pages with HTML stripped) back
  `KnowledgeBase.add_file` / `add_url` / `add_path`, each attaching a `source`
  for citation.
- **Durable trigger scheduler.** The schedule scheduler now *claims* each due slot
  with an atomic compare-and-swap on `next_fire_at` before firing, so overlapping
  ticks and multiple instances never double-fire a cron trigger; each fire is
  recorded in a durable `trigger_fires` log (unique per trigger+slot) with its run
  id and status. A slot that came due while the process was down is caught up on
  the next tick (at-least-once up to the claim), and a crash after the claim loses
  at most that one slot — not the whole schedule. Both backends.
- **Durable flow execution.** `Harness.run(store=…, run_id=…, resume=True)` makes a
  multi-node harness crash-resilient: each node's output is checkpointed to a store
  as it completes, and a resumed run (even in a different process) replays completed
  nodes without re-executing them — no duplicate model calls or tool side-effects.
  Stores: `FileCheckpointStore`, `SQLiteCheckpointStore` (shared-path cross-process
  resume), `MemoryCheckpointStore`. A graph fingerprint refuses a resume into an
  edited harness. Single-runner durable execution; distributed exactly-once and a
  durable trigger scheduler remain future work.

## [0.3.0] — 2026-10-26

Studio experience & integrations, completing the Phase 4 (Adoption & Trust) goals.

### Added — Integrations (event-driven + pick-and-connect)
- **Triggers.** Webhook triggers (a public, tokenised URL that starts a run when
  POSTed to) and cron **schedules** (5-field, UTC) driven by an in-process
  scheduler. A trigger runs on the harness's deployed runner; an undeployed
  harness records a clear "no-runner" outcome rather than failing silently.
- **Connector catalog + managed connections.** A browsable catalog (~14
  connectors across Messaging / Dev / Docs / CRM / Databases, plus HTTP and
  custom MCP) and a per-org **connection store**. Credentials are sealed at rest
  (AES-256-GCM), reads are secret-free (`configured` + `last4` only), and a
  connection is reusable across harnesses. A Custom Tool can be backed by a
  connection; the Python export resolves it at run time instead of inlining a
  secret.
- **Connection OAuth + runner-side resolver.** One-click OAuth 2.0 (PKCE, token
  auto-refresh) for connectors whose client credentials the operator has
  configured, with paste-a-token as the fallback. A key-authenticated resolve
  endpoint lets a deployed runner fetch a connection's live credential at run
  time — the plaintext never enters the harness or the export.

### Added — Studio collaboration
- **Live cursors** on the canvas (built on the presence layer), **node-anchored
  comments**, and **version history** with a visual diff and one-click restore
  (capped, append-only save history).

### Added — Studio builder experience
- **Canvas table-stakes:** zoom / minimap, palette search, port labels; inline
  node editing; a template gallery; typed-edge direction & differentiation;
  node icons + provider marks; live node-status badges during a run.
- **Editing ergonomics:** multi-select + copy / paste / duplicate, auto-layout,
  a ⌘K command palette, insert-node-on-edge (splice), sticky notes, and
  per-node output with single-node / partial runs.
- **Polish:** a measured accessibility pass (WCAG AA) and a first-class light
  theme; guided (simple) mode, a pre-run preflight, and clearer connecting.

### Added — Phase 4 (Adoption & Trust)
- **Hosted control plane (4.1).** A `deployments` registry (publish a harness
  under a slug) and a public, tenant-aware gateway `POST /api/gw/:slug/run`
  (+ `/run/stream`) that key-authenticates, enforces budgets + per-org limits,
  records the run, and forwards to a runner (`ergon serve`).
- **Compliance & data governance (4.2).** Per-org data **export** (portable
  JSON, secrets excluded) and owner-only **right-to-erasure**; `SECURITY.md`, a
  [SOC 2 controls matrix](docs/soc2-controls.md), and a
  [data-governance](docs/data-governance.md) doc.
- **OSS release kit (4.3).** This changelog, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SUPPORT.md`, issue/PR templates, and a curated
  [examples index](examples/README.md).
- **Benchmarks & reference architectures (4.4).**

### Fixed
- Router / conditional blocks now execute the branch they select (previously the
  chosen block could be skipped).
- Removed a duplicate top-level declaration in the Studio component that would
  break the production build (caught in a full validation pass).

### Docs
- Clarified the **multi-provider** story in the README and `.env.example`: Anthropic
  is the default, but the unified router reaches ~15 providers (OpenAI and any
  OpenAI-compatible endpoint — Azure, DeepSeek, Fireworks, Groq, Mistral, NVIDIA,
  OpenRouter, Perplexity, Together, vLLM, xAI — plus Gemini, Bedrock, and local
  Ollama), settable per agent via env var or **Settings → Keys**.

## [0.2.0] — 2026-08 (Phases 1–3)

### Phase 3 — Production Operations & Serving
- **Serving.** `ergon serve <harness>` exposes a harness as REST (`/run`) + SSE
  (`/run/stream`) with health probes, bearer auth, a concurrency cap, and a
  Dockerfile; a Studio **Deploy** snippet; `ergon` CLI (`run`/`serve`/`eval`).
- **Run history & traces.** `RunRecorder` in the SDK; a per-org `runs` store
  (migration 0008) with a Studio **Runs** list + per-run trace viewer.
- **Evaluation & regression gates.** `json_schema` scorer, report save/compare,
  and `ergon eval --gate --baseline` with CI exit codes.
- **Budgets & quotas.** Per-org spend caps + request quotas (migration 0009)
  enforced at run admission (402 over budget).

### Phase 2 — Enterprise & Governance
- **Organizations + RBAC** (migration 0004): harness access is the member's org
  role (owner/admin → edit, member → view); personal org on signup.
- **Audit log** (migration 0005): append-only, per org.
- **SSO** (migration 0006): OpenID Connect (authorization-code + PKCE).
- **Service accounts / API keys** (migration 0007) + per-org rate limits.

### Phase 1 — Core orchestration parity
- Cyclic & conditional flows (`branch`, `loop`); step checkpoints & resume; a
  template gallery; a generated static docs site.

### Baseline (0.2.0 foundation)
- Agent loop, approval, retries, streaming, compaction, token/cost accounting;
  providers + unified routing; RAG (pgvector), MCP, browser
  control; the Studio canvas, codegen, live preview, and accounts tier (SQLite
  default, Postgres via `DATABASE_URL`).

## Versioning

`vMAJOR.MINOR.PATCH` tags at the repo root cover both halves. A change usually
touches the SDK and Studio together, so lockstep releases keep the generated
code and the runtime in sync. Database changes ship as forward-only migrations
(`studio/server/migrations.mjs`, currently 0001–0011); newer tables (triggers,
connections, version history) are also created idempotently at startup.

[Unreleased]: https://example.com/ergon/compare/v0.6.0...HEAD
[0.6.0]: https://example.com/ergon/compare/v0.5.0...v0.6.0
[0.5.0]: https://example.com/ergon/compare/v0.4.0...v0.5.0
[0.4.0]: https://example.com/ergon/compare/v0.3.0...v0.4.0
[0.3.0]: https://example.com/ergon/compare/v0.2.0...v0.3.0
[0.2.0]: https://example.com/ergon/releases/tag/v0.2.0
