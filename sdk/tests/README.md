# Ergon SDK test suite

Run with pytest:

```bash
pip install -e '.[dev]'     # installs pytest
pytest                       # from the sdk/ directory
```

The suite runs fully offline against a scriptable fake provider (`conftest.py`),
so it needs no API keys or network.

## Coverage

| Module | What it covers |
|--------|----------------|
| `test_agent_loop.py` | tool-calling loop, iteration limits, stop reasons, usage tracking, the `complete()`-only provider contract |
| `test_approval_and_budgets.py` | approval gating (safe/unsafe/plan-mode/always-allow), token & cost spend budgets, budget validation |
| `test_streaming_cancel.py` | stream event ordering, cooperative cancellation (before & mid-loop) |
| `test_eval.py` | every scorer (exact/contains/regex/json/numeric…) and the `evaluate()` harness |
| `test_flows_compaction_security.py` | chain flow + usage merge, token estimation, on-disk secret redaction, browser SSRF guard & tool safety flags |
| `test_harness_bridge.py` | a Studio JSON graph running headless through `load_harness`, incl. custom-tool injection |
| `test_retry_and_errors.py` | retry-with-backoff, error classification, and retry integration in the agent loop |
| `test_router.py` | unified routing: `provider/model` resolution + env mapping, `Router` fallback/load-balancing/cooldown, cost attribution, and the `make_provider` spec shortcut |

## Note

`_run_without_pytest.py` is a minimal shim to execute the suite in environments
where pytest can't be installed (no network). It is **not** part of the real
test run — CI and normal development use pytest. It implements just enough of
the pytest API (fixtures, `raises`, `parametrize`, `monkeypatch`) to run these
exact files unchanged.
