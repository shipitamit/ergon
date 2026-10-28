"""Durable flow execution: store round-trip, graph fingerprint, and crash
recovery (a resumed run replays completed nodes without re-executing them)."""
import tempfile
import pytest

import ergon.agent as agent_mod
from ergon import (load_harness, MemoryCheckpointStore, FileCheckpointStore,
                   SQLiteCheckpointStore)
from ergon.durable import graph_fingerprint, new_state, STATUS_DONE, STATUS_ERROR
from ergon.providers import ModelResponse
from .conftest import FakeProvider


def _graph():
    agent = lambda nid, name: {"id": nid, "type": "agent", "config": {
        "name": name, "provider": "anthropic", "mode": "execute", "maxIterations": 4,
        "allowInternet": False, "todo": False, "memory": False, "approvalMode": "heuristic"}}
    return {"version": 2,
            "nodes": [{"id": "in", "type": "input", "config": {"message": "go"}},
                      agent("a1", "first"), agent("a2", "second"),
                      {"id": "out", "type": "output", "config": {}}],
            "edges": [{"kind": "flow", "from": "in", "to": "a1"},
                      {"kind": "flow", "from": "a1", "to": "a2"},
                      {"kind": "flow", "from": "a2", "to": "out"}]}


def _install_provider(monkeypatch, texts):
    """One shared FakeProvider across all agents, scripted with `texts` in order.
    Sharing the script means the number of pops proves how many agent steps ran."""
    prov = FakeProvider([ModelResponse(text=t, stop="end",
                         usage={"input_tokens": 5, "output_tokens": 5}) for t in texts])
    monkeypatch.setattr(agent_mod, "make_provider", lambda *a, **k: prov)
    return prov


# ── stores ──
def test_store_round_trip_all_backends():
    for store in (MemoryCheckpointStore(),
                  FileCheckpointStore(tempfile.mkdtemp()),
                  SQLiteCheckpointStore(tempfile.mktemp(suffix=".db"))):
        st = new_state("r1", "fp", "task")
        st["completed"]["n1"] = {"text": "x"}
        store.save("r1", st)
        got = store.load("r1")
        assert got["run_id"] == "r1" and got["completed"]["n1"]["text"] == "x"
        assert any(r["run_id"] == "r1" for r in store.list())
        assert store.load("missing") is None
        store.delete("r1")
        assert store.load("r1") is None


def test_graph_fingerprint_changes_with_the_graph():
    g = _graph()
    fp1 = graph_fingerprint(g["nodes"], g["edges"])
    assert fp1 == graph_fingerprint(list(g["nodes"]), list(g["edges"])), "stable for the same graph"
    g2 = _graph(); g2["nodes"][1]["config"]["name"] = "renamed"
    assert graph_fingerprint(g2["nodes"], g2["edges"]) != fp1, "config change → new fingerprint"


# ── durable run (happy path) ──
def test_durable_run_matches_a_plain_run_and_marks_done(monkeypatch):
    _install_provider(monkeypatch, ["one", "two"])
    store = MemoryCheckpointStore()
    h = load_harness(_graph(), session_root=tempfile.mkdtemp())
    r = h.run(store=store, run_id="ok", resume=False)
    assert r.text == "two"
    assert r.usage.total_tokens == 20          # a1 (10) + a2 (10), counted once
    s = store.load("ok")
    assert s["status"] == STATUS_DONE and s["order"] == ["a1", "a2"]


# ── crash recovery ──
def test_crash_then_resume_does_not_re_execute_completed_nodes(monkeypatch):
    # script has exactly: a1→"one", a2→"two". A pop for a1 on resume would steal
    # "two", so a wrong final answer also proves re-execution.
    _install_provider(monkeypatch, ["one", "two"])
    store = MemoryCheckpointStore()

    # attempt 1: crash when the walk reaches a2 (a1 has already checkpointed)
    h1 = load_harness(_graph(), session_root=tempfile.mkdtemp())
    orig = h1._run_agent_node
    def crash(node, payload):
        if node["id"] == "a2":
            raise RuntimeError("simulated crash")
        return orig(node, payload)
    h1._run_agent_node = crash
    with pytest.raises(RuntimeError):
        h1.run(store=store, run_id="job", resume=False)

    mid = store.load("job")
    assert mid["status"] == STATUS_ERROR
    assert "a1" in mid["completed"] and "a2" not in mid["completed"]

    # attempt 2: a fresh harness ("restart"), same store + provider, resume
    h2 = load_harness(_graph(), session_root=tempfile.mkdtemp())
    executed = []
    base = h2._run_agent_node
    h2._run_agent_node = lambda node, payload: (executed.append(node["id"]), base(node, payload))[1]

    r = h2.run(store=store, run_id="job", resume=True)
    assert executed == ["a2"], "a1 was completed before the crash and must not run again"
    assert r.text == "two", "final output is a2's result, replayed cleanly"
    assert r.usage.total_tokens == 20, "a1's usage counted once (from the checkpoint), not twice"
    assert store.load("job")["status"] == STATUS_DONE


def test_resume_guards(monkeypatch):
    _install_provider(monkeypatch, ["one", "two", "two"])
    store = MemoryCheckpointStore()
    h = load_harness(_graph(), session_root=tempfile.mkdtemp())
    # resume with no prior checkpoint → error
    with pytest.raises(ValueError):
        h.run(store=store, run_id="nope", resume=True)
    # a completed run resumes to the same answer without executing anything
    h.run(store=store, run_id="done1", resume=False)
    executed = []
    base = h._run_agent_node
    h._run_agent_node = lambda node, payload: (executed.append(node["id"]), base(node, payload))[1]
    r = h.run(store=store, run_id="done1", resume=True)
    assert r.text == "two" and executed == [], "a finished run replays with no execution"


def test_resume_refuses_a_changed_graph(monkeypatch):
    _install_provider(monkeypatch, ["one", "two"])
    store = MemoryCheckpointStore()
    h1 = load_harness(_graph(), session_root=tempfile.mkdtemp())
    orig = h1._run_agent_node
    h1._run_agent_node = lambda node, payload: (_ for _ in ()).throw(RuntimeError("x")) if node["id"] == "a2" else orig(node, payload)
    with pytest.raises(RuntimeError):
        h1.run(store=store, run_id="j2", resume=False)
    # edit the graph, then try to resume the old run → refused
    g2 = _graph(); g2["nodes"][2]["config"]["name"] = "changed"
    h2 = load_harness(g2, session_root=tempfile.mkdtemp())
    with pytest.raises(ValueError):
        h2.run(store=store, run_id="j2", resume=True)
