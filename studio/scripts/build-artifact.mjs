/* Build the single-file Claude artifact from the app source.

   The standalone app is multi-file (imports ./storage and ./codegen); the Claude
   artifact must be ONE self-contained file. This inlines those modules and swaps
   the transport/storage for the artifact environment. Run:

     node studio/scripts/build-artifact.mjs   # writes ../ergon-studio.jsx
*/
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
let src = readFileSync(join(srcDir, "ErgonStudio.jsx"), "utf8");

// 1) inline codegen.js (strip its export keywords → plain top-level decls)
const codegen = readFileSync(join(srcDir, "codegen.js"), "utf8")
  .replace(/export function /g, "function ")
  .replace("export { py, pyDict };", "");
src = src.replace(
  'import { genPython, genDeploy, validateGraph, preflight, graphIsAdvanced, diffGraphs, py, pyDict, parseConditions } from "./codegen.js";\n',
  "/* ── codegen (inlined for the single-file artifact) ── */\n" + codegen + "\n/* ── end codegen ── */\n");

// 2) inline storage + collaboration stubs
src = src.replace('import { storage, useServerStorage, storageKind, auth, cloud } from "./storage";\n', "");
const stubs = `
/* ── storage + collaboration (artifact build) ── */
const storage = {
  get: (...a) => window.storage.get(...a),
  set: (...a) => window.storage.set(...a),
  delete: (...a) => window.storage.delete(...a),
  list: (...a) => window.storage.list(...a),
};
const useServerStorage = () => {};
const storageKind = () => "artifact";
const auth = { available: false, me: async () => null, signup: async () => {}, login: async () => {}, logout: async () => {}, providers: async () => ({ password: true, sso: false }), ssoLogin: () => {} };
const cloud = { list: async () => [], get: async () => ({}), save: async () => ({}), remove: async () => {}, orgs: async () => [], createOrg: async () => ({}), members: async () => [], addMember: async () => [], removeMember: async () => [], setHarnessOrg: async () => ({}), audit: async () => [], keys: async () => [], createKey: async () => ({}), revokeKey: async () => ({}), recordRun: async () => null, runs: async () => [], getRun: async () => ({}), metrics: async () => ({ totals: {}, series: [], byHarness: [] }), searchRuns: async () => [], alerts: async () => [], createAlert: async () => ({}), updateAlert: async () => ({}), deleteAlert: async () => ({}), alertEvents: async () => [], evaluateAlerts: async () => [], alertChannels: async () => [], createAlertChannel: async () => ({}), updateAlertChannel: async () => ({}), deleteAlertChannel: async () => ({}), testAlertChannel: async () => ({}), approvals: async () => [], decideApproval: async () => ({}), evalDatasets: async () => [], evalDataset: async () => ({}), createEvalDataset: async () => ({}), updateEvalDataset: async () => ({}), deleteEvalDataset: async () => ({}), evalRuns: async () => [], evalRun: async () => ({}), recordEvalRun: async () => ({}), compareEvalRuns: async () => ({}), budgets: async () => [], budgetStatus: async () => [], setBudget: async () => [], deleteBudget: async () => ({}), deployments: async () => [], createDeployment: async () => ({}), deleteDeployment: async () => ({}), runners: async () => [], provisionRunner: async () => ({}), runner: async () => ({}), stopRunner: async () => ({}), restartRunner: async () => ({}), refreshRunner: async () => ({}), runnerLogs: async () => [], deleteRunner: async () => ({}), exportOrg: async () => ({}), comments: async () => [], addComment: async () => ({}), resolveComment: async () => ({}), deleteComment: async () => ({}), presence: async () => [], versions: async () => [], version: async () => ({}), triggers: async () => [], createTrigger: async () => ({}), updateTrigger: async () => ({}), deleteTrigger: async () => ({}), webhookUrl: () => "", connectors: async () => [], connections: async () => [], createConnection: async () => ({}), updateConnection: async () => ({}), deleteConnection: async () => ({}), oauthStart: async () => "" };
`;
src = src.replace(
  'import React, { useState, useRef, useEffect, useCallback } from "react";',
  'import React, { useState, useRef, useEffect, useCallback } from "react";' + stubs);

// 3) swap transport for the artifact (direct Anthropic call)
const ts = src.indexOf("/* ── transport (environment-specific");
const te = src.indexOf("/* ── end transport ── */") + "/* ── end transport ── */".length;
src = src.slice(0, ts) + `/* ── transport (environment-specific) ── */
const IN_CLAUDE_ARTIFACT = true;
async function postModel(provider, payload) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(\`API error \${res.status}\`);
  return res.json();
}
/* ── end transport ── */` + src.slice(te);

writeFileSync(join(here, "..", "..", "ergon-studio.jsx"), src);
console.log("built ergon-studio.jsx (single-file artifact, codegen + storage inlined)");
