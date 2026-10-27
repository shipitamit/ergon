"""Typed errors for Ergon.

A small, explicit exception hierarchy so callers can catch what they care about
instead of bare Exception. All inherit from ErgonError, so `except ErgonError`
catches everything the SDK raises deliberately.

    ErgonError
    ├── ProviderError            (the model backend failed)
    │   ├── RateLimitError       (429 / rate limited — retryable)
    │   ├── TransientProviderError (5xx / network blip / timeout — retryable)
    │   └── AuthenticationError  (401/403 bad key — NOT retryable)
    ├── BudgetExceeded           (spend cap hit — informational; the run stops cleanly)
    ├── ConfigurationError       (bad Agent/harness setup — a bug in your config)
    └── ApprovalDenied           (re-exported from approval; a tool was blocked)

`retryable` on ProviderError tells the retry layer whether another attempt could
plausibly succeed.
"""
from __future__ import annotations

from typing import Optional


class ErgonError(Exception):
    """Base class for every error the SDK raises deliberately."""


class ProviderError(ErgonError):
    """A model-provider call failed.

    `retryable` indicates whether retrying could plausibly help. `status_code`
    carries the HTTP status when the provider surfaced one.
    """

    retryable: bool = False

    def __init__(self, message: str, *, status_code: Optional[int] = None,
                 retryable: Optional[bool] = None, provider: Optional[str] = None):
        super().__init__(message)
        self.status_code = status_code
        self.provider = provider
        if retryable is not None:
            self.retryable = retryable


class RateLimitError(ProviderError):
    """429 / provider rate limit. Retryable (after a backoff)."""
    retryable = True


class TransientProviderError(ProviderError):
    """5xx, connection reset, timeout — a transient backend problem. Retryable."""
    retryable = True


class AuthenticationError(ProviderError):
    """401/403 — bad or missing credentials. NOT retryable (retrying won't fix a key)."""
    retryable = False


class BudgetExceeded(ErgonError):
    """A spend cap (max_total_tokens / max_cost) was crossed.

    Note: the agent loop stops *cleanly* on budget (AgentResult.stopped_because
    == "over_budget") rather than raising by default. This exception exists for
    callers who opt into strict budget enforcement.
    """


class ConfigurationError(ErgonError):
    """Invalid Agent, harness, or tool configuration — a setup bug, not a runtime blip."""


# ── classify an arbitrary provider-raised exception into our taxonomy ──

# Names of exception classes the underlying SDKs raise. We match on class name
# (and status code when present) so we don't need to import anthropic/openai.
_RATE_LIMIT_NAMES = {"RateLimitError", "TooManyRequests"}
_AUTH_NAMES = {"AuthenticationError", "PermissionDeniedError", "Unauthorized", "Forbidden"}
_TRANSIENT_NAMES = {
    "APIConnectionError", "APITimeoutError", "InternalServerError",
    "ServiceUnavailableError", "APIStatusError", "Timeout", "ConnectionError",
    "ReadTimeout", "ConnectTimeout",
}


def classify_provider_exception(exc: Exception, *, provider: Optional[str] = None) -> ProviderError:
    """Map a provider/library exception onto Ergon's typed hierarchy.

    Uses the exception's class name and any `status_code`/`status` attribute,
    so it works across anthropic, openai, httpx, and requests without importing
    them. Unknown errors become a non-retryable ProviderError (safe default:
    don't hammer a backend on an error we don't understand).
    """
    if isinstance(exc, ProviderError):
        return exc

    name = type(exc).__name__
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)

    # status code takes precedence when we have it
    if status == 429:
        return RateLimitError(str(exc), status_code=429, provider=provider)
    if status in (401, 403):
        return AuthenticationError(str(exc), status_code=status, provider=provider)
    if isinstance(status, int) and 500 <= status < 600:
        return TransientProviderError(str(exc), status_code=status, provider=provider)

    if name in _RATE_LIMIT_NAMES:
        return RateLimitError(str(exc), status_code=status, provider=provider)
    if name in _AUTH_NAMES:
        return AuthenticationError(str(exc), status_code=status, provider=provider)
    if name in _TRANSIENT_NAMES:
        return TransientProviderError(str(exc), status_code=status, provider=provider)

    # unknown → wrap, non-retryable
    return ProviderError(f"{name}: {exc}", status_code=status, retryable=False, provider=provider)
