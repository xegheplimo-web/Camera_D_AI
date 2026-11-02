import "dotenv/config";
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { clientIp, createFixedWindowLimiter, httpGuardMetrics, parseIp, remoteAddrFrom, type FixedWindowLimiter } from "../src/lib/http-guard";

/**
 * CAM-G1-002 — rate-limit + HTTP contract hardening. Runs without
 * Docker/Postgres: the login route module only builds a lazy pg.Pool at import
 * (never queried — all deps are stubbed), and DATABASE_URL gets a dummy value
 * when the environment does not provide one.
 */
process.env.DATABASE_URL ??= "postgres://127.0.0.1:9/rl_http_unit";

type RouteModule = typeof import("../src/app/api/auth/login/route");
type AuthModule = typeof import("../src/lib/auth-server");
type Deps = Parameters<RouteModule["handleLogin"]>[1];

let handleLogin: RouteModule["handleLogin"];
let requestMeta: AuthModule["requestMeta"];

before(async () => {
  const [route, auth] = await Promise.all([import("../src/app/api/auth/login/route"), import("../src/lib/auth-server")]);
  handleLogin = route.handleLogin;
  requestMeta = auth.requestMeta;
});

const ENDPOINT = "http://localhost/api/auth/login";
const post = (body?: string, headers: Record<string, string> = {}) => new Request(ENDPOINT, { method: "POST", headers, body });
const postJson = (payload: unknown, headers: Record<string, string> = {}) =>
  post(typeof payload === "string" ? payload : JSON.stringify(payload), { "content-type": "application/json", ...headers });

const salt = randomBytes(16).toString("hex");
const wrongUser = {
  id: 7,
  displayName: "Litmus",
  role: "viewer",
  disabled: false,
  passwordHash: `scrypt$${salt}$${scryptSync("the-real-password", salt, 64).toString("hex")}`,
};

function deps(overrides: Partial<Deps> = {}): { deps: Deps; calls: { findUser: number; audit: number }; keys: string[] } {
  const calls = { findUser: 0, audit: 0 };
  const keys: string[] = [];
  const inner = createFixedWindowLimiter({ maxAttempts: 5, windowMs: 5 * 60_000, maxEntries: 5000 });
  const limiter: FixedWindowLimiter = {
    get size() { return inner.size; },
    limited(key: string, now?: number) { keys.push(key); return inner.limited(key, now); },
  };
  return {
    calls,
    keys,
    deps: {
      seed: async () => {},
      findUser: async () => { calls.findUser++; return wrongUser; },
      audit: async () => { calls.audit++; },
      issueSession: async () => "tok",
      limiter,
      ...overrides,
    },
  };
}

test("login rate-limit: 6th wrong-password attempt is 429 and never reaches the user lookup", async () => {
  const { deps: d, calls } = deps();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await handleLogin(postJson({ login: "litmus", password: "wrong" }), d)).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  assert.equal(calls.findUser, 5, "limiter must short-circuit before the DB lookup");
});

test("spoofed XFF cannot mint fresh buckets: untrusted peers share the 'unknown' bucket", async () => {
  const { deps: d, keys } = deps();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++)
    statuses.push((await handleLogin(postJson({ login: "spoof", password: "x" }, { "x-forwarded-for": `10.9.8.${i}` }), d)).status);
  assert.equal(statuses[5], 429);
  assert.equal(keys.length, 6);
  assert.ok(keys.every((k) => k.startsWith("unknown:")), `bucket keys must not trust XFF: ${keys.join(", ")}`);
  assert.ok(httpGuardMetrics.forwardedForRejected >= 6);
});

test("clientIp honors XFF only from TRUSTED_PROXY_CIDR peers; else peer IP or 'unknown'", () => {
  const saved = process.env.TRUSTED_PROXY_CIDR;
  const h = (xff?: string) => new Headers(xff ? { "x-forwarded-for": xff } : {});
  try {
    process.env.TRUSTED_PROXY_CIDR = "10.0.0.0/8, 192.168.1.1, ::1/128";
    assert.equal(clientIp(h("203.0.113.9, 10.1.2.3"), "10.1.2.3"), "203.0.113.9");
    assert.equal(clientIp(h("203.0.113.9"), "192.168.1.1"), "203.0.113.9"); // bare-IP entry
    assert.equal(clientIp(h("203.0.113.9"), "::1"), "203.0.113.9"); // IPv6 CIDR entry
    assert.equal(clientIp(h("203.0.113.9"), "::ffff:10.2.3.4"), "203.0.113.9"); // v4-mapped peer
    assert.equal(clientIp(h("203.0.113.9"), "8.8.8.8"), "8.8.8.8"); // untrusted peer: XFF ignored
    assert.equal(clientIp(h(), "10.1.2.3"), "10.1.2.3"); // trusted peer without XFF → peer
    assert.equal(clientIp(h("not-an-ip"), "10.1.2.3"), "10.1.2.3"); // trusted peer, bogus XFF → peer
  } finally {
    if (saved === undefined) delete process.env.TRUSTED_PROXY_CIDR;
    else process.env.TRUSTED_PROXY_CIDR = saved;
  }
  assert.equal(clientIp(h("203.0.113.9"), "8.8.8.8"), "8.8.8.8");
  assert.equal(clientIp(h(), null), "unknown");
  assert.ok(httpGuardMetrics.clientIpUnknown >= 1);
});

test("remoteAddrFrom picks platform req.ip or socket remoteAddress; web Request → null", () => {
  assert.equal(remoteAddrFrom(new Request(ENDPOINT)), null);
  assert.equal(remoteAddrFrom(Object.assign(new Request(ENDPOINT), { ip: "203.0.113.7" })), "203.0.113.7");
  assert.equal(remoteAddrFrom(Object.assign(new Request(ENDPOINT), { socket: { remoteAddress: "198.51.100.2" } })), "198.51.100.2");
});

test("requestMeta wires headers + remote addr through the fail-closed clientIp path", async () => {
  const meta = await requestMeta(new Headers({ "user-agent": "Android", "x-forwarded-for": "1.2.3.4" }), "9.9.9.9");
  assert.equal(meta.ip, "9.9.9.9");
  assert.equal(meta.device, "android");
  const noPeer = await requestMeta(new Headers({ "x-forwarded-for": "1.2.3.4" }), null);
  assert.equal(noPeer.ip, "unknown");
});

test("HTTP contract: 413 oversize, 415 wrong content-type, 422 invalid fields, 400 kept for missing/malformed", async () => {
  const { deps: d } = deps();
  assert.equal((await handleLogin(post(JSON.stringify({ login: "u", password: "x".repeat(9000) }), { "content-type": "application/json" }), d)).status, 413);
  assert.equal((await handleLogin(post(JSON.stringify({ login: "u", password: "p" }), { "content-type": "text/plain" }), d)).status, 415);
  assert.equal((await handleLogin(post(JSON.stringify({ login: "u", password: "p" })), d)).status, 415); // undici sets text/plain for string bodies
  assert.equal((await handleLogin(postJson({ login: 42, password: "x" }), d)).status, 422);
  assert.equal((await handleLogin(postJson([1, 2, 3]), d)).status, 422);
  assert.equal((await handleLogin(postJson(42), d)).status, 422); // well-formed JSON, wrong shape
  assert.equal((await handleLogin(postJson({ login: "u" }), d)).status, 400); // missing password — unchanged
  assert.equal((await handleLogin(postJson({}), d)).status, 400);
  assert.equal((await handleLogin(postJson("not json{"), d)).status, 400); // malformed JSON — unchanged
  assert.equal((await handleLogin(post(undefined, { "content-type": "application/json" }), d)).status, 400); // empty body
});

test("limiter map stays bounded: expiry sweep first, then least-recently-hit eviction", () => {
  const t0 = 1_000_000;
  const l = createFixedWindowLimiter({ maxAttempts: 1, windowMs: 10_000, maxEntries: 3 });
  assert.equal(l.limited("a", t0), false);
  assert.equal(l.limited("b", t0), false);
  assert.equal(l.limited("c", t0), false);
  assert.equal(l.limited("b", t0), true); // second hit exceeds maxAttempts=1; refreshes recency → order a,c,b
  assert.equal(l.limited("d", t0), false); // cap reached → 'a' (least recent) evicted
  assert.equal(l.size, 3);
  assert.equal(l.limited("a", t0), false); // 'a' was evicted → fresh window instead of exceeding
  assert.equal(l.limited("b", t0), true); // 'b' survived eviction and keeps its count
  assert.ok(l.size <= 3);

  const sweep = createFixedWindowLimiter({ maxAttempts: 5, windowMs: 1000, maxEntries: 2 });
  sweep.limited("x", t0);
  sweep.limited("y", t0);
  assert.equal(sweep.limited("z", t0 + 2000), false); // x,y expired → swept, no forced eviction of live keys
  assert.ok(sweep.size <= 2);
});

test("parseIp accepts IPv4/IPv6 literals and rejects garbage", () => {
  assert.equal(parseIp("1.2.3.4")?.bits, 32);
  assert.equal(parseIp("255.255.255.256"), null);
  assert.equal(parseIp("::1")?.bits, 128);
  assert.equal(parseIp("::ffff:1.2.3.4")?.bits, 128);
  assert.equal(parseIp("1:2:3:4:5:6:7:8::"), null);
  assert.equal(parseIp("hostname"), null);
});
