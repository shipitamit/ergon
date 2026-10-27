"""Unified routing: resolve() mapping, Router fallback/load-balancing/cooldown,
cost attribution, and the make_provider spec shortcut.

All offline — a local fake provider stands in for every backend, so no network,
keys, or the `litellm` package are needed.
"""
import random

import pytest

from ergon.router import (resolve, Router, Deployment, LiteLLMProvider,
                          register_cost, known_providers, register_provider, ProviderSpec)
from ergon.providers import ModelResponse, make_provider
from ergon.errors import ProviderError, RateLimitError, AuthenticationError
from ergon.retry import RetryPolicy, NO_RETRY
from ergon.usage import Usage, price_for


# ── a local fake provider (independent of conftest, so the resolve tests stand alone) ──

class FakeProv:
    name = "fake"
    supports_hosted_search = False

    def __init__(self, model="m", reply="ok", fail_times=0, error=None):
        self.model = model
        self.reply = reply
        self.fail_times = fail_times
        self.error = error or RateLimitError("rate limited")
        self.calls = 0

    def complete(self, system=None, messages=None, tools=None, max_tokens=4096, use_hosted_search=False):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise self.error
        return ModelResponse(text=self.reply, usage={"input_tokens": 3, "output_tokens": 5})

    def stream(self, **kw):
        resp = self.complete(**kw)
        yield ("text", resp.text)
        yield ("final", resp)


# ───────────────────────────── resolve() ─────────────────────────────

def test_resolve_maps_nvidia_to_openai_adapter(monkeypatch):
    rec = {}
    monkeypatch.setattr("ergon.router.make_provider",
                        lambda a, m, k, b, client=None: rec.update(adapter=a, model=m, key=k, base=b))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-x")
    resolve("nvidia/meta/llama-3.3-70b-instruct")
    assert rec["adapter"] == "openai"
    assert rec["model"] == "meta/llama-3.3-70b-instruct"   # model id keeps its own slash
    assert rec["base"] == "https://integrate.api.nvidia.com/v1"
    assert rec["key"] == "nvapi-x"


def test_resolve_openai_base_url_env_override(monkeypatch):
    rec = {}
    monkeypatch.setattr("ergon.router.make_provider",
                        lambda a, m, k, b, client=None: rec.update(model=m, key=k, base=b))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-1")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy/v1")
    resolve("openai/gpt-4o")
    assert rec["model"] == "gpt-4o" and rec["key"] == "sk-1" and rec["base"] == "https://proxy/v1"


def test_resolve_bedrock_region_default(monkeypatch):
    rec = {}
    monkeypatch.setattr("ergon.router.make_provider",
                        lambda a, m, k, b, client=None: rec.update(adapter=a, base=b))
    monkeypatch.delenv("AWS_REGION", raising=False)
    resolve("bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0")
    assert rec["adapter"] == "bedrock" and rec["base"] == "us-east-1"


def test_resolve_explicit_args_beat_env(monkeypatch):
    rec = {}
    monkeypatch.setattr("ergon.router.make_provider",
                        lambda a, m, k, b, client=None: rec.update(key=k, base=b))
    monkeypatch.setenv("GROQ_API_KEY", "env-key")
    resolve("groq/llama-3.3-70b-versatile", api_key="explicit", base_url="https://custom/v1")
    assert rec["key"] == "explicit" and rec["base"] == "https://custom/v1"


def test_resolve_unknown_prefix_raises():
    with pytest.raises(ValueError):
        resolve("bogus/model")


def test_resolve_missing_model_raises():
    with pytest.raises(ValueError):
        resolve("openai")


def test_resolve_litellm_returns_adapter_without_importing():
    p = resolve("litellm/anthropic/claude-3-5-sonnet-20241022")
    assert isinstance(p, LiteLLMProvider)
    assert p.model == "anthropic/claude-3-5-sonnet-20241022"


def test_register_provider_adds_prefix(monkeypatch):
    register_provider("myco", ProviderSpec("openai", "https://api.myco.ai/v1", ("MYCO_KEY",)))
    assert "myco" in known_providers()
    rec = {}
    monkeypatch.setattr("ergon.router.make_provider",
                        lambda a, m, k, b, client=None: rec.update(base=b))
    monkeypatch.setenv("MYCO_KEY", "k")
    resolve("myco/some-model")
    assert rec["base"] == "https://api.myco.ai/v1"


# ─────────────── make_provider spec shortcut (Agent provider=) ───────────────

def test_make_provider_delegates_slash_spec(monkeypatch):
    rec = {}
    monkeypatch.setattr("ergon.router.make_provider",
                        lambda a, m, k, b, client=None: rec.update(adapter=a, model=m))
    make_provider("nvidia/meta/llama-4-scout", None, None, None)
    assert rec["adapter"] == "openai" and rec["model"] == "meta/llama-4-scout"


def test_make_provider_known_prefix_with_separate_model(monkeypatch):
    rec = {}
    monkeypatch.setattr("ergon.router.make_provider",
                        lambda a, m, k, b, client=None: rec.update(adapter=a, model=m))
    make_provider("groq", "llama-3.3-70b-versatile", None, None)
    assert rec["adapter"] == "openai" and rec["model"] == "llama-3.3-70b-versatile"


def test_make_provider_native_adapter_unaffected():
    # an instance passes straight through
    fp = FakeProv()
    assert make_provider(fp, None, None, None) is fp


# ───────────────────────────── Router ─────────────────────────────

def _router(deps, **kw):
    kw.setdefault("clock", lambda: 0.0)
    kw.setdefault("sleep", lambda s: None)
    return Router(deps, **kw)


def test_router_falls_back_to_next_pool():
    bad = Deployment("x/bad", alias="a",
                     provider=FakeProv(model="bad", fail_times=99, error=AuthenticationError("no key")))
    good = Deployment("y/good", alias="b", provider=FakeProv(model="good", reply="hi"))
    r = _router([bad, good], retry=NO_RETRY)
    resp = r.complete(messages=[])
    assert resp.text == "hi"
    assert r.last_model == "good"
    assert bad.provider.calls == 1            # tried once, then benched
    assert bad._down_until > 0


def test_router_raises_when_all_fail():
    d1 = Deployment("x/1", alias="a", provider=FakeProv(fail_times=99, error=AuthenticationError("x")))
    d2 = Deployment("y/2", alias="b", provider=FakeProv(fail_times=99, error=AuthenticationError("y")))
    r = _router([d1, d2], retry=NO_RETRY)
    with pytest.raises(ProviderError):
        r.complete(messages=[])


def test_round_robin_spreads_calls_evenly():
    a = Deployment("p/a", alias="pool", provider=FakeProv(model="a"))
    b = Deployment("p/b", alias="pool", provider=FakeProv(model="b"))
    r = _router([a, b], strategy="round_robin")
    for _ in range(10):
        r.complete(messages=[])
    assert a.provider.calls == 5 and b.provider.calls == 5


def test_weighted_favors_higher_weight():
    random.seed(42)
    hi = Deployment("p/hi", alias="pool", weight=4, provider=FakeProv(model="hi"))
    lo = Deployment("p/lo", alias="pool", weight=1, provider=FakeProv(model="lo"))
    r = _router([hi, lo], strategy="weighted")
    for _ in range(200):
        r.complete(messages=[])
    assert hi.provider.calls > lo.provider.calls


def test_least_used_balances():
    a = Deployment("p/a", alias="pool", provider=FakeProv(model="a"))
    b = Deployment("p/b", alias="pool", provider=FakeProv(model="b"))
    r = _router([a, b], strategy="least_used")
    for _ in range(6):
        r.complete(messages=[])
    assert abs(a.provider.calls - b.provider.calls) <= 1


def test_cooldown_benches_then_recovers():
    t = {"now": 0.0}
    flaky = FakeProv(model="flaky", fail_times=1, error=AuthenticationError("blip"))
    d = Deployment("p/flaky", provider=flaky, cooldown=30)          # own pool
    backup = Deployment("q/ok", provider=FakeProv(model="ok", reply="B"))  # separate pool
    r = Router([d, backup], retry=NO_RETRY, clock=lambda: t["now"], sleep=lambda s: None)

    # t=0: flaky fails → benched to 30; backup serves
    assert r.complete(messages=[]).text == "B"
    assert d._down_until == 30

    # t=10: still in cooldown → flaky skipped, backup serves, flaky not re-called
    t["now"] = 10
    r.complete(messages=[])
    assert flaky.calls == 1

    # t=40: cooldown elapsed → flaky healthy again (its one failure is spent) and serves
    t["now"] = 40
    assert r.complete(messages=[]).text == "ok"
    assert r.last_model == "flaky" and flaky.calls == 2


def test_retry_then_success_counts_one_deployment():
    # two retryable failures, then success — RetryPolicy absorbs them in one deployment
    flaky = FakeProv(model="retry", reply="won", fail_times=2, error=RateLimitError("429"))
    r = _router([Deployment("p/retry", provider=flaky)],
                retry=RetryPolicy(max_attempts=3, base_delay=0))
    assert r.complete(messages=[]).text == "won"
    assert flaky.calls == 3


def test_stream_falls_back_before_first_event():
    bad = Deployment("x/bad", alias="a",
                     provider=FakeProv(fail_times=99, error=AuthenticationError("x")))
    good = Deployment("y/good", alias="b", provider=FakeProv(model="good", reply="streamed"))
    r = _router([bad, good], retry=NO_RETRY)
    events = list(r.stream(messages=[]))
    kinds = [e[0] for e in events]
    assert "final" in kinds
    final = [e[1] for e in events if e[0] == "final"][0]
    assert final.text == "streamed"
    assert r.last_model == "good"


def test_empty_router_rejected():
    with pytest.raises(ValueError):
        Router([])


def test_bad_strategy_rejected():
    with pytest.raises(ValueError):
        Router(["openai/gpt-4o"], strategy="nonsense")


# ───────────────────────────── cost registry ─────────────────────────────

def test_seeded_open_model_cost_applies():
    # seeded in router: 'llama-3.3-70b' → matches this id by substring
    assert price_for("meta/llama-3.3-70b-instruct") is not None
    u = Usage()
    u.add("meta/llama-3.3-70b-instruct", 1_000_000, 1_000_000)
    assert u.cost() > 0


def test_deployment_cost_override_registers():
    Deployment("nvidia/custom-model-xyz", cost=(1.0, 2.0),
               provider=FakeProv(model="custom-model-xyz"))
    assert price_for("custom-model-xyz") == (1.0, 2.0)


def test_router_last_model_drives_attribution():
    served = FakeProv(model="meta/llama-3.3-70b-instruct")
    r = _router([Deployment("nvidia/meta/llama-3.3-70b-instruct", provider=served)])
    r.complete(messages=[])
    assert r.last_model == "meta/llama-3.3-70b-instruct"


# ─────────────── end-to-end: Agent meters the served model ───────────────

def test_agent_meters_served_model_via_router(make_agent):
    fp = FakeProv(model="meta/llama-3.3-70b-instruct", reply="done")
    router = Router([Deployment("nvidia/meta/llama-3.3-70b-instruct", provider=fp)],
                    clock=lambda: 0.0)
    agent = make_agent([], provider=router)
    result = agent.run("hi")
    assert result.text == "done"
    assert "meta/llama-3.3-70b-instruct" in result.usage.by_model
    assert result.usage.cost() > 0   # seeded llama-3.3-70b price applies to the served model
