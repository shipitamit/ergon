/* Live presence — who is viewing a harness right now.

   Presence is transient and per-process: a heartbeat updates an in-memory
   record, and entries older than TTL are swept on access. This intentionally
   avoids the database — presence is ephemeral, high-churn, and worthless to
   persist. In a multi-instance deployment each app process sees only its own
   viewers; that is an accepted limitation (durable collaboration lives in the
   comments table, which is shared). A shared backend (e.g. Redis pub/sub) can
   replace this module without touching routes. */

const TTL_MS = 30_000;                 // a viewer is "present" for 30s after their last ping
const rooms = new Map();               // harnessId -> Map(userId -> { id, email, selection, cursor, lastSeen })

// a cursor is {x, y} in canvas world coords; clamp to finite numbers in a sane
// range so a malformed or hostile ping can't bloat memory or NaN the clients.
function cleanCursor(c) {
  if (!c || typeof c !== "object") return null;
  const x = Number(c.x), y = Number(c.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const clamp = (n) => Math.max(-100000, Math.min(100000, Math.round(n)));
  return { x: clamp(x), y: clamp(y) };
}

function room(harnessId) {
  let r = rooms.get(harnessId);
  if (!r) { r = new Map(); rooms.set(harnessId, r); }
  return r;
}
function sweep(r) {
  const cut = Date.now() - TTL_MS;
  for (const [k, v] of r) if (v.lastSeen < cut) r.delete(k);
}

// record a viewer's heartbeat (with their current node selection) and return
// the other viewers present on the same harness.
export function heartbeat(harnessId, user, selection = null, cursor = null) {
  const r = room(harnessId);
  r.set(user.id, { id: user.id, email: user.email, selection: selection || null, cursor: cleanCursor(cursor), lastSeen: Date.now() });
  sweep(r);
  return viewers(harnessId, user.id);
}

// the viewers currently present, optionally excluding one user id (the caller).
export function viewers(harnessId, excludeId = null) {
  const r = rooms.get(harnessId);
  if (!r) return [];
  sweep(r);
  return [...r.values()]
    .filter((v) => v.id !== excludeId)
    .map((v) => ({ id: v.id, email: v.email, selection: v.selection, cursor: v.cursor || null, lastSeen: v.lastSeen }));
}

export function leave(harnessId, userId) {
  const r = rooms.get(harnessId);
  if (r) { r.delete(userId); if (!r.size) rooms.delete(harnessId); }
}

// test hooks
export function _reset() { rooms.clear(); }
export const _TTL_MS = TTL_MS;
