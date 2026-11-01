"""Minimal test runner for environments without pytest installed.

This is a *verification helper only* — real CI uses pytest. It implements just
enough of pytest's API (fixtures, parametrize, raises, monkeypatch) to execute
the same test files unchanged, so the suite can be proven green here.
"""
import sys
import os
import types
import inspect
import importlib
import traceback
import contextlib

_UNSET = object()


# ── a fake `pytest` module implementing the bits our tests use ──
class _Raises:
    def __init__(self, exc):
        self.exc = exc

    def __enter__(self):
        return self

    def __exit__(self, et, ev, tb):
        if et is None:
            raise AssertionError(f"DID NOT RAISE {self.exc.__name__}")
        return issubclass(et, self.exc)


class _MonkeyPatch:
    def __init__(self):
        self._undo = []
        self._env = []

    def setattr(self, target, name=_UNSET, value=_UNSET):
        # pytest's two forms: setattr("pkg.mod.attr", value) or setattr(obj, "name", value)
        if isinstance(target, str) and value is _UNSET:
            value = name
            modpath, _, attr = target.rpartition(".")
            target = importlib.import_module(modpath)
            name = attr
        old = getattr(target, name)
        self._undo.append((target, name, old))
        setattr(target, name, value)

    def setenv(self, name, value):
        self._env.append((name, os.environ.get(name, _UNSET)))
        os.environ[name] = str(value)

    def delenv(self, name, raising=True):
        self._env.append((name, os.environ.get(name, _UNSET)))
        if name in os.environ:
            del os.environ[name]
        elif raising:
            raise KeyError(name)

    def undo(self):
        for target, name, old in reversed(self._undo):
            setattr(target, name, old)
        self._undo = []
        for name, old in reversed(self._env):
            if old is _UNSET:
                os.environ.pop(name, None)
            else:
                os.environ[name] = old
        self._env = []


_FIXTURES = {}


def fixture(func):
    _FIXTURES[func.__name__] = func
    return func


def raises(exc):
    return _Raises(exc)


class _Mark:
    @staticmethod
    def parametrize(argname, values):
        def deco(func):
            func._parametrize = (argname, values)
            return func
        return func if False else deco


def _make_pytest_module():
    m = types.ModuleType("pytest")
    m.fixture = fixture
    m.raises = raises
    m.mark = _Mark()
    sys.modules["pytest"] = m
    return m


def _resolve_fixtures(func, monkeypatch):
    """Build kwargs by resolving fixture names from the signature."""
    kwargs = {}
    cache = {}

    def resolve(name):
        if name in cache:
            return cache[name]
        if name == "monkeypatch":
            cache[name] = monkeypatch
            return monkeypatch
        if name not in _FIXTURES:
            raise KeyError(f"unknown fixture: {name}")
        fx = _FIXTURES[name]
        sub = {p: resolve(p) for p in inspect.signature(fx).parameters
               if p != "self"}
        val = fx(**sub)
        cache[name] = val
        return val

    for p in inspect.signature(func).parameters:
        if p == "monkeypatch":
            kwargs[p] = monkeypatch
        elif p in _FIXTURES:
            kwargs[p] = resolve(p)
    return kwargs, cache


def run_module(mod):
    passed = failed = 0
    failures = []
    tests = [(n, f) for n, f in vars(mod).items()
             if n.startswith("test_") and callable(f)]
    for name, func in tests:
        param = getattr(func, "_parametrize", None)
        cases = []
        if param:
            argname, values = param
            cases = [(v,) for v in values]
        else:
            cases = [None]
        for case in cases:
            mp = _MonkeyPatch()
            label = f"{mod.__name__}::{name}"
            try:
                kwargs, _ = _resolve_fixtures(func, mp)
                if case is not None:
                    argname = param[0]
                    kwargs[argname] = case[0]
                    label += f"[{case[0]}]"
                func(**kwargs)
                passed += 1
            except Exception as e:
                failed += 1
                failures.append((label, traceback.format_exc()))
            finally:
                mp.undo()
    return passed, failed, failures


def main():
    import importlib
    _make_pytest_module()
    # ensure conftest fixtures are registered
    from tests import conftest  # noqa
    for fn in ("session_dir", "make_agent", "resp", "tool_call"):
        if hasattr(conftest, fn):
            fixture(getattr(conftest, fn))

    modules = [
        "tests.test_agent_loop",
        "tests.test_approval_and_budgets",
        "tests.test_streaming_cancel",
        "tests.test_eval",
        "tests.test_flows_compaction_security",
        "tests.test_harness_bridge",
        "tests.test_serve",
        "tests.test_runs",
        "tests.test_benchmark",
        "tests.test_retry_and_errors",
        "tests.test_mcp",
        "tests.test_rag",
        "tests.test_rag_adapters",
        "tests.test_guardrails",
        "tests.test_approval_inbox",
        "tests.test_router",
        "tests.test_flows_control",
        "tests.test_checkpoints",
        "tests.test_connections",
        "tests.test_durable",
    ]
    total_p = total_f = 0
    all_failures = []
    for modname in modules:
        mod = importlib.import_module(modname)
        p, f, fails = run_module(mod)
        total_p += p
        total_f += f
        all_failures += fails
        print(f"  {modname}: {p} passed, {f} failed")

    print(f"\nTOTAL: {total_p} passed, {total_f} failed")
    for label, tb in all_failures:
        print(f"\n--- FAILED {label} ---\n{tb}")
    return 0 if total_f == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
