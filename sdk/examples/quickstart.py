"""Quickstart: a two-agent harness exercising most Ergon features.

    export ANTHROPIC_API_KEY=sk-ant-...
    python examples/quickstart.py
"""
from ergon import Agent, ApprovalPolicy, tool


# ── a custom tool ──
@tool("Convert a temperature between celsius and fahrenheit.", safe=True)
def convert_temp(value: float, to_unit: str) -> str:
    if to_unit.lower().startswith("f"):
        return f"{value * 9 / 5 + 32:.1f}°F"
    return f"{(value - 32) * 5 / 9:.1f}°C"


# ── a specialist peer agent (internet kill switch OFF for this one) ──
# Any agent can run on a different provider, e.g.:
#   Agent("critic", provider="openai", model="gpt-4o",
#         search_tool=web_search_tool(my_search_fn))
critic = Agent(
    name="critic",
    system="You review plans and answers, pointing out gaps in 3 bullets max.",
    allow_internet=False,          # (2) kill switch
    max_iterations=3,              # (3) loop limit
    enable_todo=False,
)

# ── the lead agent ──
lead = Agent(
    name="lead",
    system="You are a careful project lead. Use your tools; consult the critic before finalizing.",
    tools=[convert_temp],
    working_dir="./workspace",     # (9) scoped file tools
    session_dir="./sessions/lead", # (4) history persisted after every model call
    compaction=60_000,             # (5) token budget → automatic compaction
    mode="plan",                   # (7) plan first…
    skills_dir="./skills",         # (12) optional: progressive skill loading
    enable_shell=False,            # (14) flip on for shell + env probing
    enable_subagents=True,         # (13) delegate_parallel tool
    approval=ApprovalPolicy(       # (10) standing rules + heuristics
        rules_path="./sessions/lead/approval_rules.json",
        interactive=True,
    ),
    telemetry=True,                # (11) OTel gen-ai spans (no-op if not installed)
)
lead.connect(critic)               # (1) agent-to-agent: lead gains ask_critic

# plan, then execute
print(lead.run("Plan a one-page brief comparing Raspberry Pi 5 vs Zero 2 W for a weather station.").text)
lead.set_mode("execute")

# (15) loop until the agent declares completion; (6)+(8) the todo list and
# memory notes carry state across these re-invocations automatically.
result = lead.run_until(
    "Execute the plan: research, then write brief.md in the working directory.",
    condition="TASK_COMPLETE",
    max_rounds=4,
)
print(result.text)

# crash recovery / inspection:
#   lead.run("continue", resume=True)      # picks up ./sessions/lead/history.json
#   lead.session.events()                  # structured event log of the run
