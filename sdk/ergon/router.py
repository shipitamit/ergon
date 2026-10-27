"""Unified model routing — built on Ergon's own adapters.

Three things make string-addressed, multi-provider routing ergonomic, and this
module adds them on top of the native adapters:

1. **String-addressed resolution** — one `"provider/model"` string resolves the
   adapter + base_url + API key (from env) + cost in a single call:

       from ergon import Agent
       from ergon.router import resolve

       agent = Agent("a", provider=resolve("nvidia/meta/llama-3.3-70b-instruct"))
       agent = Agent("a", provider=resolve("groq/llama-3.3-70b-versatile"))
       # or straight on the Agent — a 'prefix/model' provider string is resolved:
       agent = Agent("a", provider="openai/gpt-4o")

2. **A Router** — fallback chains + load-balancing across deployments, exposed as
   an ordinary Provider so the Agent loop never special-cases it:

       from ergon.router import Router, Deployment

       router = Router([
           Deployment("openai/gpt-4o", alias="chat", weight=2),      # 2/3 of traffic
           Deployment("nvidia/meta/llama-3.3-70b-instruct", alias="chat"),  # 1/3, same pool
           "anthropic/claude-sonnet-4-6",                            # fallback pool
       ], strategy="weighted")
       agent = Agent("a", provider=router)

   Deployments that share an `alias` form one load-balanced pool; distinct
   aliases are tried in order as fallbacks when a whole pool is failing.

3. **A cost registry** — `register_cost()` feeds the same price table the Usage
   meter reads, so cost is attributed to whichever deployment actually served
   each call (the Agent meters `provider.last_model`, which the Router updates).

   For the long tail of providers Ergon doesn't natively adapt, use the optional
   `litellm` adapter: `resolve("litellm/<any litellm model>")` delegates to the
   installed `litellm` package.

NOTE: resolution mapping, fallback order, load-balancing strategies, cooldown,
and cost attribution are unit-tested offline against fake providers. Real
provider endpoints and the `litellm` package are not exercised here — validate
live before relying on a given provider.
"""
from __future__ import annotations

import json
import os
import random
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from .providers import (ModelResponse, OpenAIProvider, ToolCall, make_provider,
                        _stream_via_complete)
from .retry import RetryPolicy, with_retry
from .errors import ProviderError, classify_provider_exception
from .usage import set_prices


# ───────────────────────── provider registry ─────────────────────────

@dataclass(frozen=True)
class ProviderSpec:
    """How a provider prefix maps onto an Ergon adapter.

    adapter      : the make_provider() string ('openai', 'anthropic', ...).
    base_url     : default endpoint for OpenAI-compatible providers (None = SDK default).
    key_envs     : env vars tried in order for the API key.
    base_url_env : env var that overrides base_url (for self-hosted / Azure / vLLM).
    region_env   : env var for the AWS region (bedrock only; base_url doubles as region).
    """
    adapter: str
    base_url: Optional[str] = None
    key_envs: Tuple[str, ...] = ()
    base_url_env: Optional[str] = None
    region_env: Optional[str] = None


# Known prefixes. Everything OpenAI-compatible routes through the OpenAIProvider
# with the right base_url; add a provider by adding a row (or register_provider()).
_REGISTRY: Dict[str, ProviderSpec] = {
    "openai":     ProviderSpec("openai", None, ("OPENAI_API_KEY",), base_url_env="OPENAI_BASE_URL"),
    "anthropic":  ProviderSpec("anthropic", None, ("ANTHROPIC_API_KEY",)),
    "claude":     ProviderSpec("anthropic", None, ("ANTHROPIC_API_KEY",)),
    # NVIDIA NIM / build.nvidia.com — OpenAI-compatible; accepts a dedicated key or OPENAI_API_KEY
    "nvidia":     ProviderSpec("openai", "https://integrate.api.nvidia.com/v1", ("NVIDIA_API_KEY", "OPENAI_API_KEY")),
    "nim":        ProviderSpec("openai", "https://integrate.api.nvidia.com/v1", ("NVIDIA_API_KEY", "OPENAI_API_KEY")),
    "groq":       ProviderSpec("openai", "https://api.groq.com/openai/v1", ("GROQ_API_KEY",)),
    "together":   ProviderSpec("openai", "https://api.together.xyz/v1", ("TOGETHER_API_KEY",)),
    "mistral":    ProviderSpec("openai", "https://api.mistral.ai/v1", ("MISTRAL_API_KEY",)),
    "deepseek":   ProviderSpec("openai", "https://api.deepseek.com/v1", ("DEEPSEEK_API_KEY",)),
    "fireworks":  ProviderSpec("openai", "https://api.fireworks.ai/inference/v1", ("FIREWORKS_API_KEY",)),
    "openrouter": ProviderSpec("openai", "https://openrouter.ai/api/v1", ("OPENROUTER_API_KEY",)),
    "perplexity": ProviderSpec("openai", "https://api.perplexity.ai", ("PERPLEXITY_API_KEY",)),
    "xai":        ProviderSpec("openai", "https://api.x.ai/v1", ("XAI_API_KEY",)),
    "vllm":       ProviderSpec("openai", None, ("VLLM_API_KEY", "OPENAI_API_KEY"), base_url_env="VLLM_BASE_URL"),
    "azure":      ProviderSpec("openai", None, ("AZURE_OPENAI_API_KEY", "OPENAI_API_KEY"), base_url_env="AZURE_OPENAI_ENDPOINT"),
    "ollama":     ProviderSpec("ollama", "http://localhost:11434/v1", (), base_url_env="OLLAMA_BASE_URL"),
    "gemini":     ProviderSpec("gemini", None, ("GEMINI_API_KEY", "GOOGLE_API_KEY")),
    "google":     ProviderSpec("gemini", None, ("GEMINI_API_KEY", "GOOGLE_API_KEY")),
    "bedrock":    ProviderSpec("bedrock", None, (), region_env="AWS_REGION"),
    "aws":        ProviderSpec("bedrock", None, (), region_env="AWS_REGION"),
}


def register_provider(prefix: str, spec: ProviderSpec) -> None:
    """Add or override a provider prefix in the routing registry."""
    _REGISTRY[prefix.lower()] = spec


def known_providers() -> List[str]:
    """Sorted list of recognised provider prefixes (plus 'litellm')."""
    return sorted(list(_REGISTRY) + ["litellm"])


def _model_of(spec: str) -> str:
    """The model id within a 'prefix/model' spec (used for cost display)."""
    prefix, sep, model = spec.partition("/")
    return model if sep else spec


# ───────────────────────────── resolve() ─────────────────────────────

def resolve(spec: str, *, api_key: Optional[str] = None, base_url: Optional[str] = None,
            client: Any = None):
    """Resolve a `'provider/model'` string to a configured Provider instance.

    The part before the first '/' is the provider prefix; the rest is the model
    id (which may itself contain '/', e.g. 'nvidia/meta/llama-3.3-70b-instruct').
    base_url/api_key come from (1) explicit args, (2) the provider's env vars,
    (3) the registry default. `'litellm/<model>'` delegates to the litellm package.
    """
    if not isinstance(spec, str) or not spec:
        raise ValueError("resolve() expects a non-empty 'provider/model' string")
    prefix, sep, model = spec.partition("/")
    prefix = prefix.lower()

    if prefix == "litellm":
        if not model:
            raise ValueError(f"model missing in '{spec}' — expected 'litellm/<model>'")
        return LiteLLMProvider(model, api_key=api_key, base_url=base_url)

    ps = _REGISTRY.get(prefix)
    if ps is None:
        raise ValueError(
            f"unknown provider prefix '{prefix}' in '{spec}'. "
            f"Known: {known_providers()}. For an OpenAI-compatible endpoint that "
            f"isn't listed, use 'openai/<model>' with base_url=..., or register_provider()."
        )
    if not sep or not model:
        raise ValueError(f"model missing in '{spec}' — expected '<provider>/<model>'")

    # key: explicit > env chain
    key = api_key
    for env in ps.key_envs:
        if key:
            break
        key = os.environ.get(env)

    # base_url / region: explicit > env override > registry default
    if ps.adapter == "bedrock":
        burl = base_url or (os.environ.get(ps.region_env) if ps.region_env else None) or "us-east-1"
    else:
        env_url = os.environ.get(ps.base_url_env) if ps.base_url_env else None
        burl = base_url or env_url or ps.base_url

    return make_provider(ps.adapter, model, key, burl, client=client)


# ─────────────────────── optional litellm adapter ───────────────────────

class LiteLLMProvider:
    """Adapter that delegates to the installed `litellm` package (Path B).

    Gives access to litellm's long tail of providers while keeping Ergon's
    neutral message format. litellm speaks the OpenAI chat shape, so we reuse the
    OpenAIProvider wire conversion. Lazy-imports litellm — importing this module
    never requires it.

        resolve("litellm/anthropic/claude-3-5-sonnet-20241022")
        resolve("litellm/gemini/gemini-1.5-pro")
    """
    name = "litellm"
    supports_hosted_search = False

    def __init__(self, model: str, api_key: Optional[str] = None, base_url: Optional[str] = None):
        self.model = model
        self._api_key = api_key
        self._base_url = base_url
        self._mod = None

    def _ensure(self):
        if self._mod is None:
            try:
                import litellm  # lazy optional dependency
            except ImportError as e:
                raise ImportError(
                    "LiteLLMProvider requires the litellm package: pip install litellm"
                ) from e
            self._mod = litellm
        return self._mod

    def complete(self, system, messages, tools, max_tokens=4096, use_hosted_search=False) -> ModelResponse:
        lit = self._ensure()
        kwargs: Dict[str, Any] = dict(
            model=self.model, max_tokens=max_tokens,
            messages=OpenAIProvider._to_wire(system, messages),
        )
        if self._api_key:
            kwargs["api_key"] = self._api_key
        if self._base_url:
            kwargs["base_url"] = self._base_url
        if tools:
            kwargs["tools"] = [
                {"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                  "parameters": t["input_schema"]}}
                for t in tools
            ]
        _t0 = time.perf_counter()
        resp = lit.completion(**kwargs)
        _net = round((time.perf_counter() - _t0) * 1000, 1)
        msg = resp.choices[0].message
        calls = []
        for tc in (getattr(msg, "tool_calls", None) or []):
            try:
                args = json.loads(tc.function.arguments or "{}")
            except (json.JSONDecodeError, TypeError):
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


# ───────────────────────────── cost registry ─────────────────────────────

def register_cost(model_substring: str, input_per_mtok: float, output_per_mtok: float) -> None:
    """Register an estimated price (USD per 1M tokens) for any model id.

    Keys match by substring against the model the Agent meters, so a key like
    'llama-3.3-70b' covers 'meta/llama-3.3-70b-instruct' on any provider. These
    are estimates — override freely.
    """
    set_prices({model_substring: (input_per_mtok, output_per_mtok)})


# A starter set of estimates for common open models reached via the OpenAI-compatible
# providers above (NVIDIA/Groq/Together/etc.). Prices drift — treat as estimates and
# override with register_cost(). usage.py already covers the first-party model lines.
_SEED_COSTS: Dict[str, Tuple[float, float]] = {
    "llama-3.3-70b": (0.60, 0.60),
    "llama-3.1-405b": (3.0, 3.0),
    "llama-3.1-70b": (0.60, 0.60),
    "llama-3.1-8b": (0.10, 0.10),
    "llama-4": (0.90, 0.90),
    "mixtral-8x7b": (0.50, 0.50),
    "mixtral-8x22b": (1.20, 1.20),
    "qwen": (0.60, 0.60),
    "deepseek": (0.55, 2.19),
    "gpt-oss": (0.30, 0.30),
    "nemotron": (0.80, 0.80),
}
for _k, _v in _SEED_COSTS.items():
    set_prices({_k: _v})


# ───────────────────────────── deployments ─────────────────────────────

@dataclass
class Deployment:
    """One routable target in a Router.

    model    : a resolve() spec, e.g. 'openai/gpt-4o' or 'nvidia/meta/llama-...'.
    alias    : logical pool name — deployments sharing an alias are load-balanced;
               distinct aliases form the fallback order. Defaults to the model.
    weight   : relative share under the 'weighted' strategy (higher = more traffic).
    api_key  : per-deployment key override (else resolved from env).
    base_url : per-deployment endpoint override.
    cooldown : seconds to bench this deployment after a failure before retrying it.
    cost     : optional (input, output) USD per 1M tokens, registered for this model.
    provider : an already-constructed Provider instance (skips resolve(); for tests
               or custom adapters).
    """
    model: str
    alias: Optional[str] = None
    weight: float = 1.0
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    cooldown: float = 30.0
    cost: Optional[Tuple[float, float]] = None
    provider: Any = None

    # runtime state
    _down_until: float = field(default=0.0, repr=False)
    _uses: int = field(default=0, repr=False)

    def __post_init__(self):
        if self.cost is not None:
            register_cost(_model_of(self.model), self.cost[0], self.cost[1])

    @property
    def pool(self) -> str:
        return self.alias or self.model

    def get_provider(self):
        if self.provider is None:
            self.provider = resolve(self.model, api_key=self.api_key, base_url=self.base_url)
        return self.provider

    def model_id(self) -> str:
        """The model id used for cost attribution (provider's live model if resolved)."""
        return getattr(self.provider, "model", None) or _model_of(self.model)


# ───────────────────────────── the Router ─────────────────────────────

class Router:
    """A Provider that routes across deployments with fallbacks + load-balancing.

    Deployments sharing an `alias` form a load-balanced pool; pools are tried in
    first-seen order as fallbacks. Within a pool, `strategy` picks the order:
    'round_robin' (default), 'weighted' (by Deployment.weight), or 'least_used'.
    A deployment that raises a ProviderError is benched for its `cooldown`, and
    the next deployment/pool is tried. Per-call retries use `retry`.

    Implements the Provider interface (name/model/complete/stream), so
    `Agent(provider=Router(...))` works with no loop changes. After each call,
    `last_model` holds the model that actually served it, which the Agent meters
    so cost is attributed to the real deployment.
    """
    name = "router"
    supports_hosted_search = False   # mixed pools; attach a search Tool instead

    def __init__(self, deployments: Sequence[Any], *, strategy: str = "round_robin",
                 retry: Optional[RetryPolicy] = None,
                 clock: Callable[[], float] = time.time,
                 sleep: Callable[[float], None] = time.sleep):
        if not deployments:
            raise ValueError("Router needs at least one deployment")
        if strategy not in ("round_robin", "weighted", "least_used"):
            raise ValueError("strategy must be 'round_robin', 'weighted', or 'least_used'")
        self.deployments: List[Deployment] = [
            d if isinstance(d, Deployment) else Deployment(d) for d in deployments
        ]
        self.strategy = strategy
        self.retry = retry if retry is not None else RetryPolicy()
        self._clock = clock
        self._sleep = sleep
        self._rr = 0

        # group into pools by alias, preserving first-seen pool order (= fallback order)
        self.pools: List[Tuple[str, List[Deployment]]] = []
        index: Dict[str, List[Deployment]] = {}
        for d in self.deployments:
            if d.pool not in index:
                index[d.pool] = []
                self.pools.append((d.pool, index[d.pool]))
            index[d.pool].append(d)

        # display / default pricing model = first deployment's model id
        self.model = _model_of(self.deployments[0].model)
        self.last_model = self.model

    # ── selection within a pool ──
    def _select(self, deps: List[Deployment], now: float, any_live: bool) -> List[Deployment]:
        # respect cooldown while any deployment anywhere is healthy; only when
        # everything is benched do we try benched ones as a last resort.
        live = [d for d in deps if d._down_until <= now] if any_live else list(deps)
        if not live:
            return []
        if self.strategy == "round_robin":
            self._rr += 1
            off = self._rr % len(live)
            return live[off:] + live[:off]
        if self.strategy == "weighted":
            # weighted shuffle via exponential keys (higher weight → earlier)
            return sorted(live, key=lambda d: random.random() ** (1.0 / max(d.weight, 1e-9)),
                          reverse=True)
        # least_used
        return sorted(live, key=lambda d: d._uses)

    def _iter_candidates(self, now: float):
        any_live = any(d._down_until <= now for d in self.deployments)
        for _pool, deps in self.pools:
            for d in self._select(deps, now, any_live):
                yield d

    # ── Provider interface ──
    def complete(self, system=None, messages=None, tools=None, max_tokens=4096,
                 use_hosted_search=False) -> ModelResponse:
        kw = dict(system=system, messages=messages, tools=tools,
                  max_tokens=max_tokens, use_hosted_search=use_hosted_search)
        errors: List[str] = []
        now = self._clock()
        for d in self._iter_candidates(now):
            prov = None
            try:
                prov = d.get_provider()
                result = with_retry(lambda: prov.complete(**kw), self.retry,
                                    provider=getattr(prov, "name", None), sleep=self._sleep)
                d._uses += 1
                self.last_model = d.model_id()
                return result
            except ProviderError as e:
                d._down_until = self._clock() + d.cooldown
                errors.append(f"{d.model}: {e}")
            except Exception as e:  # noqa: BLE001 — classify, bench, fall back
                err = classify_provider_exception(e, provider=getattr(prov, "name", None))
                d._down_until = self._clock() + d.cooldown
                errors.append(f"{d.model}: {err}")
        raise ProviderError("all router deployments failed: " + " | ".join(errors))

    def stream(self, system=None, messages=None, tools=None, max_tokens=4096,
               use_hosted_search=False):
        """Pick a deployment (with fallback) and delegate its stream. Falls back
        only before the first event is emitted; once streaming starts, errors
        propagate (you can't un-emit deltas). Per-call retry applies to complete()
        rather than mid-stream."""
        kw = dict(system=system, messages=messages, tools=tools,
                  max_tokens=max_tokens, use_hosted_search=use_hosted_search)
        errors: List[str] = []
        now = self._clock()
        for d in self._iter_candidates(now):
            prov = None
            try:
                prov = d.get_provider()
                _stream = getattr(prov, "stream", None) or (lambda **k: _stream_via_complete(prov, **k))
                it = _stream(**kw)
                first = next(it)                      # may raise → fall back
            except StopIteration:
                d._uses += 1
                self.last_model = d.model_id()
                return
            except Exception as e:  # noqa: BLE001
                err = classify_provider_exception(e, provider=getattr(prov, "name", None))
                d._down_until = self._clock() + d.cooldown
                errors.append(f"{d.model}: {err}")
                continue
            # success — commit to this deployment and emit the full stream
            d._uses += 1
            self.last_model = d.model_id()
            yield first
            yield from it
            return
        raise ProviderError("all router deployments failed (stream): " + " | ".join(errors))
