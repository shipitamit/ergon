"""Unified `ergon` command-line entry: dispatch to a subcommand.

    ergon run   harness.json "task"     # one-shot (ergon.run)
    ergon serve harness.json --port …   # long-running HTTP endpoint (ergon.serve)
    ergon eval  …                        # evaluation (ergon.run_eval, if present)

Each subcommand is a thin module with its own main(argv); this just routes.
"""
import sys

_COMMANDS = {
    "run": "ergon.run",
    "serve": "ergon.serve",
    "eval": "ergon.run_eval",
    "bench": "ergon.benchmark",
}


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print("ergon <command> [args]\n\ncommands:\n"
              "  run    run a harness once and print the result\n"
              "  serve  serve a harness over HTTP (REST + SSE)\n"
              "  eval   run an evaluation over a harness/agent\n"
              "  bench  benchmark a harness (latency / throughput / cost)\n")
        return 0
    cmd, rest = argv[0], argv[1:]
    mod_name = _COMMANDS.get(cmd)
    if not mod_name:
        print(f"unknown command: {cmd!r} (try: {', '.join(_COMMANDS)})", file=sys.stderr)
        return 2
    import importlib
    try:
        mod = importlib.import_module(mod_name)
    except ModuleNotFoundError as e:
        print(f"command '{cmd}' is unavailable: {e}", file=sys.stderr)
        return 2
    return int(mod.main(rest) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
