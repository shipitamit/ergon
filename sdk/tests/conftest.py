"""Shared test fixtures for the Ergon SDK suite.

The provider adapters (`anthropic`, `openai`) are optional deps and require
network access, so the whole suite runs against a scriptable in-memory fake
provider — no network, no keys, fully deterministic.
"""
import sys
import types
import tempfile

import pytest

# ── stub the optional provider SDKs so `import ergon` never needs them ──
for _m in ("anthropic", "openai"):
    if _m not in sys.modules:
        _mod = types.ModuleType(_m)
        sys.modules[_m] = _mod
sys.modules["anthropic"].Anthropic = type("Anthropic", (), {"__init__": lambda s, **k: None})
sys.modules["openai"].OpenAI = type("OpenAI", (), {"__init__": lambda s, **k: None})

from ergon import Agent, ApprovalPolicy  # noqa: E402
from ergon.providers import ModelResponse, ToolCall, _stream_via_complete  # noqa: E402


class FakeProvider:
    """A provider that replays a fixed script of ModelResponses.

    Only implements complete(); stream() is derived via the SDK's documented
    fallback, so this doubles as a test of the complete()-only contract.
    """

    name = "fake"
    model = "fake-model"
    supports_hosted_search = False

    def __init__(self, script):
        # script: list of ModelResponse, replayed in order
        self._script = list(script)
        self.calls = 0

    def complete(self, system, messages, tools, max_tokens=4096, use_hosted_search=False):
        self.calls += 1
        if self._script:
            return self._script.pop(0)
        # default terminal response if the script runs dry
        return ModelResponse(text="done", stop="end",
                             usage={"input_tokens": 1, "output_tokens": 1})

    def stream(self, **kwargs):
        yield from _stream_via_complete(self, **kwargs)


@pytest.fixture
def session_dir():
    return tempfile.mkdtemp()


@pytest.fixture
def make_agent(session_dir):
    """Factory: build an Agent wired to a FakeProvider replaying `script`."""
    counter = {"n": 0}

    def _make(script, **overrides):
        counter["n"] += 1
        cfg = dict(
            provider=FakeProvider(script),
            session_dir=f"{session_dir}/agent-{counter['n']}",
            enable_todo=False,
            enable_memory=False,
            telemetry=False,
            allow_internet=False,
            approval=ApprovalPolicy(interactive=False),
        )
        cfg.update(overrides)
        name = cfg.pop("name", f"test-agent-{counter['n']}")
        return Agent(name, **cfg)

    return _make


@pytest.fixture
def resp():
    """Helper to build ModelResponses concisely."""
    def _resp(text="", tool_calls=None, stop="end", in_tok=10, out_tok=10):
        return ModelResponse(
            text=text,
            tool_calls=tool_calls or [],
            stop=stop,
            usage={"input_tokens": in_tok, "output_tokens": out_tok},
        )
    return _resp


@pytest.fixture
def tool_call():
    def _tc(name, tool_input=None, id="tc1"):
        return ToolCall(id=id, name=name, input=tool_input or {})
    return _tc
