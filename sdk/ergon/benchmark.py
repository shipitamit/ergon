"""Benchmark a harness — latency, throughput, tokens, and cost.

    ergon bench harness.json --runs 50 --concurrency 4
    # or: python -m ergon.benchmark harness.json --runs 50

Runs the harness `runs` times (at `concurrency` in parallel), timing each run
and summing token/cost usage from the run record. Reports p50/p95/mean latency,
throughput (runs/sec), and total + per-run tokens and cost.

Measures the whole harness, provider included — so against a real provider it
reflects end-to-end latency, and against a stub/fake it reflects Ergon's own
overhead. Label your numbers accordingly (see docs/benchmarks.md).
"""
from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional


def _percentile(sorted_vals: List[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = k - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def summarize(latencies_ms: List[float], usages: List[Dict[str, Any]], wall_s: float) -> Dict[str, Any]:
    """Pure aggregation — latency percentiles, throughput, token & cost totals."""
    n = len(latencies_ms)
    s = sorted(latencies_ms)
    tok_in = sum(u.get("input_tokens", 0) for u in usages)
    tok_out = sum(u.get("output_tokens", 0) for u in usages)
    cost = sum(u.get("cost", 0.0) for u in usages)
    return {
        "runs": n,
        "wall_s": round(wall_s, 4),
        "throughput_rps": round(n / wall_s, 3) if wall_s > 0 else 0.0,
        "latency_ms": {
            "p50": round(_percentile(s, 0.50), 2),
            "p95": round(_percentile(s, 0.95), 2),
            "mean": round(sum(s) / n, 2) if n else 0.0,
            "min": round(s[0], 2) if s else 0.0,
            "max": round(s[-1], 2) if s else 0.0,
        },
        "tokens": {"input": tok_in, "output": tok_out, "total": tok_in + tok_out,
                   "per_run": round((tok_in + tok_out) / n, 1) if n else 0.0},
        "cost": {"total": round(cost, 6), "per_run": round(cost / n, 6) if n else 0.0},
    }


def run_benchmark(harness, inputs: List[str], *, concurrency: int = 1,
                  name: Optional[str] = None) -> Dict[str, Any]:
    """Run `inputs` through `harness` (a loaded Harness) and summarize.

    Sequentially (concurrency=1) the harness is used as-is, with whatever tools
    it was loaded with. For concurrency > 1, one harness clone per worker is
    built from the graph under its own session directory — so parallel runs
    never collide on session state. (Clones carry no custom-tool implementations
    — those become stubs; run concurrency=1 to benchmark real tools.) Clone
    construction happens before timing, so it isn't counted in latency.
    """
    import queue
    import tempfile
    from .harness import load_harness
    from .runs import run_and_record

    latencies: List[float] = [0.0] * len(inputs)
    usages: List[Dict[str, Any]] = [{}] * len(inputs)
    errors = 0

    workers = max(1, concurrency)
    pool_q: "queue.Queue" = queue.Queue()
    if workers == 1:
        pool_q.put(harness)
    else:
        base = tempfile.mkdtemp(prefix="ergon-bench-")
        for w in range(workers):
            pool_q.put(load_harness(harness.graph, session_root=f"{base}/w{w}"))

    def one(i_task):
        i, task = i_task
        hh = pool_q.get()
        t0 = time.perf_counter()
        try:
            rec, _ = run_and_record(hh, task, name=name)
            usages[i] = rec.usage or {}
            latencies[i] = (time.perf_counter() - t0) * 1000.0
            return rec.status
        except Exception:
            latencies[i] = (time.perf_counter() - t0) * 1000.0
            return "error"
        finally:
            pool_q.put(hh)

    wall0 = time.perf_counter()
    if workers > 1:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for status in pool.map(one, list(enumerate(inputs))):
                if status == "error":
                    errors += 1
    else:
        for it in enumerate(inputs):
            if one(it) == "error":
                errors += 1
    wall = time.perf_counter() - wall0

    summary = summarize(latencies, usages, wall)
    summary["errors"] = errors
    summary["concurrency"] = concurrency
    return summary


def _format(summary: Dict[str, Any]) -> str:
    lat, tok, cost = summary["latency_ms"], summary["tokens"], summary["cost"]
    return (
        f"runs={summary['runs']} · concurrency={summary['concurrency']} · "
        f"errors={summary['errors']}\n"
        f"throughput  {summary['throughput_rps']} runs/s  (wall {summary['wall_s']}s)\n"
        f"latency ms  p50 {lat['p50']}  p95 {lat['p95']}  mean {lat['mean']}  "
        f"min {lat['min']}  max {lat['max']}\n"
        f"tokens      {tok['total']} total  ({tok['per_run']}/run)\n"
        f"cost        ${cost['total']}  (${cost['per_run']}/run)"
    )


def main(argv=None) -> int:
    import argparse
    from .harness import load_harness

    p = argparse.ArgumentParser(prog="ergon bench", description="Benchmark a harness.")
    p.add_argument("harness", help="path to the harness JSON")
    p.add_argument("--input", default="Hello", help="the input sent on every run")
    p.add_argument("--runs", type=int, default=20)
    p.add_argument("--concurrency", type=int, default=1)
    p.add_argument("--json", action="store_true", help="print the summary as JSON")
    args = p.parse_args(argv)

    harness = load_harness(args.harness)
    inputs = [args.input] * max(1, args.runs)
    summary = run_benchmark(harness, inputs, concurrency=max(1, args.concurrency))
    print(json.dumps(summary, indent=2) if args.json else _format(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
