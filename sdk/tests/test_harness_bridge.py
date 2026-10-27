"""Harness bridge: a Studio-designed JSON graph runs headless through the SDK."""
import tempfile

import pytest

import ergon.agent as agent_mod
from ergon import load_harness
from ergon.providers import ModelResponse
from .conftest import FakeProvider


@pytest.fixture
def patched_provider(monkeypatch):
    """Make agents build FakeProviders instead of real ones.

    The harness passes a provider *string* to Agent(), which resolves it via
    make_provider in the agent module — so that's where we patch.
    """
    def fake_make_provider(provider, model, api_key, base_url, client=None):
        return FakeProvider([
            ModelResponse(text="handled", stop="end",
                         usage={"input_tokens": 5, "output_tokens": 5})
        ])
    monkeypatch.setattr(agent_mod, "make_provider", fake_make_provider)


def _linear_graph():
    return {
        "version": 2,
        "nodes": [
            {"id": "in", "type": "input", "config": {"message": "hello"}},
            {"id": "a", "type": "agent",
             "config": {"name": "solver", "provider": "anthropic",
                        "mode": "execute", "maxIterations": 4,
                        "allowInternet": False, "todo": False, "memory": False,
                        "approvalMode": "heuristic"}},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [
            {"kind": "flow", "from": "in", "to": "a"},
            {"kind": "flow", "from": "a", "to": "out"},
        ],
    }


def test_load_harness_from_dict(patched_provider):
    h = load_harness(_linear_graph(), session_root=tempfile.mkdtemp())
    assert "a" in h.agents
    assert h.agents["a"].name == "solver"


def test_harness_runs_headless(patched_provider):
    h = load_harness(_linear_graph(), session_root=tempfile.mkdtemp())
    result = h.run()
    assert result.text == "handled"
    assert result.usage.total_tokens > 0


def test_harness_uses_input_node_message(patched_provider):
    h = load_harness(_linear_graph(), session_root=tempfile.mkdtemp())
    # no explicit task → falls back to the Input node's message
    result = h.run()
    assert result.text == "handled"


def test_harness_custom_tool_injection(patched_provider):
    graph = _linear_graph()
    graph["nodes"].append({
        "id": "t", "type": "customtool",
        "config": {"name": "lookup", "description": "look things up", "mode": "http"},
    })
    graph["edges"].append({"kind": "tool", "from": "a", "to": "t"})

    called = {"n": 0}

    def lookup(inp):
        called["n"] += 1
        return "looked up"

    h = load_harness(graph, tools={"lookup": lookup}, session_root=tempfile.mkdtemp())
    # the supplied implementation should be attached to the agent
    assert "lookup" in h.agents["a"].tools


def test_load_harness_from_json_string(patched_provider):
    import json
    h = load_harness(json.dumps(_linear_graph()), session_root=tempfile.mkdtemp())
    assert h.run().text == "handled"
