"""Step-level checkpointing + resume-from-step (Phase 1, item 2).

Covers the SessionStore checkpoint store directly (deterministic, temp dir) and
the Agent integration on the fake provider: checkpoints written per model call,
listing, and re-entering a run from a named checkpoint.
"""
import tempfile

import pytest

from ergon import tool
from ergon.persistence import SessionStore


@tool("Echo the input back.", safe=True)
def echo(text: str) -> str:
    return f"echo: {text}"


# ── SessionStore checkpoint store (no agent) ──

def test_save_and_list_checkpoints_in_order():
    s = SessionStore(tempfile.mkdtemp())
    a = s.save_checkpoint([{"role": "user", "content": "one"}], label="step-0")
    b = s.save_checkpoint([{"role": "user", "content": "two"}], label="step-1")
    assert a["seq"] == 1 and b["seq"] == 2
    seqs = [c["seq"] for c in s.list_checkpoints()]
    assert seqs == [1, 2]
    labels = [c["label"] for c in s.list_checkpoints()]
    assert labels == ["step-0", "step-1"]


def test_list_checkpoints_omits_message_bodies():
    s = SessionStore(tempfile.mkdtemp())
    s.save_checkpoint([{"role": "user", "content": "secret body"}], label="x")
    row = s.list_checkpoints()[0]
    assert "messages" not in row and row["label"] == "x"


def test_load_checkpoint_by_seq_label_and_latest():
    s = SessionStore(tempfile.mkdtemp())
    s.save_checkpoint([{"role": "user", "content": "first"}], label="step-0")
    s.save_checkpoint([{"role": "user", "content": "second"}], label="step-1")
    assert s.load_checkpoint(1)[0]["content"] == "first"
    assert s.load_checkpoint("step-1")[0]["content"] == "second"
    assert s.load_checkpoint("latest")[0]["content"] == "second"
    assert s.load_checkpoint(99) is None


def test_checkpoints_redacted_on_disk():
    s = SessionStore(tempfile.mkdtemp())
    s.save_checkpoint([{"role": "user", "content": "x"}], meta={"api_key": "sk-secret-value"})
    row = s.list_checkpoints()[0]
    assert row["meta"]["api_key"] == "[REDACTED]"


def test_clear_removes_checkpoints():
    s = SessionStore(tempfile.mkdtemp())
    s.save_checkpoint([{"role": "user", "content": "x"}])
    s.clear()
    assert s.list_checkpoints() == []
    assert s.load_checkpoint("latest") is None


# ── Agent integration ──

def test_checkpoints_off_by_default(make_agent, resp):
    agent = make_agent([resp(text="done")])
    agent.run("go")
    assert agent.checkpoints() == []


def test_checkpoint_written_per_model_call(make_agent, resp, tool_call):
    agent = make_agent(
        [resp(tool_calls=[tool_call("echo", {"text": "ping"})], stop="tool_use"),
         resp(text="done", stop="end")],
        tools=[echo], checkpoints=True,
    )
    agent.run("start")
    cps = agent.checkpoints()
    assert [c["label"] for c in cps] == ["step-0", "step-1"]   # one per model call


def test_resume_from_reenters_at_checkpoint(make_agent, resp, tool_call):
    agent = make_agent(
        [resp(tool_calls=[tool_call("echo", {"text": "ping"})], stop="tool_use"),
         resp(text="done", stop="end")],
        tools=[echo], checkpoints=True,
    )
    agent.run("ORIGINAL")
    # re-enter from the first checkpoint: its messages (incl. the ORIGINAL prompt)
    # become the starting state, then the new prompt is appended.
    result = agent.run("CONTINUE", resume_from="step-0")
    assert result.messages[0]["content"] == "ORIGINAL"
    assert any(m.get("content") == "CONTINUE" for m in result.messages)


def test_resume_from_missing_checkpoint_raises(make_agent, resp):
    agent = make_agent([resp(text="done")], checkpoints=True)
    with pytest.raises(ValueError):
        agent.run("go", resume_from="step-99")


def test_resume_from_latest(make_agent, resp, tool_call):
    agent = make_agent(
        [resp(tool_calls=[tool_call("echo", {"text": "p"})], stop="tool_use"),
         resp(text="done", stop="end")],
        tools=[echo], checkpoints=True,
    )
    agent.run("start")
    result = agent.run("more", resume_from="latest")
    assert result.text  # completes from the latest checkpoint without error
