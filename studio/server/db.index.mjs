/* Data-layer selector.

   routes.mjs imports the persistence layer from here. We choose the backend at
   startup from the environment:

     DATABASE_URL=postgres://…   → Postgres backend (db.postgres.mjs), for
                                    real multi-instance deployment
     (unset)                     → SQLite backend (db.mjs), the zero-dependency
                                    single-instance default

   Both backends export the same function names. The SQLite functions are
   synchronous and the Postgres ones are async, but routes.mjs `await`s every
   call — and `await` on a synchronous return value is a harmless no-op — so a
   single set of route handlers works against either backend.

   If DATABASE_URL is set but `pg` isn't installed (or init fails), we log and
   fall back to SQLite so the server still starts.
*/
let backend;
let backendName;

const url = process.env.DATABASE_URL;
if (url && /^postgres(ql)?:\/\//.test(url)) {
  try {
    backend = await import("./db.postgres.mjs");
    await backend.init(url);
    backendName = "postgres";
  } catch (e) {
    console.warn(`[db] Postgres requested but unavailable (${e.message}); falling back to SQLite.`);
    backend = await import("./db.mjs");
    backendName = "sqlite";
  }
} else {
  backend = await import("./db.mjs");
  backendName = "sqlite";
}

export const dbBackend = backendName;

// re-export the shared interface (works for both sync and async backends)
export const createUser = (...a) => backend.createUser(...a);
export const verifyUser = (...a) => backend.verifyUser(...a);
export const findOrCreateUserByOidc = (...a) => backend.findOrCreateUserByOidc(...a);
export const createSession = (...a) => backend.createSession(...a);
export const userForToken = (...a) => backend.userForToken(...a);
export const destroySession = (...a) => backend.destroySession(...a);
export const listHarnesses = (...a) => backend.listHarnesses(...a);
export const getHarness = (...a) => backend.getHarness(...a);
export const saveHarness = (...a) => backend.saveHarness(...a);
export const deleteHarness = (...a) => backend.deleteHarness(...a);
export const orgRoleFor = (...a) => backend.orgRoleFor(...a);
export const createOrg = (...a) => backend.createOrg(...a);
export const listOrgs = (...a) => backend.listOrgs(...a);
export const listMembers = (...a) => backend.listMembers(...a);
export const addMember = (...a) => backend.addMember(...a);
export const removeMember = (...a) => backend.removeMember(...a);
export const setHarnessOrg = (...a) => backend.setHarnessOrg(...a);
export const logAudit = (...a) => backend.logAudit(...a);
export const listAudit = (...a) => backend.listAudit(...a);
export const createApiKey = (...a) => backend.createApiKey(...a);
export const listApiKeys = (...a) => backend.listApiKeys(...a);
export const revokeApiKey = (...a) => backend.revokeApiKey(...a);
export const verifyApiKey = (...a) => backend.verifyApiKey(...a);
export const recordRun = (...a) => backend.recordRun(...a);
export const listRuns = (...a) => backend.listRuns(...a);
export const getRun = (...a) => backend.getRun(...a);
export const setBudget = (...a) => backend.setBudget(...a);
export const listBudgets = (...a) => backend.listBudgets(...a);
export const deleteBudget = (...a) => backend.deleteBudget(...a);
export const budgetStatus = (...a) => backend.budgetStatus(...a);
export const checkBudget = (...a) => backend.checkBudget(...a);
export const createDeployment = (...a) => backend.createDeployment(...a);
export const listDeployments = (...a) => backend.listDeployments(...a);
export const deleteDeployment = (...a) => backend.deleteDeployment(...a);
export const resolveDeployment = (...a) => backend.resolveDeployment(...a);
export const listVersions = (...a) => backend.listVersions(...a);
export const getVersion = (...a) => backend.getVersion(...a);
export const activeDeploymentForHarness = (...a) => backend.activeDeploymentForHarness(...a);
export const listTriggers = (...a) => backend.listTriggers(...a);
export const createTrigger = (...a) => backend.createTrigger(...a);
export const updateTrigger = (...a) => backend.updateTrigger(...a);
export const deleteTrigger = (...a) => backend.deleteTrigger(...a);
export const getTriggerByToken = (...a) => backend.getTriggerByToken(...a);
export const dueScheduleTriggers = (...a) => backend.dueScheduleTriggers(...a);
export const markTriggerFired = (...a) => backend.markTriggerFired(...a);
export const claimDueScheduleTriggers = (...a) => backend.claimDueScheduleTriggers(...a);
export const recordFireResult = (...a) => backend.recordFireResult(...a);
export const listTriggerFires = (...a) => backend.listTriggerFires(...a);
export const listConnections = (...a) => backend.listConnections(...a);
export const createConnection = (...a) => backend.createConnection(...a);
export const updateConnection = (...a) => backend.updateConnection(...a);
export const deleteConnection = (...a) => backend.deleteConnection(...a);
export const resolveConnectionSecret = (...a) => backend.resolveConnectionSecret(...a);
export const upsertOAuthConnection = (...a) => backend.upsertOAuthConnection(...a);
export const resolveConnection = (...a) => backend.resolveConnection(...a);
export const listComments = (...a) => backend.listComments(...a);
export const createComment = (...a) => backend.createComment(...a);
export const resolveComment = (...a) => backend.resolveComment(...a);
export const deleteComment = (...a) => backend.deleteComment(...a);
export const exportOrg = (...a) => backend.exportOrg(...a);
export const eraseOrg = (...a) => backend.eraseOrg(...a);
export const kvGet = (...a) => backend.kvGet(...a);
export const kvSet = (...a) => backend.kvSet(...a);
export const kvDelete = (...a) => backend.kvDelete(...a);
export const kvList = (...a) => backend.kvList(...a);

// ConflictError must be the same class the active backend throws, so
// `instanceof` checks in routes work.
export const ConflictError = backend.ConflictError;

// readiness probe: a cheap round-trip to confirm the data layer answers.
// Falls back to "ok" for backends that predate ping (SQLite in-memory is always
// up), so /readyz stays meaningful across both backends.
export const ping = (...a) => (backend.ping ? backend.ping(...a) : Promise.resolve(true));
