"""Retry with exponential backoff + jitter for provider calls.

Only *retryable* provider errors (rate limits, 5xx, timeouts) are retried;
auth errors and unknown failures propagate immediately — retrying a bad API key
just wastes time. Backoff is exponential with full jitter to avoid thundering-herd
retries, capped at `max_delay`.
"""
from __future__ import annotations

import time
import random
from dataclasses import dataclass
from typing import Callable, Optional, TypeVar

from .errors import ProviderError, classify_provider_exception

T = TypeVar("T")


@dataclass
class RetryPolicy:
    """How to retry a failing provider call.

    max_attempts : total tries including the first (1 = no retries).
    base_delay   : first backoff, seconds.
    max_delay    : cap on any single backoff, seconds.
    jitter       : full-jitter randomization (recommended on).
    on_retry     : optional callback(attempt, delay, error) for logging/telemetry.
    """
    max_attempts: int = 3
    base_delay: float = 0.5
    max_delay: float = 8.0
    jitter: bool = True
    on_retry: Optional[Callable[[int, float, ProviderError], None]] = None

    def __post_init__(self):
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        if self.base_delay < 0 or self.max_delay < 0:
            raise ValueError("delays must be non-negative")

    def delay_for(self, attempt: int) -> float:
        """Backoff before the given (1-based) retry attempt."""
        raw = min(self.max_delay, self.base_delay * (2 ** (attempt - 1)))
        if self.jitter:
            return random.uniform(0, raw)
        return raw


# a no-retry policy for callers who want to opt out
NO_RETRY = RetryPolicy(max_attempts=1)


def with_retry(fn: Callable[[], T], policy: RetryPolicy, *,
               provider: Optional[str] = None, sleep: Callable[[float], None] = time.sleep) -> T:
    """Call fn(), retrying on retryable provider errors per `policy`.

    `sleep` is injectable so tests can run without real delays. Non-retryable
    errors (auth, unknown) raise on the first occurrence. The last error is
    re-raised (as a typed ProviderError) once attempts are exhausted.
    """
    last: Optional[ProviderError] = None
    for attempt in range(1, policy.max_attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — we classify then decide
            err = classify_provider_exception(exc, provider=provider)
            last = err
            # not retryable, or out of attempts → raise the typed error
            if not err.retryable or attempt == policy.max_attempts:
                raise err
            delay = policy.delay_for(attempt)
            if policy.on_retry:
                policy.on_retry(attempt, delay, err)
            sleep(delay)
    # unreachable, but keeps type-checkers happy
    assert last is not None
    raise last
