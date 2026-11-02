import test from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_STATE_COOKIE,
  GOOGLE_STATE_TTL_SECONDS,
  buildAuthorizeUrl,
  clearStateCookie,
  exchangeCode,
  fetchUserInfo,
  generateState,
  googleConfig,
  googleLoginAllowed,
  profileEmail,
  stateCookie,
  stateMatches,
} from "../src/lib/auth/google";

const cfg = { clientId: "client-123", clientSecret: "secret-xyz", callbackUrl: "http://localhost:3000/api/auth/google/callback" };
const mockFetch = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

test("Google OAuth: state is random, url-safe and verified against the cookie", () => {
  const a = generateState(), b = generateState();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(stateMatches(a, a), true);
  assert.equal(stateMatches(a, b), false);
  assert.equal(stateMatches(null, a), false);
  assert.equal(stateMatches(a, undefined), false);
  assert.equal(stateMatches("", a), false);
});

test("Google OAuth: state cookie is HttpOnly + Lax; clear sets Max-Age=0", () => {
  const c = stateCookie("abc");
  for (const part of [`${GOOGLE_STATE_COOKIE}=abc`, "HttpOnly", "SameSite=Lax", `Max-Age=${GOOGLE_STATE_TTL_SECONDS}`, "Path=/api/auth/google"])
    assert.ok(c.includes(part), part);
  assert.ok(clearStateCookie().includes("Max-Age=0"));
});

test("Google OAuth: authorize URL carries the code-flow params and state", () => {
  const url = new URL(buildAuthorizeUrl(cfg, "state-1"));
  assert.equal(`${url.origin}${url.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), cfg.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), cfg.callbackUrl);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("state"), "state-1");
});

test("Google OAuth: config requires client id, secret and callback", () => {
  assert.equal(googleConfig({}), null);
  assert.equal(googleConfig({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }), null);
  assert.equal(googleConfig({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b", GOOGLE_CALLBACK: "c" })?.callbackUrl, "c");
});

test("Google OAuth: code exchange posts the form and fails closed without throwing", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const okFetch = async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init };
    return new Response(JSON.stringify({ access_token: "tok-1" }), { status: 200 });
  };
  assert.deepEqual(await exchangeCode(cfg, "code-1", okFetch), { ok: true, value: { accessToken: "tok-1" } });
  const form = new URLSearchParams(String(seen?.init?.body));
  assert.equal(seen?.url, "https://oauth2.googleapis.com/token");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "code-1");
  assert.equal(form.get("client_id"), cfg.clientId);
  assert.equal(form.get("client_secret"), cfg.clientSecret);
  assert.equal(form.get("redirect_uri"), cfg.callbackUrl);

  assert.equal((await exchangeCode(cfg, "bad", mockFetch(400, { error: "invalid_grant" }))).ok, false);
  assert.equal((await exchangeCode(cfg, "x", async () => { throw new Error("offline"); })).ok, false);
  assert.equal((await exchangeCode(cfg, "x", mockFetch(200, { id_token: "no-access-token" }))).ok, false);
});

test("Google OAuth: userinfo requires sub + email; non-200 fails closed", async () => {
  const good = await fetchUserInfo("tok", mockFetch(200, { sub: "g-1", email: "AttonG39@Gmail.com", email_verified: true, name: "A" }));
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.value.sub, "g-1");
    assert.equal(profileEmail(good.value), "attong39@gmail.com");
  }
  assert.equal((await fetchUserInfo("tok", mockFetch(401, {}))).ok, false);
  assert.equal((await fetchUserInfo("tok", mockFetch(200, { email: "x@y.z" }))).ok, false); // missing sub
});

test("Google OAuth: only a verified email matching an enabled user may sign in", () => {
  const user = { login: "attong39@gmail.com", disabled: false };
  assert.equal(googleLoginAllowed({ email: "AttonG39@Gmail.com", emailVerified: true }, user), true);
  assert.equal(googleLoginAllowed({ email: "other@gmail.com", emailVerified: true }, user), false);
  assert.equal(googleLoginAllowed({ email: "attong39@gmail.com", emailVerified: false }, user), false);
  assert.equal(googleLoginAllowed({ email: "attong39@gmail.com", emailVerified: true }, { ...user, disabled: true }), false);
  assert.equal(googleLoginAllowed({ email: "attong39@gmail.com", emailVerified: true }, null), false);
});
