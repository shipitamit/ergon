"""Approval policy gating and spend budgets — the safety-critical paths."""
import pytest

from ergon import ApprovalPolicy, ApprovalDenied, tool


@tool("A safe read-only tool.", safe=True)
def safe_read(x: str) -> str:
    return "read"


@tool("An unsafe mutating tool.")
def unsafe_act(x: str) -> str:
    return "acted"


# ── ApprovalPolicy.check ──

def test_safe_tool_allowed_unattended():
    pol = ApprovalPolicy(interactive=False)
    assert pol.check(safe_read, {"x": "y"}) is True


def test_unsafe_tool_denied_unattended():
    pol = ApprovalPolicy(interactive=False)
    with pytest.raises(ApprovalDenied):
        pol.check(unsafe_act, {"x": "y"})


def test_always_allow_constructor_param():
    pol = ApprovalPolicy(interactive=False, always_allow=["unsafe_act"])
    assert pol.check(unsafe_act, {"x": "y"}) is True


def test_always_allow_method():
    pol = ApprovalPolicy(interactive=False)
    pol.always_allow("unsafe_act")
    assert pol.check(unsafe_act, {"x": "y"}) is True


def test_plan_mode_freezes_mutating_tools():
    pol = ApprovalPolicy(interactive=False, always_allow=["unsafe_act"])
    # even allow-listed, plan mode blocks a mutating tool
    with pytest.raises(ApprovalDenied):
        pol.check(unsafe_act, {"x": "y"}, plan_mode=True)


def test_plan_mode_permits_safe_tools():
    pol = ApprovalPolicy(interactive=False)
    assert pol.check(safe_read, {"x": "y"}, plan_mode=True) is True


# ── spend budgets (integration through the loop) ──

def test_token_budget_stops_run(make_agent, resp, tool_call):
    @tool("noop", safe=True)
    def noop(x: str) -> str:
        return "ok"

    # each round burns ~2000 tokens; cap at 5000 → stop after crossing
    loop = [
        resp(tool_calls=[tool_call("noop", {"x": "a"})], stop="tool_use",
             in_tok=1000, out_tok=1000)
        for _ in range(20)
    ]
    agent = make_agent(loop, tools=[noop], max_iterations=20, max_total_tokens=5000)
    result = agent.run("go")
    assert result.stopped_because == "over_budget"
    assert result.usage.total_tokens >= 5000


def test_cost_budget_stops_run(make_agent, resp, tool_call):
    from ergon import set_prices

    # give the fake model a real price so cost accrues (unknown models cost 0)
    set_prices({"fake-model": (3.0, 15.0)})  # $/1M in, $/1M out

    @tool("noop", safe=True)
    def noop(x: str) -> str:
        return "ok"

    loop = [
        resp(tool_calls=[tool_call("noop", {"x": "a"})], stop="tool_use",
             in_tok=1000, out_tok=1000)
        for _ in range(20)
    ]
    agent = make_agent(loop, tools=[noop], max_iterations=20, max_cost=0.02)
    result = agent.run("go")
    assert result.stopped_because == "over_budget"
    assert result.usage.cost() >= 0.02


def test_no_budget_completes_normally(make_agent, resp):
    agent = make_agent([resp(text="fine", stop="end")])
    assert agent.run("go").stopped_because == "end"


@pytest.mark.parametrize("bad", [
    {"max_total_tokens": 0},
    {"max_total_tokens": -5},
    {"max_cost": 0},
    {"max_cost": -1.0},
])
def test_invalid_budgets_rejected(make_agent, resp, bad):
    with pytest.raises(ValueError):
        make_agent([resp()], **bad)
