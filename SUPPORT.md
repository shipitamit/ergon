# Support

Thanks for using Ergon. Here's the fastest way to get unstuck.

## Start with the docs

- **Root [README](README.md)** — what Ergon is, the quickstart, the feature map.
- **[SDK README](sdk/README.md)** — agents, providers, routing, RAG, MCP,
  serving, evaluation, the Python API.
- **[Studio README](studio/README.md)** — the visual builder, the accounts /
  collaboration tier, deployment.
- **Static docs site** — `node scripts/build-docs.mjs`, then open
  `docs/index.html` (all READMEs with nav + search).
- **[Examples](examples/README.md)** — worked harnesses and eval datasets.

## Common questions

- **"Which database do I need?"** None to start — SQLite is the zero-dependency
  default. Set `DATABASE_URL` to use Postgres for multi-instance production. See
  the Studio README's data section.
- **"How do I run a harness as an API?"** `ergon serve <harness.json>` — see the
  SDK README's serving section.
- **"How do I stop a change from regressing quality?"** Save an eval baseline
  and gate on it: `ergon eval … --gate --baseline baseline.json`.

## Asking a question or reporting a bug

- **Questions / discussion** — open a Discussion (or a question-type issue).
- **Bugs** — open an issue with the bug template; include your OS, Node/Python
  versions, and a minimal repro.
- **Feature requests** — open an issue with the feature template; describe the
  problem before the proposed solution.

## Security

Do **not** open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md) to report it privately.
