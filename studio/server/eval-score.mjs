/* Eval scoring — deterministic scorers mirroring the SDK's (ergon/eval.py), so a
   dataset scored in CI and one scored here agree. A scorer is `{type, ...opts}`
   on a case; scoreCase returns {name, passed, score (0..1), detail}. Pure and
   dependency-free → unit-tested offline. */

function norm(s) { return String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " "); }
function firstNumber(s) { const m = String(s).match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; }

export function scoreCase(output, expected, scorer = {}) {
  const type = scorer.type || "contains";
  const out = output == null ? "" : String(output);
  const exp = expected;
  const ok = (passed, score, detail = "") => ({ name: type, passed: !!passed, score: passed ? (score == null ? 1 : score) : (score == null ? 0 : score), detail });

  switch (type) {
    case "exact": {
      const normalize = scorer.normalize !== false;
      const a = normalize ? norm(out) : out, b = normalize ? norm(exp) : String(exp);
      return ok(a === b, a === b ? 1 : 0, a === b ? "" : "not an exact match");
    }
    case "contains": {
      const cs = !!scorer.caseSensitive;
      const hay = cs ? out : out.toLowerCase();
      const needle = cs ? String(exp) : String(exp).toLowerCase();
      const hit = hay.includes(needle);
      return ok(hit, hit ? 1 : 0, hit ? "" : `missing ${JSON.stringify(exp)}`);
    }
    case "not_contains": {
      const cs = !!scorer.caseSensitive;
      const list = Array.isArray(exp) ? exp : [exp];
      const hay = cs ? out : out.toLowerCase();
      const bad = list.find((x) => hay.includes(cs ? String(x) : String(x).toLowerCase()));
      return ok(!bad, bad ? 0 : 1, bad ? `contains forbidden ${JSON.stringify(bad)}` : "");
    }
    case "regex": {
      let re;
      try { re = new RegExp(scorer.pattern != null ? scorer.pattern : String(exp), scorer.flags || ""); }
      catch (e) { return ok(false, 0, `bad regex: ${e.message}`); }
      const hit = re.test(out);
      return ok(hit, hit ? 1 : 0, hit ? "" : "no regex match");
    }
    case "numeric": {
      const got = firstNumber(out), want = typeof exp === "number" ? exp : firstNumber(exp);
      if (got == null || want == null) return ok(false, 0, "no number found");
      const tol = scorer.tolerance != null ? scorer.tolerance : 1e-6;
      const diff = Math.abs(got - want);
      const within = scorer.relative ? diff <= tol * Math.abs(want) : diff <= tol;
      return ok(within, within ? 1 : 0, within ? "" : `|${got} - ${want}| = ${diff}`);
    }
    case "json_valid": {
      let data;
      try { data = JSON.parse(out); } catch (e) { return ok(false, 0, `invalid JSON: ${e.message}`); }
      const req = scorer.requiredKeys || (exp && exp.requiredKeys) || [];
      if (req.length && (!data || typeof data !== "object")) return ok(false, 0.5, "not an object");
      const missing = req.filter((k) => !(data && Object.prototype.hasOwnProperty.call(data, k)));
      if (missing.length) return ok(false, 0.5, `missing keys ${missing.join(", ")}`);
      return ok(true, 1, "");
    }
    default:
      return ok(false, 0, `unknown scorer type: ${type}`);
  }
}

// Score a list of cases: each {input, output, expected, scorer}. Returns
// per-case results + aggregate {total, passed, passRate, scoreAvg}.
export function scoreDataset(cases = []) {
  const results = (cases || []).map((c) => {
    const s = scoreCase(c.output, c.expected, c.scorer || {});
    return { input: c.input, output: c.output, expected: c.expected,
             scorer: (c.scorer && c.scorer.type) || "contains",
             passed: s.passed, score: s.score, detail: s.detail };
  });
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const scoreAvg = total ? results.reduce((a, r) => a + (r.score || 0), 0) / total : 0;
  return { results, total, passed, passRate: total ? passed / total : 0, scoreAvg };
}
