"""Streaming a run and cancelling it with a wall-clock budget.

    pip install anthropic  &&  export ANTHROPIC_API_KEY=sk-ant-...
    python examples/streaming.py
"""
from ergon import Agent, CancelToken

agent = Agent("writer", system="You are concise.", model="claude-sonnet-4-6")

# 1) live token streaming
print("── streaming ──")
result = None
for ev in agent.run_stream("Write two sentences about tide pools."):
    if ev.kind == "text":
        print(ev.text, end="", flush=True)
    elif ev.kind == "done":
        result = ev.data
print(f"\n\n{result.usage}")

# 2) cancel after a time budget
print("\n── with a 5s budget ──")
r = agent.run("Explain the entire history of computing in detail.", max_wall_seconds=5)
print(f"stopped_because={r.stopped_because}; produced {len(r.text)} chars")
