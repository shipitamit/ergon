#!/usr/bin/env bash
# Ergon — single entry point. Sets up both halves (Python SDK + Node Studio) and
# runs the app. One command:
#
#   ./scripts/bootstrap.sh                 # set up (if needed) + start the Studio (dev)
#   ./scripts/bootstrap.sh dev             #   …the same, explicitly
#   ./scripts/bootstrap.sh docker          # production stack (app + Postgres + Valkey)
#   ./scripts/bootstrap.sh serve <harness> # serve one harness as an HTTP endpoint
#   ./scripts/bootstrap.sh test            # run both test suites
#   ./scripts/bootstrap.sh setup           # install deps only, don't start anything
#   ./scripts/bootstrap.sh help
#
# Reads a .env file at the repo root if present. Providers: set ANTHROPIC_API_KEY,
# or an OpenAI-compatible endpoint via OPENAI_API_KEY + OPENAI_BASE_URL (NVIDIA,
# Groq, Together, Mistral, Ollama, …).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

say()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
ok()   { printf "\033[1;32m✓ %s\033[0m\n" "$1"; }
warn() { printf "\033[1;33m!  %s\033[0m\n" "$1"; }
die()  { printf "\033[1;31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

# Load .env (repo root) so provider keys are available to whatever we start.
load_env() {
  if [ -f "$root/.env" ]; then
    set -a; # shellcheck disable=SC1091
    . "$root/.env"; set +a
    ok "loaded .env"
  fi
}

check_keys() {
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    warn "No provider key set. Export ANTHROPIC_API_KEY, or OPENAI_API_KEY + OPENAI_BASE_URL"
    warn "  (NVIDIA: OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1). The app starts; runs will 401 until one is set."
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

setup_sdk() {
  have python3 || { warn "python3 not found — skipping SDK (install Python ≥3.9)"; return; }
  if python3 -c "import ergon" >/dev/null 2>&1 && [ "${FORCE:-0}" != "1" ]; then
    ok "SDK already importable (ergon)"
  else
    say "Installing the SDK (Python)…"
    python3 -m pip install -e ./sdk >/dev/null && ok "SDK installed (editable)"
  fi
}

setup_studio() {
  have npm || die "npm not found — install Node ≥18 to run the Studio"
  if [ -d studio/node_modules ] && [ "${FORCE:-0}" != "1" ]; then
    ok "Studio deps already installed"
  else
    say "Installing the Studio (Node)…"
    npm --prefix studio install >/dev/null && ok "Studio deps installed"
  fi
}

cmd_setup() { load_env; setup_sdk; setup_studio; ok "Setup complete."; }

cmd_dev() {
  load_env; setup_sdk; setup_studio; check_keys
  say "Starting the Studio (proxy :8787 + Vite UI :5173)…"
  echo "  Open http://localhost:5173  ·  Ctrl-C to stop"
  exec npm --prefix studio run dev
}

cmd_docker() {
  have docker || die "docker not found — install Docker to use the production stack"
  if [ ! -f "$root/.env" ]; then
    cp "$root/.env.example" "$root/.env"
    warn "Created .env from .env.example — set ANTHROPIC_API_KEY (or OPENAI_API_KEY + OPENAI_BASE_URL) and SESSION_SECRET, then re-run."
    exit 1
  fi
  say "Starting the production stack (app + Postgres/pgvector + Valkey)…"
  echo "  App on http://localhost:8787  ·  migrations run automatically"
  exec docker compose up --build
}

cmd_serve() {
  local harness="${1:-}"
  [ -n "$harness" ] || die "usage: ./scripts/bootstrap.sh serve <harness.json> [--port N]"
  load_env; setup_sdk; check_keys
  shift || true
  say "Serving $harness (REST + SSE)…"
  exec python3 -m ergon.serve "$harness" "$@"
}

cmd_test() {
  load_env
  say "SDK tests…"
  ( cd sdk && PYTHONPATH=. python3 tests/_run_without_pytest.py )
  say "Studio tests…"
  npm --prefix studio test
  ok "All tests passed."
}

# print the header comment block (lines after the shebang, up to the first non-# line)
usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next}{exit}' "${BASH_SOURCE[0]}"; }

# ── dispatch (default: dev) ──
for a in "$@"; do [ "$a" = "--force" ] && FORCE=1; done
cmd="${1:-dev}"; [ "${cmd#-}" = "$cmd" ] || cmd="dev"   # a bare --force still means dev
case "$cmd" in
  dev)    cmd_dev ;;
  setup)  cmd_setup ;;
  docker) cmd_docker ;;
  serve)  shift; cmd_serve "$@" ;;
  test)   cmd_test ;;
  help|-h|--help) usage ;;
  *) die "unknown command: $cmd (try: dev | docker | serve | test | setup | help)" ;;
esac
