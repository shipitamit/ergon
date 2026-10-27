"""Provider adapter layer.

The harness keeps chat history in a NEUTRAL format so persistence,
compaction and the tool loop are provider-agnostic:

    {"role": "user",      "content": str}
    {"role": "assistant", "content": str, "tool_calls": [{"id","name","input"}],
                          "_raw": <provider blocks, optional fidelity cache>}
    {"role": "tool",      "tool_call_id": str, "name": str, "content": str}

Each Provider translates neutral <-> wire format and returns a ModelResponse.
Implement this interface to add any other provider:

    class Provider:
        name: str
        model: str
        supports_hosted_search: bool
        def complete(system, messages, tools, max_tokens, use_hosted_search) -> ModelResponse
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ToolCall:
    id: str
    name: str
    input: Dict[str, Any]


@dataclass
class ModelResponse:
    text: str
    tool_calls: List[ToolCall] = field(default_factory=list)
    stop: str = "end"            # "end" | "tool_use" | "max_tokens" | ...
    usage: Dict[str, int] = field(default_factory=dict)
    raw_content: Any = None      # provider-native assistant content (fidelity cache)
    network_ms: float = 0.0      # time spent in the provider API call itself (excludes our (de)serialization)


def _stream_via_complete(provider, system, messages, tools, max_tokens=4096, use_hosted_search=False):
    """Default streaming for providers without a native stream(): run complete()
    and emit its text as one delta, then the final ModelResponse. Keeps the
    streaming interface uniform so the Agent loop never special-cases providers."""
    resp = provider.complete(system=system, messages=messages, tools=tools,
                             max_tokens=max_tokens, use_hosted_search=use_hosted_search)
    if resp.text:
        yield ("text", resp.text)
    yield ("final", resp)


def make_provider(provider, model: Optional[str], api_key: Optional[str],
                  base_url: Optional[str], client=None):
    """Resolve a provider argument: an instance, a native adapter name
    ('anthropic', 'openai', 'ollama', 'gemini', 'bedrock'), or a router spec.

    A 'provider/model' string (e.g. 'nvidia/meta/llama-3.3-70b-instruct'), or a
    known router prefix passed with a separate model (provider='groq',
    model='llama-3.3-70b-versatile'), is delegated to router.resolve() — which
    fills in the base_url, env key, and cost for that provider.
    """
    if not isinstance(provider, str):
        return provider
    p = provider.lower()
    # 'prefix/model' spec → unified routing (lazy import avoids an import cycle)
    if "/" in provider and model is None:
        from .router import resolve
        return resolve(provider, api_key=api_key, base_url=base_url, client=client)
    if p == "anthropic":
        return AnthropicProvider(model or "claude-sonnet-4-6", api_key=api_key, client=client)
    if p in ("openai", "openai-compatible"):
        return OpenAIProvider(model or "gpt-4o", api_key=api_key, base_url=base_url)
    if p == "ollama":
        # Ollama serves an OpenAI-compatible API locally; auth is ignored but the
        # openai client requires a non-empty key, so default a placeholder.
        return OpenAIProvider(model or "llama3.1",
                              api_key=api_key or "ollama",
                              base_url=base_url or "http://localhost:11434/v1")
    if p in ("gemini", "google"):
        return GeminiProvider(model or "gemini-2.0-flash", api_key=api_key)
    if p in ("bedrock", "aws"):
        # for bedrock, base_url doubles as the AWS region (e.g. "us-east-1")
        return BedrockProvider(model or "anthropic.claude-3-5-sonnet-20240620-v1:0", region=base_url)
    # a known router prefix given with a separate model (e.g. provider='nvidia')
    from .router import _REGISTRY, resolve
    if p in _REGISTRY and model:
        return resolve(f"{p}/{model}", api_key=api_key, base_url=base_url, client=client)
    raise ValueError(
        f"unknown provider '{provider}' — pass 'anthropic', 'openai', 'ollama', "
        "'gemini', 'bedrock', a 'provider/model' spec (e.g. 'nvidia/meta/llama-3.3-70b-instruct'), "
        "or a Provider instance"
    )


# ───────────────────────────── Anthropic ─────────────────────────────

class AnthropicProvider:
    name = "anthropic"
    supports_hosted_search = True   # server-side web_search tool

    def __init__(self, model: str = "claude-sonnet-4-6", api_key: Optional[str] = None, client=None):
        import anthropic  # lazy so openai-only installs work
        self.model = model
        self.client = client or anthropic.Anthropic(api_key=api_key)

    @staticmethod
    def _to_wire(messages: List[Dict]) -> List[Dict]:
        wire: List[Dict] = []
        for m in messages:
            role = m["role"]
            if role == "user":
                wire.append({"role": "user", "content": m["content"]})
            elif role == "assistant":
                if m.get("_raw"):                       # exact blocks from a prior turn
                    wire.append({"role": "assistant", "content": m["_raw"]})
                    continue
                blocks: List[Dict] = []
                if m.get("content"):
                    blocks.append({"type": "text", "text": m["content"]})
                for tc in m.get("tool_calls") or []:
                    blocks.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc["input"]})
                wire.append({"role": "assistant", "content": blocks or [{"type": "text", "text": ""}]})
            elif role == "tool":                        # fold consecutive tool msgs into one user turn
                block = {"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": str(m["content"])}
                if wire and wire[-1]["role"] == "user" and isinstance(wire[-1]["content"], list) \
                        and wire[-1]["content"] and wire[-1]["content"][0].get("type") == "tool_result":
                    wire[-1]["content"].append(block)
                else:
                    wire.append({"role": "user", "content": [block]})
        return wire

    def complete(self, system, messages, tools, max_tokens=4096, use_hosted_search=False) -> ModelResponse:
        api_tools = [dict(t) for t in tools]
        if use_hosted_search:
            api_tools.append({"type": "web_search_20250305", "name": "web_search"})
        kwargs: Dict[str, Any] = dict(model=self.model, max_tokens=max_tokens,
                                      messages=self._to_wire(messages))
        if system:
            kwargs["system"] = system
        if api_tools:
            kwargs["tools"] = api_tools
        _t0 = time.perf_counter()
        resp = self.client.messages.create(**kwargs)
        _net = round((time.perf_counter() - _t0) * 1000, 1)
        content = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in resp.content]
        text = "".join(b.get("text", "") for b in content if b.get("type") == "text").strip()
        calls = [ToolCall(b["id"], b["name"], b.get("input") or {})
                 for b in content if b.get("type") == "tool_use"]
        usage = getattr(resp, "usage", None)
        return ModelResponse(
            text=text,
            tool_calls=calls,
            stop="tool_use" if resp.stop_reason == "tool_use" else str(resp.stop_reason or "end"),
            usage={"input_tokens": getattr(usage, "input_tokens", 0),
                   "output_tokens": getattr(usage, "output_tokens", 0)} if usage else {},
            raw_content=content,
            network_ms=_net,
        )

    def stream(self, system, messages, tools, max_tokens=4096, use_hosted_search=False):
        """Yield ('text', delta) tuples as the model streams, then ('final', ModelResponse).

        Uses the Anthropic streaming API; text deltas arrive live, and the final
        assembled message (with tool calls + usage) is emitted last.
        """
        api_tools = [dict(t) for t in tools]
        if use_hosted_search:
            api_tools.append({"type": "web_search_20250305", "name": "web_search"})
        kwargs: Dict[str, Any] = dict(model=self.model, max_tokens=max_tokens,
                                      messages=self._to_wire(messages))
        if system:
            kwargs["system"] = system
        if api_tools:
            kwargs["tools"] = api_tools
        _t0 = time.perf_counter()
        with self.client.messages.stream(**kwargs) as stream:
            for delta in stream.text_stream:
                if delta:
                    yield ("text", delta)
            final = stream.get_final_message()
        _net = round((time.perf_counter() - _t0) * 1000, 1)
        content = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in final.content]
        text = "".join(b.get("text", "") for b in content if b.get("type") == "text").strip()
        calls = [ToolCall(b["id"], b["name"], b.get("input") or {})
                 for b in content if b.get("type") == "tool_use"]
        usage = getattr(final, "usage", None)
        yield ("final", ModelResponse(
            text=text, tool_calls=calls,
            stop="tool_use" if final.stop_reason == "tool_use" else str(final.stop_reason or "end"),
            usage={"input_tokens": getattr(usage, "input_tokens", 0),
                   "output_tokens": getattr(usage, "output_tokens", 0)} if usage else {},
            raw_content=content, network_ms=_net,
        ))


# ─────────────────────── OpenAI-compatible ───────────────────────
# Covers OpenAI itself plus any /chat/completions-compatible endpoint
# (Groq, Together, Mistral, Ollama, vLLM, ...) via base_url.

class OpenAIProvider:
    name = "openai"
    supports_hosted_search = False  # attach a search Tool instead (tools.web_search_tool)

    def __init__(self, model: str = "gpt-4o", api_key: Optional[str] = None,
                 base_url: Optional[str] = None):
        try:
            from openai import OpenAI  # lazy optional dependency
        except ImportError as e:
            raise ImportError("OpenAIProvider requires the openai package: pip install openai") from e
        self.model = model
        self.client = OpenAI(api_key=api_key, base_url=base_url)

    @staticmethod
    def _to_wire(system, messages: List[Dict]) -> List[Dict]:
        wire: List[Dict] = []
        if system:
            wire.append({"role": "system", "content": system})
        for m in messages:
            role = m["role"]
            if role == "user":
                wire.append({"role": "user", "content": m["content"]})
            elif role == "assistant":
                out: Dict[str, Any] = {"role": "assistant", "content": m.get("content") or None}
                if m.get("tool_calls"):
                    out["tool_calls"] = [
                        {"id": tc["id"], "type": "function",
                         "function": {"name": tc["name"], "arguments": json.dumps(tc["input"])}}
                        for tc in m["tool_calls"]
                    ]
                wire.append(out)
            elif role == "tool":
                wire.append({"role": "tool", "tool_call_id": m["tool_call_id"], "content": str(m["content"])})
        return wire

    def complete(self, system, messages, tools, max_tokens=4096, use_hosted_search=False) -> ModelResponse:
        kwargs: Dict[str, Any] = dict(
            model=self.model, max_tokens=max_tokens,
            messages=self._to_wire(system, messages),
        )
        if tools:
            kwargs["tools"] = [
                {"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                  "parameters": t["input_schema"]}}
                for t in tools
            ]
        _t0 = time.perf_counter()
        resp = self.client.chat.completions.create(**kwargs)
        _net = round((time.perf_counter() - _t0) * 1000, 1)
        msg = resp.choices[0].message
        calls = []
        for tc in msg.tool_calls or []:
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {"input": tc.function.arguments}
            calls.append(ToolCall(tc.id, tc.function.name, args))
        finish = resp.choices[0].finish_reason
        usage = getattr(resp, "usage", None)
        return ModelResponse(
            text=(msg.content or "").strip(),
            tool_calls=calls,
            stop="tool_use" if finish == "tool_calls" else str(finish or "end"),
            usage={"input_tokens": getattr(usage, "prompt_tokens", 0),
                   "output_tokens": getattr(usage, "completion_tokens", 0)} if usage else {},
            raw_content=None,
            network_ms=_net,
        )


# ───────────────────────────── Google Gemini ─────────────────────────────

    def stream(self, system, messages, tools, max_tokens=4096, use_hosted_search=False):
        """Native OpenAI streaming. Text deltas arrive live; tool-call fragments
        are accumulated across chunks, and usage comes from the final chunk
        (stream_options.include_usage)."""
        kwargs: Dict[str, Any] = dict(
            model=self.model, max_tokens=max_tokens,
            messages=self._to_wire(system, messages),
            stream=True, stream_options={"include_usage": True},
        )
        if tools:
            kwargs["tools"] = [
                {"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                  "parameters": t["input_schema"]}}
                for t in tools
            ]
        _t0 = time.perf_counter()
        text_parts: List[str] = []
        tool_frag: Dict[int, Dict[str, Any]] = {}
        finish = None
        usage = None
        for chunk in self.client.chat.completions.create(**kwargs):
            if getattr(chunk, "usage", None):
                usage = chunk.usage
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            delta = choice.delta
            if getattr(delta, "content", None):
                text_parts.append(delta.content)
                yield ("text", delta.content)
            for tc in getattr(delta, "tool_calls", None) or []:
                slot = tool_frag.setdefault(tc.index, {"id": None, "name": None, "args": ""})
                if tc.id:
                    slot["id"] = tc.id
                if tc.function and tc.function.name:
                    slot["name"] = tc.function.name
                if tc.function and tc.function.arguments:
                    slot["args"] += tc.function.arguments
            if choice.finish_reason:
                finish = choice.finish_reason
        _net = round((time.perf_counter() - _t0) * 1000, 1)

        calls = []
        for _idx in sorted(tool_frag):
            frag = tool_frag[_idx]
            try:
                args = json.loads(frag["args"] or "{}")
            except json.JSONDecodeError:
                args = {"input": frag["args"]}
            calls.append(ToolCall(frag["id"] or f"call_{_idx}", frag["name"], args))
        yield ("final", ModelResponse(
            text="".join(text_parts).strip(), tool_calls=calls,
            stop="tool_use" if finish == "tool_calls" else str(finish or "end"),
            usage={"input_tokens": getattr(usage, "prompt_tokens", 0),
                   "output_tokens": getattr(usage, "completion_tokens", 0)} if usage else {},
            raw_content=None, network_ms=_net,
        ))


# ───────────────────────────── Google Gemini ─────────────────────────────


class GeminiProvider:
    name = "gemini"
    supports_hosted_search = True   # Google Search grounding tool

    def __init__(self, model: str = "gemini-2.0-flash", api_key: Optional[str] = None):
        try:
            from google import genai  # lazy optional dependency: pip install google-genai
        except ImportError as e:
            raise ImportError("GeminiProvider requires: pip install google-genai") from e
        self.model = model
        self.client = genai.Client(api_key=api_key)  # falls back to GEMINI_API_KEY env

    @staticmethod
    def _to_wire(messages: List[Dict]) -> List[Dict]:
        contents: List[Dict] = []
        for m in messages:
            role = m["role"]
            if role == "user":
                contents.append({"role": "user", "parts": [{"text": m["content"]}]})
            elif role == "assistant":
                parts: List[Dict] = []
                if m.get("content"):
                    parts.append({"text": m["content"]})
                for tc in m.get("tool_calls") or []:
                    parts.append({"function_call": {"name": tc["name"], "args": tc["input"]}})
                contents.append({"role": "model", "parts": parts or [{"text": ""}]})
            elif role == "tool":
                # Gemini matches function responses by name+order, not id
                part = {"function_response": {"name": m.get("name") or "tool",
                                              "response": {"result": str(m["content"])}}}
                if contents and contents[-1]["role"] == "user" \
                        and "function_response" in contents[-1]["parts"][0]:
                    contents[-1]["parts"].append(part)
                else:
                    contents.append({"role": "user", "parts": [part]})
        return contents

    def complete(self, system, messages, tools, max_tokens=4096, use_hosted_search=False) -> ModelResponse:
        cfg: Dict[str, Any] = {"max_output_tokens": max_tokens}
        if system:
            cfg["system_instruction"] = system
        gtools: List[Dict] = []
        if tools:
            gtools.append({"function_declarations": [
                {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}
                for t in tools
            ]})
        if use_hosted_search:
            # note: some Gemini models restrict mixing search grounding with
            # function declarations; if rejected, set allow_internet=False or
            # drop custom tools on this agent.
            gtools.append({"google_search": {}})
        if gtools:
            cfg["tools"] = gtools
        _t0 = time.perf_counter()
        resp = self.client.models.generate_content(
            model=self.model, contents=self._to_wire(messages), config=cfg,
        )
        _net = round((time.perf_counter() - _t0) * 1000, 1)
        cand = (resp.candidates or [None])[0]
        parts = list(getattr(getattr(cand, "content", None), "parts", None) or [])
        text = "".join(p.text for p in parts if getattr(p, "text", None)).strip()
        calls = []
        for i, p in enumerate(parts):
            fc = getattr(p, "function_call", None)
            if fc:
                calls.append(ToolCall(f"gem_{i}", fc.name, dict(fc.args or {})))
        um = getattr(resp, "usage_metadata", None)
        return ModelResponse(
            text=text,
            tool_calls=calls,
            stop="tool_use" if calls else "end",
            usage={"input_tokens": getattr(um, "prompt_token_count", 0) or 0,
                   "output_tokens": getattr(um, "candidates_token_count", 0) or 0} if um else {},
            raw_content=None,
            network_ms=_net,
        )


# ───────────────────────────── AWS Bedrock ─────────────────────────────
# Uses the Converse API, so any Bedrock model with tool support works
# (Anthropic, Meta, Mistral, Amazon Nova, ...). Auth comes from the standard
# AWS credential chain (env vars, ~/.aws, instance role).

    def stream(self, system, messages, tools, max_tokens=4096, use_hosted_search=False):
        """Native Gemini streaming via generate_content_stream. Text parts arrive
        live; function calls and usage are assembled from the streamed chunks."""
        cfg: Dict[str, Any] = {"max_output_tokens": max_tokens}
        if system:
            cfg["system_instruction"] = system
        gtools: List[Dict] = []
        if tools:
            gtools.append({"function_declarations": [
                {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}
                for t in tools
            ]})
        if use_hosted_search:
            gtools.append({"google_search": {}})
        if gtools:
            cfg["tools"] = gtools
        _t0 = time.perf_counter()
        text_parts: List[str] = []
        calls: List[ToolCall] = []
        um = None
        cidx = 0
        for chunk in self.client.models.generate_content_stream(
            model=self.model, contents=self._to_wire(messages), config=cfg,
        ):
            if getattr(chunk, "usage_metadata", None):
                um = chunk.usage_metadata
            cand = (getattr(chunk, "candidates", None) or [None])[0]
            parts = list(getattr(getattr(cand, "content", None), "parts", None) or [])
            for p in parts:
                if getattr(p, "text", None):
                    text_parts.append(p.text)
                    yield ("text", p.text)
                fc = getattr(p, "function_call", None)
                if fc:
                    calls.append(ToolCall(f"gem_{cidx}", fc.name, dict(fc.args or {})))
                    cidx += 1
        _net = round((time.perf_counter() - _t0) * 1000, 1)
        yield ("final", ModelResponse(
            text="".join(text_parts).strip(), tool_calls=calls,
            stop="tool_use" if calls else "end",
            usage={"input_tokens": getattr(um, "prompt_token_count", 0) or 0,
                   "output_tokens": getattr(um, "candidates_token_count", 0) or 0} if um else {},
            raw_content=None, network_ms=_net,
        ))


class BedrockProvider:
    name = "bedrock"
    supports_hosted_search = False  # attach tools.web_search_tool(fn) instead

    def __init__(self, model: str = "anthropic.claude-3-5-sonnet-20240620-v1:0",
                 region: Optional[str] = None):
        try:
            import boto3  # lazy optional dependency: pip install boto3
        except ImportError as e:
            raise ImportError("BedrockProvider requires: pip install boto3") from e
        self.model = model
        self.client = boto3.client("bedrock-runtime", **({"region_name": region} if region else {}))

    @staticmethod
    def _to_wire(messages: List[Dict]) -> List[Dict]:
        wire: List[Dict] = []
        for m in messages:
            role = m["role"]
            if role == "user":
                wire.append({"role": "user", "content": [{"text": m["content"]}]})
            elif role == "assistant":
                blocks: List[Dict] = []
                if m.get("content"):
                    blocks.append({"text": m["content"]})
                for tc in m.get("tool_calls") or []:
                    blocks.append({"toolUse": {"toolUseId": tc["id"], "name": tc["name"], "input": tc["input"]}})
                wire.append({"role": "assistant", "content": blocks or [{"text": ""}]})
            elif role == "tool":
                block = {"toolResult": {"toolUseId": m["tool_call_id"],
                                        "content": [{"text": str(m["content"])}]}}
                if wire and wire[-1]["role"] == "user" and "toolResult" in wire[-1]["content"][0]:
                    wire[-1]["content"].append(block)
                else:
                    wire.append({"role": "user", "content": [block]})
        return wire

    def complete(self, system, messages, tools, max_tokens=4096, use_hosted_search=False) -> ModelResponse:
        kwargs: Dict[str, Any] = dict(
            modelId=self.model,
            messages=self._to_wire(messages),
            inferenceConfig={"maxTokens": max_tokens},
        )
        if system:
            kwargs["system"] = [{"text": system}]
        if tools:
            kwargs["toolConfig"] = {"tools": [
                {"toolSpec": {"name": t["name"], "description": t["description"],
                              "inputSchema": {"json": t["input_schema"]}}}
                for t in tools
            ]}
        _t0 = time.perf_counter()
        resp = self.client.converse(**kwargs)
        _net = round((time.perf_counter() - _t0) * 1000, 1)
        blocks = resp.get("output", {}).get("message", {}).get("content", [])
        text = "".join(b.get("text", "") for b in blocks if "text" in b).strip()
        calls = [ToolCall(b["toolUse"]["toolUseId"], b["toolUse"]["name"], b["toolUse"].get("input") or {})
                 for b in blocks if "toolUse" in b]
        usage = resp.get("usage", {})
        return ModelResponse(
            text=text,
            tool_calls=calls,
            stop="tool_use" if resp.get("stopReason") == "tool_use" else str(resp.get("stopReason") or "end"),
            usage={"input_tokens": usage.get("inputTokens", 0),
                   "output_tokens": usage.get("outputTokens", 0)},
            raw_content=None,
        )

    def stream(self, system, messages, tools, max_tokens=4096, use_hosted_search=False):
        """Native Bedrock streaming via converse_stream. Text deltas arrive live;
        toolUse blocks are assembled from contentBlockStart + input fragments,
        and usage arrives in the trailing metadata event."""
        kwargs: Dict[str, Any] = dict(
            modelId=self.model,
            messages=self._to_wire(messages),
            inferenceConfig={"maxTokens": max_tokens},
        )
        if system:
            kwargs["system"] = [{"text": system}]
        if tools:
            kwargs["toolConfig"] = {"tools": [
                {"toolSpec": {"name": t["name"], "description": t["description"],
                              "inputSchema": {"json": t["input_schema"]}}}
                for t in tools
            ]}
        _t0 = time.perf_counter()
        text_parts: List[str] = []
        blocks: Dict[int, Dict[str, Any]] = {}   # contentBlockIndex -> {id, name, input_str}
        stop_reason = None
        in_tok = out_tok = 0
        resp = self.client.converse_stream(**kwargs)
        for event in resp.get("stream", []):
            if "contentBlockStart" in event:
                start = event["contentBlockStart"]
                idx = start.get("contentBlockIndex", 0)
                tu = start.get("start", {}).get("toolUse")
                if tu:
                    blocks[idx] = {"id": tu.get("toolUseId"), "name": tu.get("name"), "input": ""}
            elif "contentBlockDelta" in event:
                d = event["contentBlockDelta"]
                idx = d.get("contentBlockIndex", 0)
                delta = d.get("delta", {})
                if "text" in delta:
                    text_parts.append(delta["text"])
                    yield ("text", delta["text"])
                elif "toolUse" in delta:
                    blocks.setdefault(idx, {"id": None, "name": None, "input": ""})
                    blocks[idx]["input"] += delta["toolUse"].get("input", "")
            elif "messageStop" in event:
                stop_reason = event["messageStop"].get("stopReason")
            elif "metadata" in event:
                u = event["metadata"].get("usage", {})
                in_tok = u.get("inputTokens", 0); out_tok = u.get("outputTokens", 0)
        _net = round((time.perf_counter() - _t0) * 1000, 1)

        calls = []
        for idx in sorted(blocks):
            b = blocks[idx]
            try:
                args = json.loads(b["input"] or "{}")
            except json.JSONDecodeError:
                args = {"input": b["input"]}
            calls.append(ToolCall(b["id"] or f"tool_{idx}", b["name"], args))
        yield ("final", ModelResponse(
            text="".join(text_parts).strip(), tool_calls=calls,
            stop="tool_use" if stop_reason == "tool_use" else str(stop_reason or "end"),
            usage={"input_tokens": in_tok, "output_tokens": out_tok},
            raw_content=None, network_ms=_net,
        ))
