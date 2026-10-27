/* Connector catalog: shape, search, and validation. Run: node server/connectors.test.mjs */
import assert from "node:assert";
import { CONNECTORS, getConnector, listConnectors, validateConnection } from "./connectors.mjs";

let passed = 0, failed = 0; const failures = [];
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; failures.push([name, e.message]); } }

test("every connector has the required shape", () => {
  const kinds = new Set(["mcp", "http", "db"]);
  const auths = new Set(["none", "apikey", "bearer", "connstring", "oauth"]);
  for (const c of CONNECTORS) {
    assert.ok(c.id && c.name && c.category, `missing core fields on ${c.id}`);
    assert.ok(kinds.has(c.kind), `bad kind on ${c.id}`);
    assert.ok(auths.has(c.auth), `bad auth on ${c.id}`);
    assert.ok(Array.isArray(c.fields), `fields must be an array on ${c.id}`);
  }
  assert.equal(new Set(CONNECTORS.map((c) => c.id)).size, CONNECTORS.length, "ids are unique");
});

test("getConnector resolves by id", () => {
  assert.equal(getConnector("slack").name, "Slack");
  assert.equal(getConnector("nope"), null);
});

test("search matches name, description, category", () => {
  assert.ok(listConnectors({ q: "slack" }).some((c) => c.id === "slack"));
  assert.ok(listConnectors({ q: "vector" }).some((c) => c.id === "pgvector"));
  assert.ok(listConnectors({ category: "Databases" }).every((c) => c.category === "Databases"));
  assert.equal(listConnectors({ q: "zzzznope" }).length, 0);
});

test("validateConnection enforces name, required fields, url shape, required secret", () => {
  // http needs baseUrl; secret optional
  let v = validateConnection("http", { name: "", config: {} });
  assert.ok(!v.ok && v.errors.some((e) => /name/i.test(e)) && v.errors.some((e) => /Base URL is required/i.test(e)));
  v = validateConnection("http", { name: "My API", config: { baseUrl: "ftp://bad" } });
  assert.ok(!v.ok && v.errors.some((e) => /http\(s\)/i.test(e)));
  v = validateConnection("http", { name: "My API", config: { baseUrl: "https://api.example.com" } });
  assert.ok(v.ok, "valid http connection");

  // notion requires its integration token (secret)
  v = validateConnection("notion", { name: "Workspace", config: {}, secret: "" });
  assert.ok(!v.ok && v.errors.some((e) => /Integration token is required/i.test(e)));
  v = validateConnection("notion", { name: "Workspace", config: {}, secret: "secret_1" });
  assert.ok(v.ok, "valid notion connection");

  // an OAuth connector's pasted token is optional (OAuth provides it)
  assert.ok(validateConnection("slack", { name: "Workspace", config: {}, secret: "" }).ok, "slack secret optional (OAuth-first)");

  v = validateConnection("ghost", { name: "x" });
  assert.ok(!v.ok && /Unknown connector/.test(v.errors[0]));
});

console.log(`\nconnectors.test.mjs: ${passed} passed, ${failed} failed`);
for (const [n, m] of failures) console.log(`  x ${n}: ${m}`);
process.exit(failed === 0 ? 0 : 1);
