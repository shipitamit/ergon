# Ergon Studio

> Part of the [Ergon monorepo](../README.md) — this is the `studio/`
> subproject. Run the commands below from this directory (`cd studio`), or use
> `npm --prefix studio <script>` from the repo root.

The drag-and-drop harness builder as a Vite + React project. Node is
needed to **build and develop**; the production output is static files plus a
small Node proxy that holds your API key. The proxy is zero-dependency by
default; enabling accounts (below) adds SQLite + bcrypt.

## Requirements

- Node.js ≥ 18 (the proxy uses built-in `fetch`)
- API key(s) for the providers you use: set them as environment variables
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, …;
  see `.env.example`) **or** add them in the UI's **Keys** panel — no env or
  restart needed (see *Providers, keys & models* below)

## Develop

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev          # starts the key-holding proxy (:8787) + Vite (:5173)
```

Open http://localhost:5173. The browser posts to `/api/model` with a
provider tag; Vite forwards it to the proxy, which routes to the right
upstream (Anthropic / OpenAI-compatible / Gemini) and attaches the matching
key server-side — keys never ship to the client. The legacy `/api/claude`
endpoint is kept for older builds.

## Production

```bash
npm run build        # emits static files into dist/
export ANTHROPIC_API_KEY=sk-ant-...
npm start            # one Node process: serves dist/ AND proxies /api/model
```

Or host `dist/` on any static host (nginx, S3+CloudFront, GitHub Pages) and
run `server/proxy.mjs` wherever you like — just route `/api/model` to it.

## Providers, keys & models (minimum-effort setup)

Getting an agent running takes no terminal and no guessing — the three pieces
work together and all map onto the SDK router's provider prefixes
(`server/providers.mjs` mirrors `ergon/router.py`):

- **Provider picker.** The agent's **Provider** dropdown is fed from
  `GET /api/providers` — 15 provider families (OpenAI, Anthropic, NVIDIA, Groq,
  Together, Mistral, DeepSeek, Fireworks, OpenRouter, Perplexity, xAI, vLLM,
  Azure, Ollama, Gemini) plus Bedrock = 16 picker options; aliases (`claude`,
  `nim`, `google`, `aws`) resolve to their family. Picking one prefills its
  endpoint and shows whether a key is configured; no need to remember base URLs.
- **Live model dropdown.** The **Model** field has a **⟳ load** button that calls
  `GET /api/models?provider=<prefix>`, which hits that provider's own
  `/v1/models` and fills a dropdown with *currently callable* model ids — so a
  retired or mistyped id is no longer possible to pick. Still free-text if you'd
  rather type one.
- **Keys panel.** The top-bar **Keys** button opens a panel to paste a key,
  **Test** it (a one-shot connectivity check via `POST /api/provider/test`), and
  **Save** it (`POST /api/provider/settings`). Saved keys are encrypted at rest
  (AES-256-GCM; key from `ERGON_SETTINGS_SECRET`/`SESSION_SECRET`, else a
  generated `0600` key file) in `.ergon-settings.json`, take precedence over env
  vars, and never leave the server — status shows only `••••last4`.

Precedence everywhere: a **UI-saved key wins, else the provider's env var**, so
you can inject keys with env/secrets-manager in production and still let users
fill gaps in the UI during development. A chosen provider also flows into the
exported Python as a unified-routing spec — `Agent(provider="nvidia/meta/llama-…")`.

> In the Claude artifact build there is no proxy, so the picker falls back to a
> small static list, the live model/Keys features are hidden, and the preview
> runs on Claude (the provider still applies to the exported Python / standalone
> app) — exactly as the model preview already degrades there.

## Accounts & collaboration (optional)

By default the app is single-user and stores everything in the browser
(`localStorage`). Enabling the collaboration tier adds email/password
accounts, server-side persistence, and org-based access control — all backed by a
single SQLite file, still one Node process.

```bash
npm run enable-accounts      # installs better-sqlite3 + bcryptjs
npm run dev                  # sign-in button now appears in the app
```

Without those two packages the server runs exactly as before (pure model
proxy, browser storage) — the tier is strictly opt-in.

**What it does**
- **Accounts** — sign up / sign in with email + password. Passwords are
  bcrypt-hashed; the session is an httpOnly cookie.
- **Server-side storage** — once signed in, the harness library *and* run
  sessions/timeline move to the server, scoped to your account, so they
  follow you across browsers and machines. (The app switches its storage
  backend automatically — same code path, different adapter.)
- **Organizations (the access model)** — access is **org + RBAC only**: every
  harness belongs to exactly one organization, and a member's access is purely
  their org role — **owner**/**admin** → edit, **member** → view. Signup
  auto-creates a **personal org** ("your workspace") so a solo user never thinks
  about orgs; new harnesses land there by default. To collaborate, add people to
  an org (`POST /api/orgs`, `GET/POST/DELETE /api/orgs/:id/members`) and assign a
  harness to it (`POST /api/harnesses/:id/org`); everyone in the org gets access
  by role — there's no per-harness sharing. Owner/admin manage membership and can
  delete harnesses; the last owner can't be removed. Manage it in the UI from the
  **Orgs** button (top bar, when signed in): create orgs, add/remove members with
  roles, and move the open harness into an org.
- **Audit log (per org)** — every security-relevant mutation appends an
  append-only entry to its org's log: `org.create`, `member.add`,
  `member.remove`, and `harness.create` / `harness.update` / `harness.delete` /
  `harness.move` (a move records in both the source and destination org). Each
  entry keeps the actor, action, target, a small JSON `detail`, and a timestamp.
  Only an **owner** or **admin** can read it (`GET /api/orgs/:id/audit`,
  paginated with `limit` ≤ 500 and a `before=<ts>` cursor, newest-first); the
  Orgs modal shows it under **Activity log** for a selected org. Logging is
  best-effort — it never blocks or fails the action it records.
- **Concurrent-save guard** — saves use optimistic concurrency: the version
  you loaded is checked against the server on save. If someone else saved in
  the meantime, you get a conflict dialog (Overwrite / Discard mine & load
  theirs / Cancel) instead of silently clobbering their work.

- **Single sign-on (SSO)** — optional enterprise login via OpenID Connect
  (authorization-code flow with PKCE, nonce, and a signed one-shot state
  cookie). Turn it on with three env vars — `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_REDIRECT_URI` (plus optional `OIDC_CLIENT_SECRET`, `OIDC_SCOPE`,
  `OIDC_STATE_SECRET`) — and `npm run enable-sso` (installs `jose` for JWKS
  signature verification). The sign-in dialog then shows **Sign in with SSO**
  (`GET /api/auth/providers` advertises it); `GET /api/auth/sso/login` →
  identity provider → `GET /api/auth/sso/callback`. On first login a user +
  personal org are provisioned; a verified email links onto an existing
  password account; the external identity (`provider`, `subject`) is stored in
  an `identities` table. Password login to an SSO-provisioned account is
  impossible (sentinel hash), and the sign-in is recorded in the audit log.
  `jose` is loaded lazily, so the server still boots (and password auth still
  works) if it isn't installed — SSO is just reported as unavailable.

- **Service accounts & API keys** — programmatic access for CI, scripts and
  automation. An owner/admin mints a key (`POST /api/orgs/:id/keys` with a
  `name` and `role` of `member` = read or `admin` = read/write); the plaintext
  secret (`esk_…`) is shown **once** and only its SHA-256 is stored. Callers
  authenticate with `Authorization: Bearer <secret>` instead of a cookie. Each
  key is backed by a hidden service-account user that's a member of the key's
  org at the key's role, so all the existing RBAC applies unchanged — but keys
  are confined to the data surface (`/api/harnesses`, `/api/kv`); they can't
  touch org administration or auth. Revoking (`DELETE /api/orgs/:id/keys/:keyId`)
  cuts access immediately. Issue, list and revoke from the Orgs modal; issuing
  and revoking are audit-logged.
- **Per-org rate limits** — API-key traffic is throttled per organization (a
  fixed window keyed by org id, Redis-backed when `REDIS_URL` is set, else
  in-memory), so one org's automation can't exhaust the service for others. The
  human cookie routes keep the existing per-IP throttle.
- **Data governance** — an owner/admin can **export** an org's data as portable
  JSON (`GET /api/orgs/:id/export`, secrets excluded, recorded in the audit log),
  and an **owner** can **erase** an org (`DELETE /api/orgs/:id`) — every
  org-scoped row plus the service-account users its keys created, in one
  transaction, leaving real users and other orgs untouched. The Orgs modal has
  an **Export data** button; erase is API-only (irreversible). See
  `SECURITY.md`, `docs/soc2-controls.md`, and `docs/data-governance.md`.
- **Hosted control plane** — publish a harness as a named endpoint and front it
  with one tenant-aware gateway. An owner/admin registers a **deployment**
  (`POST /api/orgs/:id/deployments` with a `slug`, optional `harnessId` and a
  runner `targetUrl`); the public gateway `POST /api/gw/:slug/run` (+ `/run/stream`)
  resolves the slug, authenticates with the org's **API key** (Bearer),
  enforces the org **budget** and per-org limit, **records the run**, and
  forwards to the runner (an `ergon serve` endpoint). A deployment with no
  runner attached returns 503; a key from another org is rejected (403). Manage
  deployments in the Orgs modal under **Deployments**. The gateway is the edge —
  auth, policy and routing; the compute stays in the SDK serve behind it.
- **Budgets & quotas** — per-org spend caps and request quotas over a `day`,
  `month`, or `total` window. An owner/admin sets them (`POST /api/orgs/:id/budgets`
  with `{period, maxCost, maxRequests}`, one row per period); members read live
  status (`GET /api/orgs/:id/budgets/status`: spend and request count vs the cap,
  with exceeded flags). Enforcement is at **run admission**: spend and requests
  are summed from the recorded runs in the window, and once a cap is reached
  `POST /api/runs` returns **402** (the run is refused) until the window rolls
  over or the cap is cleared. Set and watch them in the Orgs modal under
  **Budgets & quotas**; tune the window from the client with a pre-run status
  check. `ERGON_RUNS_KEEP` retention does not affect caps within the live
  window.
- **Run history** — every preview (or served/automated) run can be recorded:
  input, output, status, latency, token/cost usage, and the step/tool timeline.
  Runs are per-org (access = org membership); record with `POST /api/runs`
  (`{harnessId|orgId, input, output, status, usage, steps, ...}`), list with
  `GET /api/runs?orgId=&harnessId=`, and read one with `GET /api/runs/:id`.
  Retention keeps the newest `ERGON_RUNS_KEEP` (default 500) per org. The Studio
  **Runs** button lists recent runs and opens a per-run trace; API keys may
  record and read runs (within their org) alongside the harness/kv surface.

**Data** lives in `ergon.db` (SQLite, WAL mode; override the path with
`ERGON_DB`). Tables: users, sessions, orgs, org_members, harnesses (each with an
`org_id`), audit_log (append-only, per org), identities (SSO subject → user),
api_keys (service accounts), runs (run history, per org), budgets (spend caps /
request quotas, per org), deployments (hosted control plane, per org), and a
per-user kv store for run-sessions. The driver prefers `better-sqlite3` but falls back
to Node's built-in `node:sqlite` (Node ≥ 22) if it isn't installed, and
passwords use `bcryptjs` when present or a `node:crypto` scrypt hash otherwise
— so the tier works even before you run `enable-accounts`, though installing
the real deps is recommended for production.

**Testing the signed-in flow.** `npm run test:auth` boots the real server on an
ephemeral port and drives the whole flow over HTTP — signup, cookie sessions,
harness save, org membership, role enforcement (owner/admin edit, member view),
kv isolation, and logout — using an in-memory DB and the built-in fallbacks, so it needs no
external deps. This exercises the actual routes, cookies, and access checks
end-to-end (not a browser, but real HTTP). A live browser pass is still worth
doing once before relying on the tier in production. `npm run test:sso` covers
the OIDC core offline — PKCE, the sealed state cookie, discovery, token
exchange, id_token claim checks (with an injected verifier, no `jose` needed),
and identity provisioning/linking against the real data layer. `npm run
test:apikeys` covers service-account issuance, one-time secrets, bearer
verification, role mapping, and revocation; `test:auth` drives the full bearer
flow (list/get/save, the admin-route block, and revocation) over real HTTP.

**Security note.** Auth is implemented with care — hashed passwords, httpOnly
+ SameSite cookies, and server-side ownership/role checks on every harness and
kv operation. But this is an app scaffold, not a hardened SaaS: a real
deployment should add HTTPS (so the session cookie is `Secure`), rate
limiting on the auth routes, CSRF hardening if you move off SameSite=Lax, and
a security review. SQLite suits small teams; swap `server/db.mjs` for a
Postgres-backed module with the same exports to scale (the SQL is portable).

The Claude-artifact build has no server, so accounts/orgs are inert there;
this tier is a standalone-app feature.

## Layout

```
├── index.html               Vite entry shell
├── vite.config.js           dev proxy /api → :8787
├── server/
│   ├── proxy.mjs            model-routing proxy + static server (prod)
│   ├── routes.mjs           auth / harness / share / kv routes (accounts tier)
│   ├── db.mjs               SQLite data layer (accounts tier)
│   └── auth.test.mjs        over-HTTP test of the signed-in flow (npm run test:auth)
└── src/
    ├── main.jsx             React mount
    ├── ErgonStudio.jsx the whole studio (canvas, inspector, runner, codegen)
    └── storage.js           storage shim (localStorage ⇄ server API) + auth/cloud clients
```

## Editing

- **Undo / redo** (⌘Z / ⌘⇧Z, or the ↶ ↷ toolbar buttons) covers adding,
  moving, connecting, deleting, and config edits — up to 50 steps. Rapid
  typing in a field coalesces into one undo step.
- **Import / Export JSON** round-trip a harness. Import backfills any config
  fields missing from harnesses saved by older versions and drops edges that
  reference missing blocks (reporting what it changed).
- **Graph validation** runs continuously. The toolbar badge shows `✓ valid`,
  a warning count, or an error count; click it for the full list. Each item
  links to the offending block, which is also outlined on the canvas
  (red = error, amber = warning). Runs are blocked while hard errors exist
  (no Input, no Agent, invalid iteration limit, corrupt edges).

## Harness library, meter & flow nodes

- **Harness library** (☰ Library): save named harnesses, reopen, duplicate,
  or delete them. Name a harness in the top bar and press ⤓ Save (⌘S). Signed
  out, harnesses live in the browser (`ergon:lib:*` keys); signed in, they're
  stored on the server with org-based roles (see Accounts & collaboration).
- **Templates** (in the library panel): one-click starter harnesses that load a
  working graph onto the canvas — *Single agent*, *Draft + critique*, *Router
  triage*, *Conditional branch*, *Parallel + join*, and *Looping worker*. Each
  is a complete, runnable example of one canvas pattern; edit it or save it as
  your own.
- **Spend budget** (⛔ Budget, top bar): set a run-wide ceiling on total tokens
  and/or cost. The run stops before the next model call once either cap is
  crossed, logging a `budget_exceeded` event. Exports to the SDK as
  `max_total_tokens` / `max_cost` on every generated agent. Blank = off.
- **Light / dark theme** (☀ / ☾, top bar): toggle between a dark indigo-slate
  and a warm light theme; the choice persists across sessions. Node role-colors
  are retuned for each theme so they stay distinct, and transitions respect
  `prefers-reduced-motion`.
- **Token & cost meter**: a live counter in the top bar totals tokens and
  estimated USD across a run (per-model breakdown on hover), with per-call
  lines and a run-total in the trace. Pricing is a table in the component —
  estimates, editable. Bedrock/unknown models count as $0.
- **Router node** (⑃): classifies the input into one of your labels and routes
  flow to the matching downstream agent. Drag its bottom port to each agent;
  the chosen one is matched by name to the picked label.
- **Conditional node** (◇): branches flow by a plain rule on the text — no model
  call. Write one rule per line (`contains urgent -> urgent`, `longer_than 280 ->
  detailed`, `regex \d+ -> code`, `else -> quick`); the first match wins and
  dispatches to the same-named agent. Deterministic, so it's free and repeatable.
- **Parallel node** (⑈): fans the input out to several worker agents that run
  concurrently, then either merges their outputs with a joiner model call or
  concatenates them. Drag its bottom port to each worker.
- **Agent loop**: turn on *Loop until complete* in an agent's Advanced tab to
  repeat it until the completion marker appears or a round cap is hit (exports to
  `run_until`).
- **Step checkpoints**: turn on *Step checkpoints* in an agent's Advanced tab to
  write a resumable snapshot after every model call, so a crashed run resumes
  from a step rather than only the last message (exports to `checkpoints=True`;
  resume with `run(resume_from=…)`).
- Router, Conditional and Parallel export to the SDK's `route()` / `branch()` /
  `parallel()` helpers in the generated Python.
- **Router validation** cross-checks each label against its connected agents:
  it warns about labels with no same-named agent (routing would fall back to
  position order), connected agents that match no label, duplicate labels, and
  more agents than labels. Matching is case-insensitive, mirroring runtime.

> **Note on severity.** All router/parallel checks are *warnings*, not errors,
> so they don't block a run — positional fallback is a valid (if surprising)
> way to route. If you want a hard label/agent mismatch to block runs the way
> a missing Input does, change the relevant `level: "warn"` to `level: "error"`
> in `validateGraph` (in `src/ErgonStudio.jsx`); the run guard already
> stops on any error. Keep this deliberate: validation is only useful while it
> agrees with what execution actually does, so match severity to real risk
> rather than flagging everything as fatal.

## Timeline & trace inspection

The bottom console has two run views:

- **Trace** — the narrative log (turns, tool calls, approvals, compactions).
- **Timeline** — one row per model/tool call with a proportional **duration
  bar**, the agent that ran (color-dotted), token counts, and latency in ms.
  A footer totals calls and wall-time. Click any row to **jump to the exact
  message** it produced in the run's history (with prev/next navigation).
  Click a compaction row to open a **before/after diff** showing which
  messages were summarized and the token savings.
- Each model-call bar shades its **network portion** (the API round-trip)
  darker than its total, and the ms figure's tooltip splits network vs harness
  overhead — so preview latencies are interpretable, not just relative.
- **Opening a past run** from the Sessions tab loads *that run's* timeline and
  history (persisted per session), so click-through and the diff view reflect
  the archived run, not the live one. A banner marks when you're viewing a
  past run; starting a new run or pressing "clear" returns to live. The
  top-bar token/cost meter follows suit — it recomputes from the viewed run's
  events (shown with a ⏱ "past run" marker) instead of the live totals.

The Timeline footer has a **⤓ events.jsonl** button that downloads the run's
events as JSONL — one event per line, matching the shape the SDK writes to
`events.jsonl` — so a preview run can be inspected with the same tooling as an
SDK run. It works for live runs and for past runs opened from the Sessions tab.

This is the in-app read-out of the same structured events the SDK writes to
`events.jsonl` (`session.events()`), complementing the OpenTelemetry spans.

The per-agent **OpenTelemetry** toggle (Advanced tab) is SDK-only: it exports as
`telemetry=` in the generated Python. Those spans use the `gen_ai.*` semantic
conventions and go to whatever OTLP backend you configure — Langfuse, Grafana
Tempo, Honeycomb, Datadog — by setting `OTEL_EXPORTER_OTLP_ENDPOINT`. No
vendor-specific code is involved; see the SDK README's *Sending traces to
Langfuse, Grafana, or any OTLP backend*.

## Harness features in the UI

- **Run preview** executes the real loop: iteration limits, kill switch,
  plan-mode tool freezing, compaction, live todo/files/memory panels.
- **Sessions tab**: history persists after every model call; ▸ inspects a
  run, ↺ **resumes** a crashed or stopped run from where it left off
  (mirrors the SDK's `run(..., resume=True)`).
- **Approval prompts** are y / a / n like the SDK — `a` writes a standing
  "always allow" rule into the agent's Safety tab, the exported JSON, and
  the generated Python.
- **Workspace** (todo list, memory notes, virtual files) persists across
  runs and reloads; "Clear workspace" in the console bar resets it. Note:
  the preview uses one shared workspace per harness, while the SDK gives
  each agent its own session directory.

## Custom tools

A custom-tool node has three behaviors, chosen in the inspector:
- **Simulated by Claude** (default) — the model fabricates plausible output, for
  prototyping agent *flow* before any tool exists. Because the output is
  invented (not real data), simulated results are tagged **⚠ simulated** in the
  trace, the timeline, and the exported `events.jsonl`, so a preview result is
  never mistaken for a real one.
- **Real JavaScript** — a function body that runs in the browser preview.
- **HTTP endpoint** — calls a real API: give it a URL, method (POST sends
  `{"input": …}`, GET appends `?input=…`), and optional headers. The preview
  routes the call through the dev proxy to avoid CORS; the proxy blocks
  loopback/private hosts (a basic SSRF guard). Exported Python becomes a real
  `requests` call.

Whichever mode you pick, the exported Python and the headless bridge expect a
real implementation — simulate/JS become stubs to fill in, while HTTP exports a
working `requests` call. Don't store long-lived secrets in a shared harness.

## Knowledge base (RAG)

Enable a **Knowledge base** on an agent to let it ground answers in your
documents via retrieval. It exports a `KnowledgeBase` + `retrieve_tool(...)` into
the generated Python — in-memory by default, or `PgVectorStore(dsn=...)` when you
set a pgvector DSN, with the embedding model configurable. Ingesting and
retrieving run SDK-side; the Studio exports the wiring (and a placeholder
`add_texts([...])` for your documents) rather than embedding in the browser.

## MCP servers

Give an agent an **MCP** (Model Context Protocol) server in its Advanced tab — a
stdio command (e.g. `npx -y @modelcontextprotocol/server-filesystem .`) or an
HTTP URL — and it inherits that server's whole tool set. The exported Python
emits `MCPClient.stdio(...)` / `.http(...)` plus `*mcp_tools(...)`, so a
Studio-designed MCP agent runs unchanged on the SDK. MCP tools are
approval-gated by default (a third-party server's tools can do anything); list
the ones safe to auto-run in the agent's MCP config, which exports as
`safe_tools=[...]`. Enable **Prompts** to expose the server's prompt templates (exports as
`*mcp_prompt_tools(...)`), and for a hosted server that needs **OAuth**, set the
OAuth fields in the MCP config — it exports an `MCPOAuth(...)` passed to
`MCPClient.http(url, auth=...)`. Enable **Resources** in the MCP config to also expose the server's readable data
(files, records, documents) to the agent — it exports as `*mcp_resource_tools(...)`
(two read-only tools: list and read). Running MCP servers is SDK-side — the preview shows the
wiring and exports it rather than launching servers in the browser.

## Browser control

Toggle **Browser control** in an agent's Advanced tab to give it a real
Chromium browser (Playwright): navigate/read/find (safe) plus click/type/submit
(approval-gated). The sub-toggle "Allow browser actions unattended" auto-allows
the act-tools — leave it off unless the agent only visits trusted sites.

**Where it runs:**
- **Standalone app preview** — yes. The proxy drives a headless Chromium via
  `/api/browser`. Install it once with `npm run enable-browser` (adds Playwright
  + downloads Chromium). Without it, browser calls return a clear "install
  Playwright" message instead of failing. Sessions are per-run and auto-expire.
- **Exported Python (SDK)** — yes, via `BrowserSession` + `browser_tools`
  (`pip install ergon[browser]`; `playwright install chromium`).
- **Claude artifact** — export-only (no server to launch a browser).

Navigation is SSRF-guarded (internal/loopback hosts blocked) in both the proxy
route and the SDK. Never point a browsing agent at untrusted sites with actions
enabled — page text is a prompt-injection surface.

## Local models (Ollama)

Select **Ollama (local models)** as an agent's provider to run against a local
Ollama server — no API key, no cost. The endpoint defaults to
`http://localhost:11434/v1` (editable per agent for a remote host). The preview
routes there through the dev proxy, so run `ollama serve` and `ollama pull
<model>` first; the exported Python uses `provider="ollama"`. Local runs are
billed at $0 in the meter, and tool-calling quality depends on the model
(`llama3.1`, `qwen2.5` and other tool-capable models work best).

## Security

The model proxy and collaboration server include baseline hardening:
- **Request size caps** — every endpoint reads bodies with an 8 MB ceiling
  (rejects oversized POSTs with 413) to prevent memory-exhaustion.
- **Rate limiting** — login/signup is throttled to 10 attempts per 15 min per IP
  (brute-force guard); model and data routes have per-IP request throttles.
- **HTTP-tool SSRF guard** — `/api/tool-fetch` blocks non-HTTP(S) URLs and
  internal/loopback/link-local/metadata hosts, does **not** follow redirects
  (which could bounce to an internal host), and caps the response at 1 MB.
- **Security headers** — `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and a restrictive `Permissions-Policy` on
  every response.
- **Auth** — passwords are bcrypt/scrypt-hashed (8-char minimum, timing-safe
  compare); sessions are opaque tokens in `HttpOnly`, `SameSite=Lax`,
  `Secure`-in-production cookies; harness/kv access is ownership- and
  role-checked server-side.

These are sensible defaults, not a substitute for a security review before a
public deployment (add HTTPS and secret management for production).

### Scaling backends (multi-instance)

By default the app is single-instance: SQLite for data, in-memory rate limiting.
Behind a load balancer that's not enough — each instance would have its own
SQLite file and its own rate-limit window (so an attacker gets N× the limit
across N instances). Two optional backends fix this, each a drop-in chosen by an
env var:

```bash
npm run enable-scale                                  # installs pg + redis
export DATABASE_URL=postgres://user:pass@host/ergon   # → Postgres data layer
export REDIS_URL=redis://host:6379                     # → shared rate limiting
npm start
```

- **Postgres** (`DATABASE_URL`) replaces SQLite as the accounts/harness/share
  store, so every instance shares one database. Same schema, same optimistic-
  concurrency conflict handling. Falls back to SQLite if `pg` isn't installed.
- **Redis** (`REDIS_URL`) moves rate-limit counters into a shared store, so the
  window is enforced across all instances (fixed-window via `INCR`/`PEXPIRE`).
  Falls back to in-memory if `redis` isn't installed or can't connect.

Both are **verified in logic** (see `server/backends.test.mjs` — window
counting, TTL, optimistic concurrency, parameterized queries) but have **not
been validated against a live Postgres/Redis in this build** — do that in your
own environment before relying on them. Still to add for a hardened multi-
instance deployment: TLS to both stores, connection-pool tuning, resolution-time
SSRF IP checks, and a secrets manager for the URLs and `SESSION_SECRET`.

### Secrets management

By default secrets (provider API keys, `SESSION_SECRET`, `DATABASE_URL`,
`REDIS_URL`) come from the environment — fine for local dev and small single-host
deploys, where a PaaS's own env/secret settings are usually enough. For teams or
compliance needs, point the server at a cloud secrets manager with `SECRETS_PROVIDER`:

```bash
# AWS Secrets Manager (one JSON "bundle" secret holding all keys)
npm i @aws-sdk/client-secrets-manager
export SECRETS_PROVIDER=aws AWS_REGION=us-east-1 SECRETS_BUNDLE=ergon/prod

# GCP Secret Manager
npm i @google-cloud/secret-manager
export SECRETS_PROVIDER=gcp GCP_PROJECT=my-proj SECRETS_BUNDLE=ergon-prod

# Azure Key Vault
npm i @azure/keyvault-secrets @azure/identity
export SECRETS_PROVIDER=azure AZURE_KEYVAULT_URL=https://myvault.vault.azure.net SECRETS_BUNDLE=ergon-prod
```

Two layouts: **bundle** (`SECRETS_BUNDLE` set → one secret holding a JSON object
of all keys, a single fetch) or **per-key** (no bundle → each key is its own
cloud secret named `SECRETS_PREFIX + KEY`, better for per-secret rotation).
Secrets are fetched once at startup and overlaid into the environment, so the
rest of the app is unchanged. Anything unresolved falls back to `process.env`,
and if the cloud SDK isn't installed or a fetch fails, it degrades to env vars
rather than failing to boot — so `SECRETS_PROVIDER=env` (the default) needs
nothing.

The provider *logic* (selection, bundle/per-key resolution, caching, fallback,
overlay) is unit-tested offline (`server/secrets.test.mjs`), but the **real
AWS/GCP/Azure SDK calls have not been exercised against live cloud services in
this build** — validate with your own credentials before relying on them.

## Deployment (Docker, health checks, migrations)

Run the whole production stack — app + Postgres (pgvector) + Redis — with Docker:

```bash
# from the repo root; set ANTHROPIC_API_KEY (and SESSION_SECRET) in a .env first
docker compose up --build
```

The app auto-selects its scale backends from the compose env (`DATABASE_URL` →
Postgres, `REDIS_URL` → shared rate limiting); drop those and it falls back to
single-instance SQLite + in-memory limiting.

**Health checks.** The server exposes `GET /healthz` (liveness — is the process
up?) and `GET /readyz` (readiness — is the data layer reachable? 503 until it
is). Orchestrators poll these to decide when to route traffic; the Dockerfile
and compose file wire them as container health checks.

**Graceful shutdown.** On `SIGTERM`/`SIGINT` the server stops accepting
connections, lets in-flight requests finish, then exits (with a 10s hard
timeout), so rolling deploys don't cut off live requests.

**Migrations.** Schema changes ship as ordered, forward-only, idempotent steps:

```bash
npm run migrate          # apply pending migrations
npm run migrate:status   # list applied / pending
```

The container runs migrations automatically on boot before starting the server.
Migrations work against both SQLite and Postgres (the runner normalizes
placeholders); the baseline migration matches the shipped schema, so an existing
database adopts the system without a rebuild.

**Backup & restore.** Snapshot and restore the data layer:

```bash
npm run backup                       # → backups/ergon-<timestamp>.(db.gz|dump)
npm run backup:list                  # list snapshots with backend + schema version
npm run restore backups/ergon-….db.gz   # restore from a snapshot
```

It dispatches on the backend: **SQLite** takes a consistent `VACUUM INTO`
snapshot and gzips it (no external tools); **Postgres** uses `pg_dump`
(custom format) and `pg_restore` (which must be on PATH — present in the
pgvector image). Each backup records its backend, timestamp, and schema version
in a `manifest.json`. A SQLite restore snapshots the current DB to a
`.pre-restore-*` file first, so a bad restore is recoverable. Backup files live
in `backups/` (git- and docker-ignored); schedule `npm run backup` with cron or
your orchestrator and ship the files off-box for real durability.

**Validation note:** the health endpoints, graceful shutdown, the SQLite
migration path, and the **full SQLite backup→restore round-trip** are verified
against real databases here. The Docker *image build*, the Postgres migration
path, and the Postgres `pg_dump`/`pg_restore` path are structurally correct (the
commands are built and dispatched; only the live connection is unexercised) but
need `docker build` and a live Postgres to confirm in your environment.

### Licensing heads-up

None of the default stack requires a paid license to run, but two points are
worth knowing before a company deployment (this is orientation, not legal
advice — verify current terms for your situation):

- **The images are all free OSS.** `node:20-slim` (Node, MIT), `pgvector/pgvector`
  (PostgreSQL License), and `valkey/valkey` (BSD-3). Pulling and running them
  costs nothing.
- **Valkey instead of Redis, on purpose.** Redis's 2024 license change (RSALv2 /
  SSPL) restricts *offering Redis itself as a managed service*, not internal use
  like ours — but to keep the default stack free of any such question we use
  **Valkey**, the Linux Foundation's BSD-licensed, protocol-compatible fork. The
  rate limiter talks the standard protocol, so nothing in the app changes. Swap
  `valkey/valkey` back to `redis:7-alpine` in `docker-compose.yml` if you prefer
  Redis (fine for this internal-cache use).
- **Docker Desktop vs Engine.** Docker *Desktop* (the Mac/Windows GUI) needs a
  paid subscription for large organizations (the threshold has been 250+
  employees or $10M+ revenue). The **Docker Engine + CLI + `docker compose`** on
  Linux — what a server or CI actually runs — are Apache-2.0 and **free at any
  size**. So a typical Linux/CI deployment needs no Docker license; only
  large-company developers running Desktop locally would, and can use Engine,
  Podman, or Rancher Desktop instead.

Net: deploy on a Linux host/CI with Docker Engine + compose and the whole stack
is free OSS. Verify Docker Desktop terms only if large-company laptops are in
scope.

## Notes

- **Session persistence** goes through `src/storage.js`. Signed out (or in the
  Claude artifact) it uses `localStorage`; signed in, the same interface talks
  to the server (`/api/kv`), so run history follows your account. Either way
  history is saved after each model call.
- **Exported Python** from the "⌥ Python SDK code" button targets the
  Ergon SDK (the sibling `ergon-sdk` package).
- **Run a saved harness headless**: the exported/shared harness JSON can also
  be run directly by the SDK without codegen —
  `python -m ergon.run harness.json "task"`, or `load_harness(...)` in
  Python (supply real implementations for custom tools). See the SDK README.
- **Providers**: each agent has a provider + model in the Core tab —
  Anthropic (default), OpenAI-compatible (OpenAI, Groq, Together, vLLM via
  `OPENAI_BASE_URL`), Ollama (local models, no key/cost), Google Gemini
  (`GEMINI_API_KEY`), and AWS Bedrock.
  Anthropic/OpenAI/Ollama/Gemini agents run live through the proxy; Bedrock needs
  AWS SigV4 signing, so it previews on Claude and runs natively in the
  exported Python via boto3. Hosted web search: Anthropic + Gemini; on
  OpenAI/Bedrock attach a custom search tool (SDK: `web_search_tool(fn)`).
  Need a provider that isn't in this list? The dropdown is intentionally short,
  but the SDK takes any adapter — implement one `complete()` method (a
  LiteLLM-backed example is in the SDK README under *Custom providers*) and pass
  it as `provider=`. Custom providers are code-only, so they don't appear in the
  visual dropdown.
- Never put the API key in client code or `VITE_`-prefixed env vars — those
  are bundled into the browser build.

## License

MIT — see [LICENSE](LICENSE).
