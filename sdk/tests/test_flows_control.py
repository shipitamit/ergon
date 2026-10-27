"""Cyclic + conditional flow primitives: `loop` and `branch` (Phase 1).

Offline — flow steps are plain callables returning AgentResult, so the control
logic (dispatch, convergence, max-rounds, feedback threading, usage merge) is
verified with no model calls. One test uses a real Agent on the fake provider to
cover the Agent-step path.
"""
import pytest

from ergon import branch, loop, AgentResult, Usage


def mk(text, intok=5, outtok=5, model="m"):
    """A fake flow-step result carrying usage, like a real agent run would."""
    u = Usage(); u.add(model, intok, outtok)
    return AgentResult(text, [], 1, "end", u)


# ── branch (deterministic conditional edge) ──

def test_branch_dispatches_by_label():
    out = branch("hello world",
                 lambda t: "long" if len(t) > 5 else "short",
                 {"short": lambda t: mk("S"), "long": lambda t: mk("L")})
    assert out.text == "L"


def test_branch_falls_back_to_default():
    out = branch("x", lambda t: "zzz",
                 {"a": lambda t: mk("A")}, default=lambda t: mk("D"))
    assert out.text == "D"


def test_branch_no_match_no_default_returns_task():
    out = branch("keep me", lambda t: "zzz", {"a": lambda t: mk("A")})
    assert out.text == "keep me"
    assert out.stopped_because == "no_branch:zzz"


# ── loop (cyclic edge) ──

def test_loop_converges_on_marker():
    calls = {"n": 0}
    def body(t):
        calls["n"] += 1
        return mk("DONE" if calls["n"] == 3 else "working")
    out = loop("start", body, until="DONE", max_rounds=10)
    assert out.stopped_because == "loop_converged"
    assert calls["n"] == 3


def test_loop_converges_on_callable_until():
    out = loop("x", lambda t: mk("score=0.95"),
               until=lambda r: "0.95" in r.text, max_rounds=5)
    assert out.stopped_because == "loop_converged"


def test_loop_hits_max_rounds():
    calls = {"n": 0}
    def body(t):
        calls["n"] += 1
        return mk("nope")
    out = loop("x", body, until="never", max_rounds=4)
    assert out.stopped_because == "loop_max_rounds"
    assert calls["n"] == 4


def test_loop_feeds_output_forward_by_default():
    seen = []
    def body(t):
        seen.append(t)
        return mk(t + "+")
    out = loop("a", body, max_rounds=3)   # until=None → runs the full cap
    assert seen == ["a", "a+", "a++"]
    assert out.text == "a+++"


def test_loop_custom_feedback_builds_next_input():
    out = loop("0", lambda t: mk("round:" + t), max_rounds=2, feedback=lambda r: "FB")
    assert out.text == "round:FB"


def test_loop_aggregates_usage_across_rounds():
    out = loop("s", lambda t: mk("x", intok=10, outtok=20), max_rounds=3)
    assert out.usage.input_tokens == 30
    assert out.usage.output_tokens == 60
    assert out.usage.calls == 3


def test_loop_rejects_bad_max_rounds():
    with pytest.raises(ValueError):
        loop("x", lambda t: mk("y"), max_rounds=0)


def test_step_must_return_agentresult():
    with pytest.raises(TypeError):
        loop("x", lambda t: "not a result", max_rounds=1)


# ── flows nest: a loop body can be a branch (and vice versa) ──

def test_loop_body_can_be_a_branch():
    body = lambda t: branch(t, lambda s: "go", {"go": lambda s: mk(s + "!")})
    out = loop("x", body, until=lambda r: r.text.count("!") >= 3, max_rounds=10)
    assert out.text == "x!!!"
    assert out.stopped_because == "loop_converged"


# ── Agent-step path (covers isinstance(step, Agent)) ──

def test_loop_with_real_agent(make_agent, resp):
    agent = make_agent([resp(text="DONE", in_tok=3, out_tok=4)])
    out = loop("go", agent, until="DONE", max_rounds=3)
    assert out.stopped_because == "loop_converged"
    assert out.usage.total_tokens >= 7
