#!/usr/bin/env bash
#
# preflight.sh — run every release gate that can be verified offline, in one shot.
#
# What it does NOT cover: the live `npm run dev` click-through (needs a browser)
# and live-cloud integration (Fly, Postgres server, real provider keys). Those
# are manual — see LAUNCH.md.
#
# Usage:   bash scripts/preflight.sh
# Exit:    0 = all gates passed, non-zero = at least one failed (see summary).

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Local esbuild (npm registry is often unreachable in CI/sandbox; this binary
# ships with the dev tooling). Override with ESBUILD=... if yours lives elsewhere.
ESBUILD="${ESBUILD:-/opt/npm-tools/node_modules/esbuild/bin/esbuild}"

PASS=0; FAIL=0; SKIP=0
declare -a RESULTS

step() {  # step "name" "command..."
  local name="$1"; shift
  printf '\n\033[1m── %s\033[0m\n' "$name"
  if "$@"; then
    RESULTS+=("PASS  $name"); PASS=$((PASS+1))
  else
    RESULTS+=("FAIL  $name"); FAIL=$((FAIL+1))
  fi
}
skip() { RESULTS+=("SKIP  $1 ($2)"); SKIP=$((SKIP+1)); printf '\n\033[2m── %s — skipped (%s)\033[0m\n' "$1" "$2"; }

# ── 1. Version consistency ────────────────────────────────────────────────
check_versions() {
  local py pkg init
  py=$(grep -oE '^version = "[^"]+"' sdk/pyproject.toml | grep -oE '[0-9][^"]+')
  pkg=$(grep -oE '"version": "[^"]+"' studio/package.json | grep -oE '[0-9][^"]+')
  init=$(grep -oE '__version__ = "[^"]+"' sdk/ergon/__init__.py | grep -oE '[0-9][^"]+')
  echo "  pyproject.toml : $py"
  echo "  package.json   : $pkg"
  echo "  __init__.py    : $init"
  if [ "$py" = "$pkg" ] && [ "$pkg" = "$init" ]; then
    # changelog must have a heading for this version
    if grep -q "## \[$py\]" CHANGELOG.md; then
      echo "  CHANGELOG      : [$py] present ✓"; return 0
    fi
    echo "  CHANGELOG      : no '## [$py]' heading"; return 1
  fi
  echo "  MISMATCH — all three must match"; return 1
}
step "Version consistency (SDK / Studio / __init__ / CHANGELOG)" check_versions

# ── 2. SDK test suite ─────────────────────────────────────────────────────
run_sdk_tests() { ( cd sdk && python3 -m tests._run_without_pytest ); }
if command -v python3 >/dev/null 2>&1; then
  step "SDK tests (python3 -m tests._run_without_pytest)" run_sdk_tests
else
  skip "SDK tests" "python3 not found"
fi

# ── 3. SDK import + byte-compile ──────────────────────────────────────────
run_sdk_compile() { ( cd sdk && python3 -c "import ergon; print('  ergon', ergon.__version__, 'imports OK')" && python3 -m compileall -q ergon ); }
if command -v python3 >/dev/null 2>&1; then
  step "SDK import + compileall" run_sdk_compile
else
  skip "SDK import + compileall" "python3 not found"
fi

# ── 4. Studio server syntax (node --check on every .mjs) ──────────────────
run_node_check() {
  local bad=0 f
  while IFS= read -r f; do
    if ! node --check "$f"; then echo "  SYNTAX ERROR: $f"; bad=1; fi
  done < <(find studio/server -name '*.mjs' ! -name '*.test.mjs' | sort)
  [ "$bad" -eq 0 ] && echo "  all server/*.mjs parse OK"
  return $bad
}
if command -v node >/dev/null 2>&1; then
  step "Studio server syntax (node --check server/*.mjs)" run_node_check
else
  skip "Studio server syntax" "node not found"
fi

# ── 5. Studio test suite ──────────────────────────────────────────────────
run_studio_tests() { ( cd studio && npm test ); }
if command -v node >/dev/null 2>&1 && [ -d studio/node_modules ]; then
  step "Studio tests (npm test)" run_studio_tests
elif command -v node >/dev/null 2>&1; then
  skip "Studio tests" "studio/node_modules missing — run: cd studio && npm install"
else
  skip "Studio tests" "node not found"
fi

# ── 6. React app compiles (esbuild) ───────────────────────────────────────
run_app_compile() {
  "$ESBUILD" studio/src/ErgonStudio.jsx --loader:.jsx=jsx --bundle \
    --external:react --external:react-dom --outfile=/dev/null
}
if [ -x "$ESBUILD" ]; then
  step "React app compiles (esbuild ErgonStudio.jsx)" run_app_compile
else
  skip "React app compile" "esbuild not at $ESBUILD (set ESBUILD=...)"
fi

# ── 7. Single-file artifact builds + compiles ─────────────────────────────
run_artifact_build() {
  ( cd studio && node scripts/build-artifact.mjs ) || return 1
  [ -f ergon-studio.jsx ] || { echo "  ergon-studio.jsx not produced"; return 1; }
  if [ -x "$ESBUILD" ]; then
    "$ESBUILD" ergon-studio.jsx --loader:.jsx=jsx --outfile=/dev/null \
      && echo "  artifact compiles ✓"
  else
    echo "  (built; esbuild unavailable to compile-check)"
  fi
}
if command -v node >/dev/null 2>&1; then
  step "Single-file artifact (build-artifact.mjs + compile)" run_artifact_build
else
  skip "Single-file artifact" "node not found"
fi

# ── 8. Secret-free working tree ───────────────────────────────────────────
# Flags private keys, .env with real values, and committed DBs. .env.example and
# docs are allowed. In a git checkout this scans only what would actually ship
# (tracked + untracked-but-not-ignored); otherwise it falls back to a filesystem
# walk that skips node_modules, .git, and the generated single-file artifact.
scan_secrets() {
  local hits=0 files
  if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "  (git checkout — scanning tracked + non-ignored files only)"
    files=$(git -C "$ROOT" ls-files --cached --others --exclude-standard)
  else
    echo "  (no git — filesystem walk, skipping node_modules/.git/generated)"
    files=$(find . \
        \( -path ./node_modules -o -path ./studio/node_modules -o -path './.git' \) -prune -o \
        -type f ! -name 'ergon-studio.jsx' -print 2>/dev/null | sed 's#^\./##')
  fi
  # stray env/key/db/settings files that should never ship
  local stray
  stray=$(printf '%s\n' "$files" | grep -E \
    '(^|/)\.env($|\.local$)|\.key$|\.pem$|\.db$|\.db-|\.sqlite$|\.sqlite3$|\.ergon-settings\.json' \
    | grep -vE '\.env\.example$' || true)
  if [ -n "$stray" ]; then echo "  ^ files that must not ship:"; echo "$stray" | sed 's/^/    /'; hits=1; fi
  # real key material inside shipping files
  local km
  km=$(printf '%s\n' "$files" | while IFS= read -r f; do
         [ -f "$f" ] && grep -lIE 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY' "$f" 2>/dev/null
       done | grep -vE 'LAUNCH\.md|preflight\.sh' || true)
  if [ -n "$km" ]; then echo "  ^ private key material in:"; echo "$km" | sed 's/^/    /'; hits=1; fi
  [ "$hits" -eq 0 ] && echo "  no private keys / stray env / db files"
  return $hits
}
step "Secret-free tree (keys / .env / *.db)" scan_secrets

# ── Summary ───────────────────────────────────────────────────────────────
printf '\n\033[1m════════ preflight summary ════════\033[0m\n'
for r in "${RESULTS[@]}"; do
  case "$r" in
    PASS*) printf '  \033[32m%s\033[0m\n' "$r" ;;
    FAIL*) printf '  \033[31m%s\033[0m\n' "$r" ;;
    *)     printf '  \033[2m%s\033[0m\n' "$r" ;;
  esac
done
printf '\n  %d passed · %d failed · %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] || { echo "Preflight FAILED — do not tag a release until green."; exit 1; }
if [ "$SKIP" -gt 0 ]; then
  echo "Preflight passed, but $SKIP gate(s) were skipped — install the missing tool and re-run for a full green."
fi
echo "Offline gates green. Finish the manual steps in LAUNCH.md before tagging."
