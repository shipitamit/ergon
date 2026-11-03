# Launch checklist — Ergon v0.7.0

Everything you need to go from this working tree to a tagged, public release.
Work top to bottom; nothing below is destructive until **Step 7 (tag & release)**.

The quick gates are automated — run them first and only read the manual sections
if something is red:

```bash
bash scripts/preflight.sh
```

Green means version/tests/compile/secret gates all pass. The one thing it
**cannot** do is click through the live UI — that is the manual runbook in
Step 4.

---

## 1. Repo hygiene

- [ ] Working tree is clean of local runtime files. The preflight secret gate
      flags these; they are all gitignored, so a fresh `git clone` is already
      clean. If you are releasing from *this* tree, confirm none are present:
      `studio/ergon.db*`, `studio/.ergon-settings.json*`, `*.key`, `*.pem`,
      `.env` (only `.env.example` ships).
- [ ] `node_modules/`, `dist/`, `.vite/`, `__pycache__/` are not tracked.
- [ ] `CHANGELOG.md` has a `## [0.7.0]` section and `## [Unreleased]` is empty.
- [ ] `README.md` Quick start still matches reality (SDK `pip install`, Studio
      `npm install` + `npm run dev`).

## 2. Version consistency (must all read 0.7.0)

Automated in preflight, but to eyeball:

```bash
grep '^version' sdk/pyproject.toml          # version = "0.7.0"
grep __version__ sdk/ergon/__init__.py      # __version__ = "0.7.0"
grep '"version"' studio/package.json        # "version": "0.7.0"
```

## 3. Tests & build — green on a real machine

The sandbox that produced this release cannot reach the npm registry, so the
**Studio test suite is the one gate that must be run locally** before tagging.

```bash
# SDK — no third-party deps needed for the offline suite
cd sdk && python3 -m tests._run_without_pytest     # expect: 231 passed
# (CI also runs the pytest path: pip install -e . && pytest)

# Studio — install dev deps first (fixes "concurrently: command not found")
cd ../studio && npm install
npm test                                            # full &&-chain, all suites
npm run build                                       # vite production build
```

- [ ] SDK suite passes.
- [ ] `npm test` passes end to end.
- [ ] `npm run build` completes with no errors.

## 4. `npm run dev` verification runbook (manual — the UI click-through)

This is the gate automation can't cover. Do it once per release on the built
UI. It exercises the v0.4.0–v0.7.0 surfaces that only exist at runtime.

**Start it** (two servers: Vite on 5173, API proxy on 8787):

```bash
cd studio
npm install            # if you haven't — dev deps include concurrently + vite
npm run dev
```

- Open **http://localhost:5173** — this is the app. (Port **8787** is the API
  proxy; hitting it directly in a browser is not the sign-in page — a common
  trip-up. Sign-in happens in the 5173 UI.)
- If you see `concurrently: command not found`, dev deps aren't installed — run
  `npm install` (not `npm ci --omit=dev`).
- If the page is blank and the console mentions esbuild, run
  `npm rebuild esbuild` (its postinstall can be blocked in locked-down shells),
  then restart.

**Click through** (each should open without a console error):

- [ ] **Sign in / create account.** Server-backed modals only appear when signed
      in — if the ⋯ More menu looks empty, you're signed out.
- [ ] **Canvas:** add an **Agent** node, a **Guardrail** node, and an
      **Approval** node (⌘K → add, or the node palette). Confirm each renders,
      is selectable, and the inspector shows its config fields.
- [ ] **Codegen:** export/preview Python for a flow containing the guardrail +
      approval nodes — it should emit `apply_guards(...)` and
      `ApprovalClient.from_env().request_and_wait(...)` without a syntax error.
- [ ] **Analytics modal** (⋯ More → Analytics): Metrics tab shows the bar chart,
      Search tab returns runs, Alerts tab lists rules, and the Channels section
      lets you add a webhook/Slack channel and **Test** it.
- [ ] **Hosting modal:** create a deployment (fake driver is the default),
      confirm it reaches a running state, then Stop/Remove and confirm the
      scoped API key is revoked on teardown.
- [ ] **Approvals modal:** a pending request appears, and Approve/Deny resolves
      it.
- [ ] **Evals modal:** create a dataset, add a case, **Run now**, and confirm a
      scored run + the compare view.
- [ ] No uncaught errors in the browser console across the above.

If anything here fails, it's a real bug — fix before tagging, not after.

## 5. Dependency / security note

- [ ] `npm audit` reports advisories **only** in the optional cloud-KMS trees
      (`@aws-sdk`, `@google-cloud/secret-manager`, `@azure/*`), which are
      `optionalDependencies` and not installed by default. The core runtime
      (react, vite, concurrency) is clean. Don't let `audit` noise from
      un-installed optionals block the release; do note them in release notes.
- [ ] `pip` install of the SDK pulls only `anthropic>=0.40` by default; extras
      (`otel`, `openai`, `gemini`, `bedrock`, `browser`, `mcp`, `rag`,
      `pgvector`) are opt-in.

## 6. Packaging the release artifact

The distributable zip excludes all dev/runtime cruft and is audited secret-free:

```bash
cd /home/claude/ergon
zip -r ergon-v0.7.0.zip . \
  -x '*/node_modules/*' '*/dist/*' '*/.vite/*' '*/__pycache__/*' '*.pyc' \
     '*/.git/*' '.env' '.env.local' '**/.env.local' \
     '*.key' '*.pem' '**/.ergon-settings.json*' \
     '*/sessions/*' '*/workspace/*' '*/backups/*' '*.log' \
     '*.db' '*.db-*' '*.sqlite*' './ergon-studio.jsx'
```

(`.env.example` is intentionally **kept** — the exclude list uses `.env` /
`.env.local`, not a broad `.env.*`, so the example template ships.)

- [ ] Unzip into a temp dir and re-run `bash scripts/preflight.sh` there to
      confirm the *shipped* tree is itself green and secret-free.

## 7. Git: tag & release (destructive — do last)

If the repo isn't initialized yet, this is also the first public commit. Use a
single release commit; the changelog is hand-maintained so a `feat:` subject
with the version as a parenthetical is correct (the commit contains the feature
code, so `chore:` would mislead release tooling):

```bash
git init                      # only if not already a repo
git add -A
git commit -m "feat: hardening & completion (v0.7.0)

Finishes the 0.6.0 trust/ops features: guardrail + approval canvas nodes,
alert delivery retry/routing/cooldown, metrics rollups, hosting liveness
reconcile, eval CI push + run-in-UI. SDK and Studio share version 0.7.0.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Fu3XpAer2qnYfJxs2nRyRV"

git tag -a v0.7.0 -m "Ergon v0.7.0 — hardening & completion"
git push origin main --follow-tags
gh release create v0.7.0 ergon-v0.7.0.zip \
  --title "Ergon v0.7.0" \
  --notes-file <(sed -n '/## \[0.7.0\]/,/## \[0.6.0\]/p' CHANGELOG.md | sed '$d')
```

- [ ] Tag `v0.7.0` pushed.
- [ ] GitHub release created with the zip attached and notes from the changelog.
- [ ] (If publishing to PyPI) `cd sdk && python -m build && twine upload dist/*`.

## 8. Post-launch

- [ ] CI is green on the pushed tag (`.github/workflows/sdk.yml`,
      `studio.yml`, `pg-it.yml`).
- [ ] Smoke-test the published artifact: `pip install ergon-ai` (or the wheel) in a
      clean venv, `python -c "import ergon; print(ergon.__version__)"`.
- [ ] Update `ergon-vs-market.xlsx` roadmap statuses if the release changed any.

---

## Known not-in-this-release (ship notes, not blockers)

These are honestly scoped as out of 0.7.0 and need live infrastructure to build
and validate — call them out in release notes rather than implying they're done:

- **Distributed exactly-once runtime** (single-node durability ships; multi-node
  coordination does not).
- **Managed hosting at depth:** autoscaling, multi-region, custom domains, real
  Fly log streaming, and live-Fly validation. The driver interface and the fake
  driver are complete; `FlyMachinesDriver` is wired but unproven against live Fly.
- **Alert email/SMTP delivery** (webhook + Slack ship; email does not).
- **CRDT real-time co-editing** and the **template marketplace** are future work.
