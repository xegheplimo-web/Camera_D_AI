/**
 * Google OAuth 2.0 authorization-code flow, server-side only (no NextAuth).
 * Pure helpers with no DB/Next imports so the module stays unit-testable.
 * Fail-closed: callers must never auto-create users on email mismatch.
 */
export const GOOGLE_STATE_COOKIE = "dai_google_state";
export const GOOGLE_STATE_TTL_SECONDS = 600;

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleConfig = { clientId: string; clientSecret: string; callbackUrl: string };

export function googleConfig(env: Record<string, string | undefined> = process.env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const callbackUrl = env.GOOGLE_CALLBACK?.trim();
  if (!clientId || !clientSecret || !callbackUrl) return null;
  return { clientId, clientSecret, callbackUrl };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateState(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Constant-time compare; cookie value is the source of truth against the query param. */
export function stateMatches(given: string | null, expected: string | undefined | null): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * OAuth must start on the callback's origin so the browser sends the state cookie
 * back to /api/auth/google/callback. Returns the canonical origin when the request
 * arrived elsewhere (e.g. a LAN IP); null when no redirect is needed.
 */
export function resolveStartOrigin(requestOrigin: string, callbackUrl: string): string | null {
  try {
    const canonical = new URL(callbackUrl);
    return new URL(requestOrigin).origin === canonical.origin ? null : canonical.origin;
  } catch {
    return null;
  }
}

export function stateCookie(state: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${GOOGLE_STATE_COOKIE}=${state}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${GOOGLE_STATE_TTL_SECONDS}${secure}`;
}

export function clearStateCookie(): string {
  return `${GOOGLE_STATE_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function buildAuthorizeUrl(cfg: GoogleConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.callbackUrl,
    response_type: "code",
    scope: "openid email profile",
    state,
  }).toString();
  return url.toString();
}

export type GoogleResult<T> = { ok: true; value: T } | { ok: false; error: string };
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function exchangeCode(cfg: GoogleConfig, code: string, fetchImpl: FetchLike = fetch): Promise<GoogleResult<{ accessToken: string }>> {
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.callbackUrl,
      }).toString(),
    });
    if (!res.ok) return { ok: false, error: `token_http_${res.status}` };
    const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
    if (typeof body?.access_token !== "string" || !body.access_token) return { ok: false, error: "token_bad_response" };
    return { ok: true, value: { accessToken: body.access_token } };
  } catch {
    return { ok: false, error: "token_network" };
  }
}

export type GoogleProfile = { sub: string; email: string; emailVerified: boolean; name?: string };

export async function fetchUserInfo(accessToken: string, fetchImpl: FetchLike = fetch): Promise<GoogleResult<GoogleProfile>> {
  try {
    const res = await fetchImpl(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return { ok: false, error: `userinfo_http_${res.status}` };
    const body = (await res.json().catch(() => null)) as { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown } | null;
    if (typeof body?.sub !== "string" || !body.sub || typeof body.email !== "string" || !body.email) return { ok: false, error: "userinfo_bad_response" };
    const name = typeof body.name === "string" ? body.name : undefined;
    return { ok: true, value: { sub: body.sub, email: body.email, emailVerified: body.email_verified === true, ...(name ? { name } : {}) } };
  } catch {
    return { ok: false, error: "userinfo_network" };
  }
}

/** Only a Google-verified email may sign in; normalized to the lowercase `users.login` format. */
export function profileEmail(profile: Pick<GoogleProfile, "email" | "emailVerified">): string | null {
  if (!profile.emailVerified) return null;
  const email = profile.email.trim().toLowerCase();
  return email || null;
}

/** Fail-closed gate: existing, enabled user whose login matches the verified email (case-insensitive). */
export function googleLoginAllowed(
  profile: Pick<GoogleProfile, "email" | "emailVerified">,
  user: { login: string; disabled: boolean } | null | undefined
): boolean {
  const email = profileEmail(profile);
  return !!email && !!user && !user.disabled && user.login === email;
}
