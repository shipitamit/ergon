"""Token & cost accounting.

Providers return per-call token usage; the Agent aggregates it into a Usage
object on every AgentResult. Costs are estimated from a small, editable price
table (USD per million tokens). Prices drift — treat these as estimates and
override with set_prices() or a custom Usage.cost() if you need precision.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

# USD per 1M tokens: model-substring -> (input, output).
# Matched by longest substring so "claude-3-5-sonnet" beats "claude".
_PRICES: Dict[str, Tuple[float, float]] = {
    # Anthropic
    "claude-opus-4": (15.0, 75.0),
    "claude-sonnet-4": (3.0, 15.0),
    "claude-3-5-sonnet": (3.0, 15.0),
    "claude-3-5-haiku": (0.80, 4.0),
    "claude-3-opus": (15.0, 75.0),
    "claude-3-haiku": (0.25, 1.25),
    "claude": (3.0, 15.0),
    # OpenAI
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o": (2.50, 10.0),
    "gpt-4.1": (2.0, 8.0),
    "o3": (2.0, 8.0),
    "gpt-4": (30.0, 60.0),
    "gpt-3.5": (0.50, 1.50),
    # Google
    "gemini-2.0-flash": (0.10, 0.40),
    "gemini-1.5-pro": (1.25, 5.0),
    "gemini-1.5-flash": (0.075, 0.30),
    "gemini": (0.10, 0.40),
    # Bedrock (varies by base model; these track the Anthropic-on-Bedrock list)
    "anthropic.claude-3-5-sonnet": (3.0, 15.0),
    "anthropic.claude-3-haiku": (0.25, 1.25),
    "meta.llama": (0.65, 0.65),
    "mistral": (0.70, 0.70),
    "amazon.nova-pro": (0.80, 3.20),
    "amazon.nova-lite": (0.06, 0.24),
}


def set_prices(prices: Dict[str, Tuple[float, float]]) -> None:
    """Merge/override entries in the price table (USD per 1M tokens)."""
    _PRICES.update(prices)


def price_for(model: str) -> Optional[Tuple[float, float]]:
    m = (model or "").lower()
    best, best_len = None, -1
    for key, val in _PRICES.items():
        if key in m and len(key) > best_len:
            best, best_len = val, len(key)
    return best


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    calls: int = 0
    # per-model breakdown: model -> (input, output, calls)
    by_model: Dict[str, Tuple[int, int, int]] = field(default_factory=dict)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def add(self, model: str, input_tokens: int, output_tokens: int) -> None:
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.calls += 1
        pi, po, pc = self.by_model.get(model, (0, 0, 0))
        self.by_model[model] = (pi + input_tokens, po + output_tokens, pc + 1)

    def merge(self, other: "Usage") -> None:
        """Fold a sub-agent/peer's usage into this one."""
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.calls += other.calls
        for model, (i, o, c) in other.by_model.items():
            pi, po, pc = self.by_model.get(model, (0, 0, 0))
            self.by_model[model] = (pi + i, po + o, pc + c)

    def cost(self) -> float:
        """Estimated USD across all models used. Unknown models count as 0."""
        total = 0.0
        for model, (i, o, _c) in self.by_model.items():
            p = price_for(model)
            if p:
                total += i / 1e6 * p[0] + o / 1e6 * p[1]
        return round(total, 6)

    def __str__(self) -> str:
        return (f"{self.total_tokens:,} tokens ({self.input_tokens:,} in / "
                f"{self.output_tokens:,} out) over {self.calls} calls · ~${self.cost():.4f}")

    def as_dict(self) -> Dict[str, Any]:
        """JSON-serializable snapshot (for the serving API, run records, etc.)."""
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "calls": self.calls,
            "cost": self.cost(),
            "by_model": {m: {"input": i, "output": o, "calls": c}
                         for m, (i, o, c) in self.by_model.items()},
        }
