"""OpenTelemetry observability, following the generative-AI semantic
conventions (gen_ai.* attributes). Degrades to a no-op when the
opentelemetry packages are not installed, so it is always safe to enable.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Dict, Iterator

try:
    from opentelemetry import trace as _trace

    _tracer = _trace.get_tracer("ergon", "0.1.0")
    _HAVE_OTEL = True
except Exception:  # pragma: no cover
    _tracer = None
    _HAVE_OTEL = False


class Telemetry:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled and _HAVE_OTEL

    @contextmanager
    def span(self, name: str, attrs: Dict[str, Any]) -> Iterator[Any]:
        if not self.enabled:
            yield _NoSpan()
            return
        with _tracer.start_as_current_span(name) as span:
            for k, v in attrs.items():
                span.set_attribute(k, v)
            yield span

    @contextmanager
    def model_call(self, model: str, agent: str, system: str = "anthropic") -> Iterator[Any]:
        with self.span(
            f"chat {model}",
            {
                "gen_ai.operation.name": "chat",
                "gen_ai.system": system,
                "gen_ai.request.model": model,
                "gen_ai.agent.name": agent,
            },
        ) as span:
            yield span

    @staticmethod
    def record_usage(span: Any, usage: dict, stop: str = "") -> None:
        if not usage or isinstance(span, _NoSpan):
            return
        span.set_attribute("gen_ai.usage.input_tokens", usage.get("input_tokens", 0))
        span.set_attribute("gen_ai.usage.output_tokens", usage.get("output_tokens", 0))
        if stop:
            span.set_attribute("gen_ai.response.finish_reasons", [stop])

    @contextmanager
    def tool_call(self, tool_name: str, agent: str) -> Iterator[Any]:
        with self.span(
            f"execute_tool {tool_name}",
            {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": tool_name,
                "gen_ai.agent.name": agent,
            },
        ) as span:
            yield span


class _NoSpan:
    def set_attribute(self, *a, **k):  # noqa: D401
        pass
