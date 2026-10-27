# Benchmarks

A reproducible way to measure a harness's latency, throughput, token use, and
cost — and an honest reading of what the numbers mean.

## Running it

```bash
ergon bench harness.json --runs 50 --concurrency 4
ergon bench harness.json --runs 50 --json > bench.json   # machine-readable
```

It runs the harness `--runs` times (at `--concurrency` in parallel), times each
run, and reports p50/p95/mean/min/max latency, throughput (runs/sec), and total
+ per-run tokens and cost (summed from each run's usage record).

## What the numbers mean

The benchmark times the **whole harness, provider included**. So:

- Against a **real provider**, latency is end-to-end (network + model + tool
  loop). This is what your users feel — but it is dominated by the provider and
  varies run to run, so report a distribution (p50/p95), not a single number,
  and say which model and region.
- Against a **stub/fake provider**, latency is Ergon's **own overhead** — the
  flow walk, recording, and bookkeeping — with the model removed. Use this to
  catch overhead regressions, not to claim "X ms per request."

Cost comes from the editable price table (`Usage.cost()`); treat it as an
estimate and keep it current.

Concurrency uses one harness clone per worker (isolated session state), built
before timing. Clones don't carry custom-tool implementations — run
`--concurrency 1` to benchmark a harness with real Python tools.

## Sample: harness overhead (no model)

Measured with a stub provider so the model is removed — these are **Ergon
overhead**, not model latency, on a single modern core. Reproduce with the
stub-provider script in the benchmark test. Your absolute numbers will differ;
the point is the shape and that overhead stays sub-millisecond per run.

| Metric | concurrency 1 | concurrency 4 |
| --- | --- | --- |
| Throughput (runs/s) | ~4,000 | ~1,300 |
| Latency p50 (ms) | ~0.2 | ~2.9 |
| Latency p95 (ms) | ~0.4 | ~4.8 |
| Tokens / run | 165 | 165 |

Reading it: per-run overhead is a fraction of a millisecond, so against a real
provider (hundreds of ms to seconds per call) Ergon's own cost is in the noise.
Throughput *drops* with concurrency here because, with the model stubbed, there
is no I/O wait to overlap — the thread-pool coordination is pure overhead. With
a **real** provider the opposite holds: concurrency overlaps provider latency
and throughput rises until you hit the provider's rate limit or your per-org
budget.

## Methodology notes

- Warm up before measuring if you care about steady-state (the first run pays
  import/connection costs).
- Pin the model and region; record them with the numbers.
- Run enough iterations for stable percentiles (50+).
- For cost, verify the price table matches current provider pricing.
- Publish the raw `--json` alongside any summary so others can check it.
