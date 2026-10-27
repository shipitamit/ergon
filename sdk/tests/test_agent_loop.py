"""Core agent loop: single-shot, tool-calling, iteration limits, stop reasons."""
from ergon import tool


@tool("Echo the input back.", safe=True)
def echo(text: str) -> str:
    return f"echo: {text}"


def test_single_shot_completion(make_agent, resp):
    agent = make_agent([resp(text="hello", stop="end")])
    result = agent.run("hi")
    assert result.text == "hello"
    assert result.stopped_because == "end"
    assert result.iterations >= 1


def test_usage_is_tracked(make_agent, resp):
    agent = make_agent([resp(text="x", in_tok=100, out_tok=50)])
    result = agent.run("go")
    assert result.usage.input_tokens == 100
    assert result.usage.output_tokens == 50
    assert result.usage.total_tokens == 150


def test_tool_call_then_answer(make_agent, resp, tool_call):
    agent = make_agent(
        [
            resp(tool_calls=[tool_call("echo", {"text": "ping"})], stop="tool_use"),
            resp(text="final answer", stop="end"),
        ],
        tools=[echo],
    )
    result = agent.run("use the tool")
    assert result.text == "final answer"
    # the tool result should appear in the message history
    tool_msgs = [m for m in result.messages if m.get("role") == "tool"]
    assert any("echo: ping" in str(m.get("content", "")) for m in tool_msgs)


def test_multiple_tool_rounds(make_agent, resp, tool_call):
    agent = make_agent(
        [
            resp(tool_calls=[tool_call("echo", {"text": "a"})], stop="tool_use"),
            resp(tool_calls=[tool_call("echo", {"text": "b"})], stop="tool_use"),
            resp(text="done", stop="end"),
        ],
        tools=[echo],
    )
    result = agent.run("go")
    assert result.text == "done"
    assert result.usage.calls == 3


def test_iteration_limit_stops_loop(make_agent, resp, tool_call):
    # provider always asks for another tool call; max_iterations must cap it
    never_ending = [
        resp(tool_calls=[tool_call("echo", {"text": "x"})], stop="tool_use")
        for _ in range(50)
    ]
    agent = make_agent(never_ending, tools=[echo], max_iterations=4)
    result = agent.run("loop forever")
    assert result.iterations <= 4
    assert result.usage.calls <= 4


def test_unknown_tool_is_handled_gracefully(make_agent, resp, tool_call):
    # model calls a tool that doesn't exist — loop must not crash
    agent = make_agent(
        [
            resp(tool_calls=[tool_call("nonexistent", {"x": 1})], stop="tool_use"),
            resp(text="recovered", stop="end"),
        ],
        tools=[echo],
    )
    result = agent.run("go")
    assert result.text == "recovered"


def test_complete_only_provider_contract(make_agent, resp):
    # FakeProvider derives stream() from complete() via the fallback;
    # if this passes, the documented complete()-only contract holds.
    agent = make_agent([resp(text="works", stop="end")])
    assert agent.run("hi").text == "works"


def test_run_stream_emits_events(make_agent, resp):
    agent = make_agent([resp(text="streamed", stop="end")])
    kinds = [ev.kind for ev in agent.run_stream("hi")]
    assert "done" in kinds
    assert "text" in kinds
