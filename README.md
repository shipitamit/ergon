# Ergon

A toolkit for building AI agent harnesses — a Python **SDK** (the engine) and a
drag-and-drop visual **Studio** (the builder) that generates code against it.

This is a monorepo: both halves live here because they move together. The
Studio generates Python for the SDK, the SDK's bridge runs Studio-designed
harnesses headless, and most features (browser control, spend budgets, custom
tools…) land in both at once. Keeping them in one repo means a single commit
covers a cross-cutting change, so the generated code and the runtime never drift
apart.

```
ergon/
├── sdk/       Python SDK — the agent harness engine (pip install ./sdk)
├── studio/    Vite + React visual builder + Node proxy (npm --prefix studio)
├── examples/  Shared harness JSON, eval datasets, worked examples
├── docs/      Generated static docs site (scripts/build-docs.mjs)
└── scripts/   Repo-level helpers (bootstrap both toolchains, build docs)
```

## What's here

| Path | What it is | Toolchain |
|------|-----------|-----------|
| [`sdk/`](sdk/) | The `ergon` Python package: agent loop, tools, approval, compaction, streaming, providers, unified routing, eval, browser control | Python ≥3.9, pip |
| [`studio/`](studio/) | The visual harness builder — canvas, inspector, live preview, codegen, optional accounts | Node ≥18, npm |
| [`examples/`](examples/) | Provider-neutral harness graphs + eval datasets you can import into the Studio or run through the SDK bridge | — |

The two halves have **separate toolchains** — there's no single build that does
both. Use the bootstrap script, or set each up on its own (below).

## Quick start

One command sets up both halves and starts the Studio:

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # the default provider — or use any of ~15 (see Providers)
./scripts/bootstrap.sh                   # install if needed, then start (http://localhost:5173)
```

`bootstrap.sh` is the single entry point — it reads a root `.env` if present and
takes a subcommand:

```bash
./scripts/bootstrap.sh                   # dev: set up + start the Studio (default)
./scripts/bootstrap.sh docker            # production stack (app + Postgres + Valkey)
./scripts/bootstrap.sh serve harness.json --port 8900   # serve a harness (REST + SSE)
./scripts/bootstrap.sh test              # run both test suites
./scripts/bootstrap.sh setup             # install deps only
./scripts/bootstrap.sh help
```

…or drive each half yourself:

```bash
pip install -e ./sdk                     # SDK
npm --prefix studio install && npm --prefix studio run dev   # Studio (proxy + Vite)
python sdk/examples/quickstart.py        # run an agent via the SDK
```

## Providers

Ergon is **not Anthropic-only** — Anthropic is just the default, so the quickstart
shows one key. The unified router reaches ~15 providers, and each
agent picks its own. Set only the key(s) you use, via an env var **or** in the
Studio (**Settings → Keys**, stored encrypted):

| Provider | Env var(s) |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| AWS Bedrock | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| Ollama (local) | `OPENAI_BASE_URL=http://localhost:11434/v1` |
| OpenAI | `OPENAI_API_KEY` |
| Any OpenAI-compatible endpoint | `OPENAI_API_KEY` + `OPENAI_BASE_URL` |

The OpenAI-compatible path covers **Azure OpenAI, DeepSeek, Fireworks, Groq,
Mistral, NVIDIA, OpenRouter, Perplexity, Together, vLLM, and xAI** (each also has a
dedicated `*_API_KEY` the proxy recognizes). Keys set in the Studio take precedence
over env vars and never leave the server; the per-agent **Provider** dropdown
controls which one a block uses.

## How the two connect

- **Design in the Studio → export Python.** Build a harness on the canvas, hit
  "Python SDK code", get a runnable script against `ergon`.
- **Run a Studio harness headless.** `ergon.load_harness("graph.json",
  tools={...})` runs the exact graph the Studio produced, in your own process.

See each subproject's README for depth:
[SDK README](sdk/README.md) · [Studio README](studio/README.md).

## What you can build with it

- **Agents & flows** — tool-calling loop with approval, retries, streaming,
  compaction, and cost accounting; chain / route / parallel / branch / loop
  control flow; a unified provider router (Anthropic, OpenAI-compatible, Ollama,
  Gemini, Bedrock) with fallbacks and a cost registry.
- **Retrieval & tools** — pgvector RAG, MCP clients, browser control, custom and
  built-in tools, skills.
- **Serve** — turn any harness into a REST + SSE HTTP endpoint (`ergon serve`),
  Dockerized.
- **Observe & evaluate** — OpenTelemetry traces, per-run history with a trace
  viewer, and an evaluation harness with scorers and CI **regression gates**.
- **Operate (Studio collaboration tier)** — accounts, organizations + RBAC, an
  append-only audit log, SSO (OIDC), service-account API keys, per-org budgets &
  quotas, a hosted control plane (publish a harness behind a tenant-aware
  gateway), and per-org data export + erasure.

## Project

- [CHANGELOG.md](CHANGELOG.md) — what shipped, by phase.
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, tests, PR flow, releases.
- [SECURITY.md](SECURITY.md) — reporting + security properties.
- [SUPPORT.md](SUPPORT.md) — where to ask for help.
- [Code of Conduct](CODE_OF_CONDUCT.md).
- Governance: [SOC 2 controls matrix](docs/soc2-controls.md) ·
  [data governance](docs/data-governance.md).

## Documentation

All the READMEs are also published as a single static docs site with a nav and
in-page search of headings — no build toolchain or dependencies:

```bash
node scripts/build-docs.mjs      # regenerates docs/index.html from the READMEs
```

Open `docs/index.html` directly, or host `docs/` on any static server (GitHub
Pages, S3, nginx). The Markdown is embedded in the page (so it works from
`file://` too); only the Markdown renderer loads from a CDN, with a raw-text
fallback. Re-run the command after editing any README to refresh the site.

## Deployment

Production stack (app + Postgres/pgvector + Redis) via Docker:

```bash
docker compose up --build        # set ANTHROPIC_API_KEY in .env first
```

Health checks (`/healthz`, `/readyz`), graceful shutdown, and auto-run schema
migrations are built in — see [studio/README.md](studio/README.md#deployment-docker-health-checks-migrations).

## Versioning

The SDK and Studio share one version and release together — a change usually
touches both, so lockstep releases keep the generated code and the runtime in
sync. Tags are `vMAJOR.MINOR.PATCH` at the repo root.

## Supporting Ergon

Ergon is open source and built in the open. The most valuable support isn't
money — it's signal that the project is used and worth maintaining:

- **Star the repo.** It's the clearest signal of interest and helps others find
  Ergon.
- **Join the discussion.** Ask questions, share what you built, or float an idea
  in [Discussions](../../discussions) — answering someone else's question counts
  just as much.
- **Use it and tell us what broke.** A good bug report with a minimal repro is
  worth more than a dozen vague ones — file it with the
  [bug template](.github/ISSUE_TEMPLATE/bug_report.md).
- **Improve the docs.** Found something wrong or unclear? Open a
  [docs issue](.github/ISSUE_TEMPLATE/documentation.md) or send a PR — small doc
  fixes are the easiest first contribution.
- **Contribute code.** Pick up a `good first issue`, or propose a change first
  via a [feature request](.github/ISSUE_TEMPLATE/feature_request.md). See
  [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, tests, and the PR flow.
- **Write about it.** A blog post, a talk, or an example harness showing what
  you built helps more people than you'd expect.
- **Sponsor.** If Ergon saves you time and you want to fund its upkeep, see the
  **Sponsor** button at the top of the repo (configured in
  [.github/FUNDING.yml](.github/FUNDING.yml)).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

See [LICENSE](LICENSE).
