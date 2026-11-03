import test from "node:test";
import assert from "node:assert/strict";
import { resolveStartOrigin } from "../src/lib/auth/google";

// T-1317: the OAuth start must run on the callback's origin so the state cookie is
// sent back to /api/auth/google/callback. A different request origin (e.g. a LAN IP)
// gets redirected to the canonical origin before any state is generated.
test("Google start: same origin needs no canonical redirect", () => {
  assert.equal(
    resolveStartOrigin("http://localhost:3000", "http://localhost:3000/api/auth/google/callback"),
    null
  );
});

test("Google start: LAN IP request origin redirects to the callback origin", () => {
  assert.equal(
    resolveStartOrigin("http://192.168.1.238:3000", "http://localhost:3000/api/auth/google/callback"),
    "http://localhost:3000"
  );
});

test("Google start: production https callback wins over LAN IP", () => {
  assert.equal(
    resolveStartOrigin("http://192.168.1.238:3000", "https://duyai.app/api/auth/google/callback"),
    "https://duyai.app"
  );
  assert.equal(
    resolveStartOrigin("https://duyai.app", "https://duyai.app/api/auth/google/callback"),
    null
  );
});

test("Google start: malformed input never forces a redirect", () => {
  assert.equal(resolveStartOrigin("not a url", "http://localhost:3000/api/auth/google/callback"), null);
  assert.equal(resolveStartOrigin("http://localhost:3000", "not a url"), null);
});
