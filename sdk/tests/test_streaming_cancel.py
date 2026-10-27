"""Streaming events and cooperative cancellation."""
from ergon import CancelToken, tool


def test_cancel_before_run(make_agent, resp):
    tok = CancelToken()
    tok.cancel()
    agent = make_agent([resp(text="should not finish", stop="end")])
    result = agent.run("go", cancel=tok)
    assert result.stopped_because == "cancelled"


def test_cancel_mid_loop(make_agent, resp, tool_call):
    @tool("noop", safe=True)
    def noop(x: str) -> str:
        return "ok"

    tok = CancelToken()
    calls = {"n": 0}

    # cancel after the first tool round
    class Watcher:
        def __init__(self, inner):
            self.inner = inner
            self.name = inner.name
            self.model = inner.model
            self.supports_hosted_search = inner.supports_hosted_search

        def complete(self, *a, **k):
            calls["n"] += 1
            if calls["n"] == 1:
                tok.cancel()
            return self.inner.complete(*a, **k)

        def stream(self, **k):
            from ergon.providers import _stream_via_complete
            yield from _stream_via_complete(self, **k)

    loop = [
        resp(tool_calls=[tool_call("noop", {"x": "a"})], stop="tool_use"),
        resp(text="done", stop="end"),
    ]
    agent = make_agent(loop, tools=[noop], max_iterations=10)
    agent.provider = Watcher(agent.provider)
    result = agent.run("go", cancel=tok)
    assert result.stopped_because == "cancelled"


def test_stream_event_ordering(make_agent, resp):
    agent = make_agent([resp(text="hi", stop="end")])
    kinds = [ev.kind for ev in agent.run_stream("go")]
    # iteration should precede done
    assert kinds.index("iteration") < kinds.index("done")
    assert kinds[-1] == "done"


def test_stream_carries_agent_name(make_agent, resp):
    agent = make_agent([resp(text="hi", stop="end")], name="streamer")
    events = list(agent.run_stream("go"))
    assert all(ev.agent == "streamer" for ev in events if ev.agent)
