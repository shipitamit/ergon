"""Run records — RunRecorder over synthetic event streams and a real
fake-provider harness run. Offline."""
import tempfile

import ergon.agent as agent_mod
from ergon.providers import ModelResponse
from ergon.runs import RunRecorder, run_and_record
from ergon import load_harness
from .conftest import FakeProvider


def _fake_make_provider(provider, model, api_key, base_url, client=None):
    return FakeProvider([ModelResponse(text="the answer", stop="end",
                                       usage={"input_tokens": 7, "output_tokens": 3})])


def test_recorder_builds_record_from_harness_events():
    events = [
        {"event": "node_start", "node": "solver", "data": {"type": "agent"}},
        {"event": "iteration", "node": "solver", "data": 0},
        {"event": "tool_start", "node": "solver", "data": {"name": "lookup", "input": "order 1"}},
        {"event": "tool_result", "node": "solver", "data": {"name": "lookup", "output": "x" * 2000, "ms": 12}},
        {"event": "node_done", "node": "solver", "data": {"stopped_because": "end"}},
        {"event": "result", "node": None, "data": {"text": "done", "stopped_because": "end",
                                                   "usage": {"total_tokens": 10, "cost": 0.0}}},
    ]
    rec = RunRecorder(harness="demo", input_text="hello").record(events)
    assert rec.status == "ok"
    assert rec.output == "done"
    assert rec.harness == "demo"
    assert rec.usage["total_tokens"] == 10
    kinds = [s.kind for s in rec.steps]
    assert "tool_start" in kinds and "tool_result" in kinds
    assert "text" not in kinds            # token deltas are not stored as steps
    # large tool output is truncated in the stored detail
    tr = next(s for s in rec.steps if s.kind == "tool_result")
    assert len(tr.detail["output"]) <= 501
    assert rec.finished_at >= rec.started_at
    d = rec.as_dict()
    assert d["status"] == "ok" and isinstance(d["steps"], list)


def test_recorder_marks_error_events():
    events = [
        {"event": "node_start", "node": "a", "data": {}},
        {"event": "error", "node": "a", "data": {"error": "boom"}},
    ]
    rec = RunRecorder().record(events)
    assert rec.status == "error"
    assert rec.output == "boom"


def test_recorder_marks_cancelled():
    events = [{"event": "result", "node": None, "data": {"text": "partial", "stopped_because": "cancelled"}}]
    rec = RunRecorder().record(events)
    assert rec.status == "cancelled"


def test_run_and_record_on_a_real_harness(monkeypatch):
    monkeypatch.setattr(agent_mod, "make_provider", _fake_make_provider)
    graph = {
        "version": 2,
        "nodes": [
            {"id": "in", "type": "input", "config": {"message": "hi"}},
            {"id": "a", "type": "agent", "config": {"name": "solver", "provider": "anthropic",
                "allowInternet": False, "todo": False, "memory": False, "otel": False}},
            {"id": "out", "type": "output", "config": {}},
        ],
        "edges": [{"kind": "flow", "from": "in", "to": "a"}, {"kind": "flow", "from": "a", "to": "out"}],
    }
    h = load_harness(graph, session_root=tempfile.mkdtemp())
    record, text = run_and_record(h, "where is my order?", name="demo")
    assert text == "the answer"
    assert record.status == "ok"
    assert record.usage["total_tokens"] > 0
    assert any(s.kind == "node_start" for s in record.steps)
    assert record.latency_ms >= 0
