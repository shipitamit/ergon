"""Evaluation scorers and the evaluate() harness."""
import pytest

import tempfile

from ergon import (
    evaluate, exact_match, contains, not_contains, regex_match,
    json_valid, json_schema, numeric_close, compare_reports, load_report,
)


# ── individual scorers ──

def test_exact_match_normalized():
    s = exact_match()
    assert s("in", "  Hello World ", "hello world").passed
    assert not s("in", "hello", "goodbye").passed


def test_exact_match_strict():
    s = exact_match(normalize=False)
    assert not s("in", "Hello", "hello").passed
    assert s("in", "hello", "hello").passed


def test_contains():
    s = contains()
    assert s("in", "the answer is 42 today", "42").passed
    assert not s("in", "nothing here", "42").passed


def test_not_contains():
    s = not_contains("error")
    assert s("in", "all good", None).passed
    assert not s("in", "an error occurred", None).passed


def test_regex_match():
    s = regex_match(r"\d{3}-\d{4}")
    assert s("in", "call 555-1234", None).passed
    assert not s("in", "no number", None).passed


def test_json_valid():
    s = json_valid()
    assert s("in", '{"a": 1}', None).passed
    assert not s("in", "not json", None).passed


def test_json_valid_required_keys():
    s = json_valid(required_keys=["name", "id"])
    assert s("in", '{"name": "x", "id": 1}', None).passed
    assert not s("in", '{"name": "x"}', None).passed


def test_numeric_close():
    s = numeric_close(tolerance=0.1)
    assert s("in", "3.14", "3.10").passed
    assert not s("in", "3.14", "9.99").passed


# ── the evaluate() harness ──

def test_evaluate_over_callable():
    dataset = [
        {"input": "q1", "expected": "30 days"},
        {"input": "q2", "expected": "30 days"},
    ]
    report = evaluate(lambda i: "the limit is 30 days", dataset, scorers=[contains()])
    assert report.pass_rate == 1.0


def test_evaluate_partial_failure():
    dataset = [
        {"input": "a", "expected": "yes"},
        {"input": "b", "expected": "yes"},
    ]
    # returns "yes" only for input "a"
    report = evaluate(lambda i: "yes" if i == "a" else "no", dataset, scorers=[contains()])
    assert report.pass_rate == 0.5


def test_evaluate_report_serializes():
    report = evaluate(lambda i: "x", [{"input": "q", "expected": "x"}], scorers=[exact_match()])
    d = report.to_dict()
    assert "pass_rate" in d


def test_evaluate_multiple_scorers():
    dataset = [{"input": "q", "expected": "42"}]
    report = evaluate(lambda i: "42", dataset, scorers=[contains(), exact_match()])
    assert report.pass_rate == 1.0


# ── json_schema scorer ──

def test_json_schema_scorer():
    s = json_schema({"name": str, "age": "number", "tags": list})
    assert s("in", '{"name": "Al", "age": 30, "tags": []}', None).passed
    bad = s("in", '{"name": "Al", "age": "thirty"}', None)
    assert not bad.passed and "age" in bad.detail and "tags" in bad.detail
    assert not s("in", "not json", None).passed
    # fenced JSON is unwrapped
    assert s("in", '```json\n{"name":"x","age":1,"tags":[]}\n```', None).passed


# ── save / load / compare (the regression gate) ──

def _report(outputs, expected="42"):
    # outputs: list of model outputs; one case each, scored by contains(expected)
    data = [{"input": f"q{i}", "expected": expected} for i in range(len(outputs))]
    it = iter(outputs)
    return evaluate(lambda i: next(it), data, scorers=[contains()])


def test_save_and_load_report_roundtrip():
    rep = _report(["42", "nope"])
    path = tempfile.mktemp(suffix=".json")
    rep.save(path)
    loaded = load_report(path)
    assert loaded["n"] == 2
    assert loaded["pass_rate"] == 0.5


def test_compare_detects_regression_and_blocks_gate():
    baseline = _report(["42", "42"])        # both pass
    current = _report(["42", "nope"])        # second regressed
    diff = compare_reports(baseline, current)
    assert not diff.ok
    assert len(diff.regressed) == 1
    assert diff.regressed[0]["input"] == "q1"
    assert diff.pass_rate_delta < 0


def test_compare_allows_improvement_and_passes_gate():
    baseline = _report(["42", "nope"])       # one fails
    current = _report(["42", "42"])           # fixed
    diff = compare_reports(baseline, current)
    assert diff.ok
    assert len(diff.improved) == 1 and not diff.regressed


def test_compare_tolerance_governs_pass_rate_dip():
    # a new failing case drops the pass rate though no shared case regressed
    baseline = _report(["42", "42"])                      # 100%
    current = _report(["42", "42", "nope"])               # 66%, q0/q1 still pass
    strict = compare_reports(baseline, current)
    assert not strict.ok and not strict.regressed         # zero tolerance fails on the dip
    assert compare_reports(baseline, current, tolerance=0.5).ok   # tolerance absorbs it


def test_gate_cli_exit_codes(monkeypatch, tmp_path=None):
    import ergon.agent as agent_mod
    from ergon.providers import ModelResponse
    from .conftest import FakeProvider
    monkeypatch.setattr(agent_mod, "make_provider",
                        lambda *a, **k: FakeProvider([ModelResponse(text="42", stop="end",
                                                                    usage={"input_tokens": 1, "output_tokens": 1})]))
    import json as _json
    from ergon import run_eval
    graph = {"version": 2, "nodes": [
        {"id": "in", "type": "input", "config": {"message": ""}},
        {"id": "a", "type": "agent", "config": {"name": "s", "provider": "anthropic",
            "allowInternet": False, "todo": False, "memory": False, "otel": False}},
        {"id": "out", "type": "output", "config": {}}],
        "edges": [{"kind": "flow", "from": "in", "to": "a"}, {"kind": "flow", "from": "a", "to": "out"}]}
    hpath = tempfile.mktemp(suffix=".json"); open(hpath, "w").write(_json.dumps(graph))
    dpath = tempfile.mktemp(suffix=".jsonl"); open(dpath, "w").write(_json.dumps({"input": "q", "expected": "42"}) + "\n")
    base = tempfile.mktemp(suffix=".json")
    # save a baseline (all pass), then gate against it → exit 0
    assert run_eval.main([hpath, dpath, "--save", base]) == 0
    assert run_eval.main([hpath, dpath, "--gate", "--baseline", base]) == 0
    # --gate without --baseline is a usage error (exit 2)
    assert run_eval.main([hpath, dpath, "--gate"]) == 2
