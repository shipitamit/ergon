"""Retry-with-backoff and typed error classification."""
import pytest

from ergon import (
    RetryPolicy, NO_RETRY, ProviderError, RateLimitError,
    TransientProviderError, AuthenticationError, ErgonError,
)
from ergon.retry import with_retry
from ergon.errors import classify_provider_exception
from ergon.providers import ModelResponse, _stream_via_complete
from ergon import Agent, ApprovalPolicy


def _raise(name, status=None):
    exc_cls = type(name, (Exception,), {})
    e = exc_cls("boom")
    if status is not None:
        e.status_code = status
    return e


# ── classification ──

def test_classify_by_class_name():
    assert isinstance(classify_provider_exception(_raise("RateLimitError")), RateLimitError)
    assert isinstance(classify_provider_exception(_raise("AuthenticationError")), AuthenticationError)
    assert isinstance(classify_provider_exception(_raise("APITimeoutError")), TransientProviderError)


def test_classify_by_status_code():
    assert isinstance(classify_provider_exception(_raise("X", 429)), RateLimitError)
    assert isinstance(classify_provider_exception(_raise("X", 503)), TransientProviderError)
    assert isinstance(classify_provider_exception(_raise("X", 401)), AuthenticationError)


def test_retryable_flags():
    assert RateLimitError("x").retryable is True
    assert TransientProviderError("x").retryable is True
    assert AuthenticationError("x").retryable is False


def test_unknown_error_not_retryable():
    e = classify_provider_exception(_raise("WeirdError"))
    assert isinstance(e, ProviderError) and e.retryable is False


def test_typed_errors_share_base():
    for cls in (ProviderError, RateLimitError, AuthenticationError):
        assert issubclass(cls, ErgonError)


# ── retry mechanics ──

def test_retries_then_succeeds():
    calls = {"n": 0}
    def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise _raise("RateLimitError")
        return "ok"
    out = with_retry(flaky, RetryPolicy(max_attempts=5, base_delay=0.001), sleep=lambda d: None)
    assert out == "ok" and calls["n"] == 3


def test_auth_error_fails_fast():
    calls = {"n": 0}
    def f():
        calls["n"] += 1
        raise _raise("AuthenticationError")
    with pytest.raises(AuthenticationError):
        with_retry(f, RetryPolicy(max_attempts=5, base_delay=0.001), sleep=lambda d: None)
    assert calls["n"] == 1


def test_exhausted_attempts_raise_typed():
    calls = {"n": 0}
    def f():
        calls["n"] += 1
        raise _raise("InternalServerError")
    with pytest.raises(TransientProviderError):
        with_retry(f, RetryPolicy(max_attempts=3, base_delay=0.001), sleep=lambda d: None)
    assert calls["n"] == 3


def test_no_retry_policy():
    calls = {"n": 0}
    def f():
        calls["n"] += 1
        raise _raise("RateLimitError")
    with pytest.raises(RateLimitError):
        with_retry(f, NO_RETRY, sleep=lambda d: None)
    assert calls["n"] == 1


def test_backoff_exponential_and_capped():
    p = RetryPolicy(base_delay=1.0, max_delay=8.0, jitter=False)
    assert [p.delay_for(a) for a in range(1, 6)] == [1.0, 2.0, 4.0, 8.0, 8.0]


def test_invalid_policy_rejected():
    with pytest.raises(ValueError):
        RetryPolicy(max_attempts=0)


# ── integration through the agent loop ──

class _Flaky:
    name = "flaky"
    model = "m"
    supports_hosted_search = False

    def __init__(self, fails, exc="RateLimitError"):
        self.fails = fails
        self.attempts = 0
        self.exc = exc

    def complete(self, **k):
        self.attempts += 1
        if self.attempts <= self.fails:
            raise _raise(self.exc)
        return ModelResponse(text="recovered", stop="end",
                             usage={"input_tokens": 5, "output_tokens": 5})

    def stream(self, **k):
        yield from _stream_via_complete(self, **k)


def _agent(provider, session_dir, **kw):
    return Agent("t", provider=provider, session_dir=session_dir,
                 enable_todo=False, enable_memory=False, telemetry=False,
                 allow_internet=False, approval=ApprovalPolicy(interactive=False),
                 retry=RetryPolicy(max_attempts=5, base_delay=0.001), **kw)


def test_agent_recovers_from_transient(session_dir):
    p = _Flaky(fails=2)
    result = _agent(p, session_dir).run("go")
    assert result.text == "recovered"
    assert p.attempts == 3


def test_agent_no_double_emit_across_retry(session_dir):
    p = _Flaky(fails=1)
    texts = [ev.data for ev in _agent(p, session_dir).run_stream("go") if ev.kind == "text"]
    assert "".join(texts) == "recovered"


def test_agent_auth_error_propagates(session_dir):
    p = _Flaky(fails=99, exc="AuthenticationError")
    with pytest.raises(AuthenticationError):
        _agent(p, session_dir).run("go")
    assert p.attempts == 1


def test_agent_logs_retry_events(session_dir):
    p = _Flaky(fails=2)
    agent = _agent(p, session_dir)
    agent.run("go")
    retries = [e for e in agent.session.events() if e.get("kind") == "provider_retry"]
    assert len(retries) == 2
    assert retries[0]["error"] == "RateLimitError"
