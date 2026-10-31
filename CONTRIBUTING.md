# Contributing to Ergon

Thanks for your interest. Ergon is a monorepo with two separate toolchains — a
Python **SDK** (`sdk/`) and a Node/React **Studio** (`studio/`) - that release
together. This guide covers setup, tests, and the PR + release flow.

## Development setup

```bash
./scripts/bootstrap.sh          # sets up both halves

# …or each on its own:
pip install -e ./sdk            # SDK (Python ≥ 3.9)
npm --prefix studio install     # Studio (Node ≥ 18)
```

The SDK runs against a scriptable fake provider in tests, so no API key is
needed to develop or test. Set `ANTHROPIC_API_KEY` only to run real agents.

## Running the tests

Both suites are **offline and dependency-light** - they must stay that way.

```bash
# SDK - a no-pytest shim runs the whole suite with stdlib only
cd sdk && PYTHONPATH=. python tests/_run_without_pytest.py
#   (pytest also works if installed: `pytest`)

# Studio — plain-node assert suites, no network
cd studio && npm test
```

The Studio data layer is **dual-backend**: the default SQLite path and the
Postgres path (`db.postgres.mjs`) share one function surface. `npm run
test:backends` exercises the Postgres path against a fake `pg` pool; a live
Postgres wire is covered by CI / the reference-architecture compose test, not
the offline suite. Any data-layer change must update **both** backends and the
fake-pool parity.

Database schema changes are **forward-only migrations** in
`studio/server/migrations.mjs` - add the next numbered migration; never edit an
applied one. `npm run migrate` applies them on a fresh DB.

## Pull requests

1. Branch from the default branch; keep a PR focused on one change.
2. Add or update tests - a feature without a test won't be merged. Keep tests
   offline (fake provider / fake pool).
3. Update docs: the relevant README, and `CHANGELOG.md` under *Unreleased*.
4. Run both suites locally; CI (`.github/workflows/`) runs them on push plus
   the Studio build and migration smoke.
5. Fill in the PR template. Describe the change, the testing done, and any
   migration or cross-cutting (SDK + Studio) impact.

### Style

- Match the surrounding code; no new formatter or linter config in a PR.
- Prefer small, composable functions and clear names over cleverness.
- Studio artifact builds: if you touch `src/codegen.js` or `src/storage.js`,
  keep `scripts/build-artifact.mjs`'s inline anchors in sync (its test will
  catch a drift).

## Releasing (maintainers)

Lockstep versioning — one `vMAJOR.MINOR.PATCH` tag at the repo root covers both
halves (a change usually touches both; see `CHANGELOG.md`).

1. Move the *Unreleased* section of `CHANGELOG.md` under the new version + date.
2. Bump the version in `sdk/pyproject.toml` and `studio/package.json` to match.
3. Ensure migrations are contiguous and both suites + CI are green.
4. Tag `vX.Y.Z` at the repo root and publish (SDK to PyPI, Studio image as you
   deploy).

Breaking SDK API or a non-additive schema change → **major**. New
backward-compatible features (a new scorer, a new route, a new migration that
only adds) → **minor**. Fixes → **patch**.

## Reporting bugs & security

Open an issue with the bug template for defects. For anything security-sensitive
do **not** open a public issue — follow [SECURITY.md](SECURITY.md).
