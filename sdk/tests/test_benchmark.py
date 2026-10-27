"""Benchmark runner — offline, against the scriptable FakeProvider."""
import tempfile

import ergon.agent as agent_mod
from ergon.providers import ModelResponse, _stream_via_complete
from ergon.benchmark import summarize, run_benchmark
from ergon import load_harness


class _AlwaysProvider:
    """Returns the same response on every call — stable totals across many runs
    (unlike a scripted fake, which a reused harness would exhaust)."""
    name = "fake"; model = "fake-model"; supports_hosted_search = False
    def complete(self, system, messages, tools, max_tokens=4096, use_hosted_search=False):
        return ModelResponse(text="ok", stop="end", usage={"input_tokens": 6, "output_tokens": 4})
    def stream(self, **kwargs):
        yield from _stream_via_complete(self, **kwargs)


def _fake_make_provider(provider, model, api_key, base_url, client=None):
    return _AlwaysProvider()


def _graph():
    return {
        "version": 2,
        "nodes": [
            {"id": "in", "type": "input", "config": {"message": "hi"}},
            {"id": "a", "type": "agent", "config": {"name": "s", "provider": "anthropic",
                "allowInternet": False, "todo": False, "memory": False, "otel": False}},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [{"kind": "flow", "from": "in", "to": "a"}, {"kind": "flow", "from": "a", "to": "out"}],
    }


def test_summarize_percentiles_and_totals():
    lat = [10, 20, 30, 40, 100]
    usages = [{"input_tokens": 5, "output_tokens": 5, "cost": 0.001}] * 5
    s = summarize(lat, usages, wall_s=1.0)
    assert s["runs"] == 5
    assert s["latency_ms"]["p50"] == 30
    assert s["latency_ms"]["min"] == 10 and s["latency_ms"]["max"] == 100
    assert s["latency_ms"]["p95"] >= 40            # near the top of the distribution
    assert s["tokens"]["total"] == 50
    assert abs(s["cost"]["total"] - 0.005) < 1e-9
    assert s["throughput_rps"] == 5.0


def test_run_benchmark_sequential(monkeypatch):
    monkeypatch.setattr(agent_mod, "make_provider", _fake_make_provider)
    h = load_harness(_graph(), session_root=tempfile.mkdtemp())
    s = run_benchmark(h, ["q"] * 5, concurrency=1)
    assert s["runs"] == 5 and s["errors"] == 0
    assert s["tokens"]["total"] == 50          # 5 runs × (6+4)
    assert s["latency_ms"]["mean"] >= 0
    assert s["concurrency"] == 1


def test_run_benchmark_concurrent(monkeypatch):
    monkeypatch.setattr(agent_mod, "make_provider", _fake_make_provider)
    h = load_harness(_graph(), session_root=tempfile.mkdtemp())
    s = run_benchmark(h, ["q"] * 8, concurrency=4)
    assert s["runs"] == 8 and s["errors"] == 0
    assert s["concurrency"] == 4
    assert s["throughput_rps"] > 0
