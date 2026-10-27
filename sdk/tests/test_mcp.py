"""MCP client: tool construction, safety model, invocation, agent integration.

Runs against a fake MCP client that mimics the protocol (list_tools / call_tool)
so the logic is verified offline — no `mcp` package, no live server. The real
transports (stdio subprocess, streamable HTTP) are not exercised here; that
needs a live MCP server (see the module docstring).
"""
import tempfile

import pytest

from ergon import Agent, ApprovalPolicy
from ergon.mcp import MCPClient, mcp_tools, _flatten_content
from ergon.providers import ModelResponse, ToolCall, _stream_via_complete


class FakeMCP(MCPClient):
    def __init__(self, tools, results=None):
        super().__init__("stdio", command="x")
        self._fake_tools = tools
        self._results = results or {}
        self.calls = []

    def list_tools(self):
        return self._fake_tools

    def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        return self._results.get(name, f"ran {name}")


SPECS = [
    {"name": "read_file", "description": "Read a file.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
     "annotations": {"readOnlyHint": True}},
    {"name": "write_file", "description": "Write a file.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
     "annotations": {"readOnlyHint": False}},
    {"name": "search", "description": "Search.",
     "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}},
     "annotations": {}},
]


def test_tools_built_from_specs():
    by = {t.name: t for t in mcp_tools(FakeMCP(SPECS))}
    assert set(by) == {"read_file", "write_file", "search"}
    assert by["read_file"].input_schema["required"] == ["path"]
    assert by["write_file"].description == "Write a file."


def test_unsafe_by_default():
    assert all(t.safe is False for t in mcp_tools(FakeMCP(SPECS)))


def test_safe_tools_allowlist():
    s = {t.name: t.safe for t in mcp_tools(FakeMCP(SPECS), safe_tools=["search"])}
    assert s["search"] is True and s["write_file"] is False


def test_trust_readonly_hint():
    s = {t.name: t.safe for t in mcp_tools(FakeMCP(SPECS), trust_readonly_hint=True)}
    assert s["read_file"] is True and s["write_file"] is False and s["search"] is False


def test_invocation_routes_to_server():
    c = FakeMCP(SPECS, results={"read_file": "contents"})
    t = {x.name: x for x in mcp_tools(c)}["read_file"]
    assert t(path="/a") == "contents"
    assert c.calls == [("read_file", {"path": "/a"})]


def test_prefix_namespacing():
    assert "fs_read_file" in {t.name for t in mcp_tools(FakeMCP(SPECS), prefix="fs_")}


def test_content_flattening_and_error():
    class B:
        def __init__(s, t): s.text = t
    class R:
        def __init__(s, blocks, err=False): s.content = blocks; s.isError = err
    assert _flatten_content(R([B("a"), B("b")])) == "a\nb"
    assert _flatten_content(R([B("x")], err=True)).startswith("[tool error]")


def _provider():
    class P:
        name = "anthropic"; model = "m"; supports_hosted_search = False
        def __init__(s): s.n = 0
        def complete(s, **k):
            s.n += 1
            if s.n == 1:
                return ModelResponse(text="", tool_calls=[ToolCall("1", "write_file", {"path": "/x"})],
                                     stop="tool_use", usage={"input_tokens": 5, "output_tokens": 5})
            return ModelResponse(text="done", stop="end", usage={"input_tokens": 3, "output_tokens": 3})
        def stream(s, **k): yield from _stream_via_complete(s, **k)
    return P()


def test_unsafe_mcp_tool_denied_unattended():
    c = FakeMCP(SPECS, results={"write_file": "ok"})
    a = Agent("fs", provider=_provider(), tools=mcp_tools(c), session_dir=tempfile.mkdtemp(),
              enable_todo=False, enable_memory=False, telemetry=False, allow_internet=False,
              approval=ApprovalPolicy(interactive=False))
    a.run("go")
    denied = [e for e in a.session.events() if e.get("tool") == "write_file"]
    assert denied and denied[0]["denied"] is True
    assert c.calls == []   # denied tool never reaches the server


def test_allow_ruled_mcp_tool_runs():
    c = FakeMCP(SPECS, results={"write_file": "ok"})
    pol = ApprovalPolicy(interactive=False)
    pol.always_allow("write_file")
    a = Agent("fs2", provider=_provider(), tools=mcp_tools(c), session_dir=tempfile.mkdtemp(),
              enable_todo=False, enable_memory=False, telemetry=False, allow_internet=False, approval=pol)
    a.run("go")
    assert c.calls == [("write_file", {"path": "/x"})]


# ── resources ──

class FakeMCPRes(MCPClient):
    def __init__(self, resources, contents):
        super().__init__("stdio", command="x")
        self._res = resources
        self._contents = contents
        self.reads = []

    def list_resources(self):
        return self._res

    def read_resource(self, uri):
        self.reads.append(uri)
        return self._contents.get(uri, "")


RES = [
    {"uri": "file:///a.txt", "name": "A", "description": "first", "mime_type": "text/plain"},
    {"uri": "db://users/1", "name": "User 1", "description": "", "mime_type": "application/json"},
]


def test_resource_tools_are_safe():
    from ergon import mcp_resource_tools
    tools = {t.name: t for t in mcp_resource_tools(FakeMCPRes(RES, {}))}
    assert set(tools) == {"mcp_list_resources", "mcp_read_resource"}
    assert all(t.safe for t in tools.values())


def test_list_resources_formats():
    from ergon import mcp_resource_tools
    t = {x.name: x for x in mcp_resource_tools(FakeMCPRes(RES, {}))}["mcp_list_resources"]
    out = t.fn()
    assert "file:///a.txt" in out and "text/plain" in out and "first" in out


def test_read_resource_routes_by_uri():
    from ergon import mcp_resource_tools
    c = FakeMCPRes(RES, {"file:///a.txt": "hello"})
    t = {x.name: x for x in mcp_resource_tools(c)}["mcp_read_resource"]
    assert t.fn(uri="file:///a.txt") == "hello"
    assert c.reads == ["file:///a.txt"]


def test_empty_resource_list():
    from ergon import mcp_resource_tools
    t = {x.name: x for x in mcp_resource_tools(FakeMCPRes([], {}))}["mcp_list_resources"]
    assert "No resources" in t.fn()


def test_flatten_text_and_binary_resource():
    from ergon.mcp import _flatten_resource
    class TC:
        def __init__(s, t): s.text = t
    class BC:
        def __init__(s): s.text = None; s.blob = b"\x00\x01\x02"; s.mimeType = "image/png"
    class RR:
        def __init__(s, c): s.contents = c
    assert _flatten_resource(RR([TC("a"), TC("b")])) == "a\nb"
    out = _flatten_resource(RR([BC()]))
    assert "binary resource" in out and "image/png" in out


def test_resource_prefix_namespacing():
    from ergon import mcp_resource_tools
    names = {t.name for t in mcp_resource_tools(FakeMCPRes([], {}), prefix="fs_")}
    assert names == {"fs_mcp_list_resources", "fs_mcp_read_resource"}


def test_resource_read_runs_unattended():
    from ergon import mcp_resource_tools
    c = FakeMCPRes(RES, {"file:///a.txt": "CONTENT"})

    class P:
        name = "anthropic"; model = "m"; supports_hosted_search = False
        def __init__(s): s.n = 0
        def complete(s, **k):
            s.n += 1
            if s.n == 1:
                return ModelResponse(text="", tool_calls=[ToolCall("1", "mcp_read_resource", {"uri": "file:///a.txt"})],
                                     stop="tool_use", usage={"input_tokens": 5, "output_tokens": 5})
            return ModelResponse(text="done", stop="end", usage={"input_tokens": 3, "output_tokens": 3})
        def stream(s, **k): yield from _stream_via_complete(s, **k)

    a = Agent("r", provider=P(), tools=mcp_resource_tools(c), session_dir=tempfile.mkdtemp(),
              enable_todo=False, enable_memory=False, telemetry=False, allow_internet=False,
              approval=ApprovalPolicy(interactive=False))
    a.run("read")
    ev = [e for e in a.session.events() if e.get("tool") == "mcp_read_resource"]
    assert ev and ev[0]["denied"] is False
    assert c.reads == ["file:///a.txt"]


# ── prompts ──

class FakeMCPPrompts(MCPClient):
    def __init__(self, prompts, rendered):
        super().__init__("stdio", command="x")
        self._p = prompts
        self._r = rendered
        self.gets = []

    def list_prompts(self):
        return self._p

    def get_prompt(self, name, arguments=None):
        self.gets.append((name, arguments))
        return self._r.get(name, "")


PROMPTS = [
    {"name": "summarize", "description": "Summarize text",
     "arguments": [{"name": "text", "description": "", "required": True},
                   {"name": "style", "description": "", "required": False}]},
    {"name": "greet", "description": "", "arguments": []},
]


def test_prompt_tools_are_safe():
    from ergon import mcp_prompt_tools
    t = {x.name: x for x in mcp_prompt_tools(FakeMCPPrompts(PROMPTS, {}))}
    assert set(t) == {"mcp_list_prompts", "mcp_get_prompt"}
    assert all(x.safe for x in t.values())


def test_list_prompts_formats_signature():
    from ergon import mcp_prompt_tools
    t = {x.name: x for x in mcp_prompt_tools(FakeMCPPrompts(PROMPTS, {}))}["mcp_list_prompts"]
    out = t.fn()
    assert "summarize(text*, style)" in out and "greet()" in out


def test_get_prompt_passes_arguments():
    from ergon import mcp_prompt_tools
    c = FakeMCPPrompts(PROMPTS, {"summarize": "RENDERED"})
    t = {x.name: x for x in mcp_prompt_tools(c)}["mcp_get_prompt"]
    assert t.fn(name="summarize", arguments={"text": "hi"}) == "RENDERED"
    assert c.gets == [("summarize", {"text": "hi"})]


def test_flatten_prompt_messages():
    from ergon.mcp import _flatten_prompt
    class MC:
        def __init__(s, t): s.text = t
    class MSG:
        def __init__(s, role, content): s.role = role; s.content = content
    class PR:
        def __init__(s, m): s.messages = m
    assert _flatten_prompt(PR([MSG("system", MC("A")), MSG("user", MC("B"))])) == "system: A\nuser: B"


def test_empty_prompt_list():
    from ergon import mcp_prompt_tools
    t = {x.name: x for x in mcp_prompt_tools(FakeMCPPrompts([], {}))}["mcp_list_prompts"]
    assert "No prompts" in t.fn()


# ── OAuth ──

def test_oauth_config_and_defaults():
    from ergon import MCPOAuth
    o = MCPOAuth(client_name="ergon-agent", scopes=["mcp:tools"])
    assert o.client_name == "ergon-agent"
    assert o.scopes == ["mcp:tools"]
    assert o.redirect_uri.startswith("http://localhost")
    assert o.token_store is not None


def test_oauth_token_store_roundtrip():
    import asyncio
    from ergon.mcp import _InMemoryTokenStore
    s = _InMemoryTokenStore()
    asyncio.run(s.set_tokens({"access": "tok"}))
    assert asyncio.run(s.get_tokens()) == {"access": "tok"}


def test_http_wires_oauth_and_keeps_header_path():
    from ergon import MCPClient, MCPOAuth
    o = MCPOAuth()
    hc = MCPClient.http("https://x/sse", auth=o)
    assert hc._config["auth"] is o
    hc2 = MCPClient.http("https://y/sse", headers={"Authorization": "Bearer t"})
    assert hc2._config["auth"] is None
    assert hc2._config["headers"]["Authorization"] == "Bearer t"


# ── listChanged / refresh ──

def test_refresh_clears_all_caches():
    c = MCPClient("stdio", command="x")
    c._tools_cache = [1]; c._resources_cache = [2]; c._prompts_cache = [3]
    c.refresh()
    assert c._tools_cache is None and c._resources_cache is None and c._prompts_cache is None


def test_refresh_triggers_refetch():
    class FakeTools(MCPClient):
        def __init__(s): super().__init__("stdio", command="x"); s._n = 0
        def list_tools(s):
            if s._tools_cache is not None:
                return s._tools_cache
            s._n += 1
            s._tools_cache = [{"name": f"v{s._n}", "description": "", "input_schema": {}, "annotations": {}}]
            return s._tools_cache
    c = FakeTools()
    first = c.list_tools()[0]["name"]
    assert c.list_tools()[0]["name"] == first   # cached
    c.refresh()
    assert c.list_tools()[0]["name"] != first   # re-fetched


def test_supports_list_changed():
    class Caps:
        class tools: listChanged = True
        class resources: listChanged = False
    c = MCPClient("stdio", command="x")
    c._session = type("S", (), {"server_capabilities": Caps})()
    assert c.supports_list_changed("tools") is True
    assert c.supports_list_changed("resources") is False
    assert c.supports_list_changed("prompts") is False


# ── Tasks ──

def test_task_handle_detection():
    from ergon.mcp import _task_handle
    class Imm:
        content = [type("B", (), {"text": "done"})()]
    assert _task_handle(Imm()) is None
    class TaskObj:
        task = type("T", (), {"id": "task-123"})()
    assert _task_handle(TaskObj()) == "task-123"
    class TaskTyped:
        resultType = "task"; taskId = "t-9"; content = []
    assert _task_handle(TaskTyped()) == "t-9"


def test_await_task_polls_to_completion():
    class Status:
        def __init__(s, state, text=""):
            s.status = state
            s.content = [type("B", (), {"text": text})()]
    seq = [Status("running"), Status("completed", "FINAL")]
    c = MCPClient("stdio", command="x")
    c._session = type("S", (), {"get_task_result": lambda self, tid: seq.pop(0)})()
    c._run = lambda coro, timeout=60.0: coro
    assert c._await_task("task-123", poll_interval=0, max_wait=5) == "FINAL"


def test_await_task_reports_failure():
    class Status:
        def __init__(s, state, text=""):
            s.status = state
            s.content = [type("B", (), {"text": text})()]
    seq = [Status("failed", "boom")]
    c = MCPClient("stdio", command="x")
    c._session = type("S", (), {"get_task_result": lambda self, tid: seq.pop(0)})()
    c._run = lambda coro, timeout=60.0: coro
    out = c._await_task("t", poll_interval=0, max_wait=5)
    assert "failed" in out and "boom" in out


# ── elicitation ──

def test_elicitation_decline_and_accept():
    import asyncio
    from ergon.mcp import _make_elicitation_callback
    async def run():
        decline = _make_elicitation_callback(lambda m, s: None)
        r = await decline(None, type("P", (), {"message": "c?", "requestedSchema": {}})())
        a1 = getattr(r, "action", None) or (r.get("action") if isinstance(r, dict) else None)
        assert a1 == "decline"
        accept = _make_elicitation_callback(lambda m, s: {"name": "alice"})
        r2 = await accept(None, type("P", (), {"message": "n?", "requestedSchema": {}})())
        assert getattr(r2, "action", None) == "accept"
    asyncio.run(run())


def test_no_elicitation_handler_by_default():
    assert MCPClient.stdio("x")._config.get("elicitation") is None
