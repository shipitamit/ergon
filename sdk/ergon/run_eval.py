"""Evaluate a Studio harness (or any callable) against a dataset, with an
optional regression gate for CI:

    python -m ergon.run_eval harness.json dataset.jsonl
    python -m ergon.run_eval harness.json dataset.jsonl --exact
    python -m ergon.run_eval harness.json dataset.jsonl --save baseline.json
    python -m ergon.run_eval harness.json dataset.jsonl --gate --baseline baseline.json
    # (or via the console entry: `ergon eval harness.json dataset.jsonl --gate --baseline b.json`)

Dataset is JSON or JSONL with rows: {"input": "...", "expected": "..."}.
Default scorer is `contains`; pass --exact for exact match.

Exit codes:
  0  all cases passed (no --gate), or the gate passed
  1  some cases failed (no --gate), or the gate found a regression

--gate compares this run to --baseline (a report saved with --save) and fails
on any case that passed in the baseline but fails now, or a pass-rate drop
beyond --tolerance (default 0.0). --save writes the current run as a baseline.
Custom tools in a harness export as stubs — supply real ones in Python via
evaluate(load_harness(..., tools={...}), ...) for tool-dependent evals.
"""
import sys

from .eval import evaluate, contains, exact_match, compare_reports, load_report
from .harness import load_harness


def _flag_value(argv, name, default=None):
    if name in argv:
        i = argv.index(name)
        if i + 1 < len(argv):
            return argv[i + 1]
    return default


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) < 2 or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    harness_path, dataset_path = argv[0], argv[1]
    scorer = exact_match() if "--exact" in argv else contains()
    save_path = _flag_value(argv, "--save")
    baseline_path = _flag_value(argv, "--baseline")
    gate = "--gate" in argv
    try:
        tolerance = float(_flag_value(argv, "--tolerance", "0.0"))
    except ValueError:
        tolerance = 0.0

    harness = load_harness(harness_path)
    report = evaluate(harness, dataset_path, scorers=[scorer])
    print(report)
    print("\n" + "─" * 60)
    print(f"pass_rate={report.pass_rate:.1%}  mean_score={report.mean_score:.2f}  {report.usage}")

    if save_path:
        report.save(save_path)
        print(f"saved baseline → {save_path}")

    if gate:
        if not baseline_path:
            print("\n--gate requires --baseline <report.json>", file=sys.stderr)
            return 2
        diff = compare_reports(load_report(baseline_path), report, tolerance=tolerance)
        print("\n" + str(diff))
        return 0 if diff.ok else 1

    return 0 if report.pass_rate == 1.0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
