"""Run an Ergon Studio harness from the command line:

    python -m ergon.run harness.json "Your task here"
    python -m ergon.run harness.json          # uses the Input node's message

Custom tools export as stubs (their bodies don't cross from the app); for real
tool implementations, import load_harness in Python and pass tools={...}.
"""
import sys

from .harness import load_harness


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    path = argv[0]
    task = argv[1] if len(argv) > 1 else None
    harness = load_harness(path)
    result = harness.run(task)
    print(result.text)
    print("\n---", result.usage, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
