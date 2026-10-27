/* Live presence (in-memory, per-process). Covers heartbeat excluding self,
   selection updates, room isolation, and leave. Run: node server/presence.test.mjs */
import assert from "node:assert";
import * as presence from "./presence.mjs";

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

presence._reset();

test("a lone viewer sees nobody else", () => {
  const others = presence.heartbeat("h1", { id: "u1", email: "a@x.com" }, "n1");
  assert.equal(others.length, 0);
});

test("a second viewer sees the first, with their node selection", () => {
  const others = presence.heartbeat("h1", { id: "u2", email: "b@x.com" }, "n2");
  assert.equal(others.length, 1);
  assert.equal(others[0].id, "u1");
  assert.equal(others[0].selection, "n1");
});

test("a repeat heartbeat updates the sender's selection", () => {
  presence.heartbeat("h1", { id: "u1", email: "a@x.com" }, "n9");
  const v = presence.viewers("h1");
  assert.equal(v.find((x) => x.id === "u1").selection, "n9");
  assert.equal(v.length, 2);
});

test("rooms are isolated per harness", () => {
  presence.heartbeat("h2", { id: "u3", email: "c@x.com" }, null);
  assert.equal(presence.viewers("h1").length, 2);
  assert.equal(presence.viewers("h2").length, 1);
});

test("leave removes a viewer", () => {
  presence.leave("h1", "u1");
  assert.equal(presence.viewers("h1", "u2").length, 0);   // only u2 remained, and it's excluded
  assert.equal(presence.viewers("h1").length, 1);
});

test("viewers() for an unknown harness is empty", () => {
  assert.deepEqual(presence.viewers("nope"), []);
});

test("a cursor is carried through to the other viewers", () => {
  presence._reset();
  presence.heartbeat("hc", { id: "u1", email: "a@x.com" }, "n1", { x: 120, y: 80 });
  const others = presence.heartbeat("hc", { id: "u2", email: "b@x.com" }, null, { x: 5, y: 5 });
  assert.deepEqual(others[0].cursor, { x: 120, y: 80 });
});

test("a malformed or missing cursor becomes null, not a crash", () => {
  presence._reset();
  presence.heartbeat("hc", { id: "u1", email: "a@x.com" }, null, { x: "NaN", y: 3 });
  presence.heartbeat("hc", { id: "u3", email: "c@x.com" }, null);   // no cursor arg
  const v = presence.viewers("hc");
  assert.equal(v.find((x) => x.id === "u1").cursor, null);
  assert.equal(v.find((x) => x.id === "u3").cursor, null);
});

test("an out-of-range cursor is clamped", () => {
  presence._reset();
  presence.heartbeat("hc", { id: "u1", email: "a@x.com" }, null, { x: 9e9, y: -9e9 });
  const v = presence.viewers("hc", "zzz");
  assert.deepEqual(v[0].cursor, { x: 100000, y: -100000 });
});

console.log(`\npresence.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
