## What & why

What this changes and the problem it solves. Link any related issue.

## Testing

How you verified it. Both suites must pass locally:

- [ ] `cd sdk && PYTHONPATH=. python tests/_run_without_pytest.py`
- [ ] `cd studio && npm test`
- [ ] Added/updated tests for the change (offline: fake provider / fake pool)

## Checklist

- [ ] Docs updated (relevant README) and `CHANGELOG.md` under *Unreleased*
- [ ] Data-layer change updates **both** backends (`db.mjs` + `db.postgres.mjs`)
      and the fake-pool parity in `backends.test.mjs`
- [ ] Schema change is a **new** forward-only migration (never edits an applied one)
- [ ] Touched `src/codegen.js` / `src/storage.js`? `build-artifact.mjs` anchors
      still match (artifact rebuilds)
- [ ] No new runtime dependency without discussion; suites stay offline

## Cross-cutting impact

Does this touch both the SDK and the Studio? Any migration, config, or env var?
