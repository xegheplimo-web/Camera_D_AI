/**
 * Signed, expiring session token. Verified in Edge middleware and in Node routes,
 * so it only uses Web Crypto (no Node-only APIs).
 *
 * AUTH_SECRET must be supplied server-side (32+ chars). No fixed fallback secret.
 */
export const COOKIE_NAME = "dai_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export type Role = "owner" | "operator" | "viewer";
export const ROLES: Role[] = ["owner", "operator", "viewer"];

export type SessionPayload = {
  sid: string;
  sub: number;
  name: string;
  role: Role;
  device: string;
  exp: number;
};

const encoder = new TextEncoder();

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  return value;
}

function toB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

export async function signToken(payload: SessionPayload): Promise<string> {
  const body = toB64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${toB64Url(await hmac(body))}`;
}

export async function verifyToken(token: string | undefined | null): Promise<SessionPayload | null> {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const expected = await hmac(body);
    const given = fromB64Url(sig);
    if (given.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
    if (diff !== 0) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64Url(body))) as SessionPayload;
    if (!payload || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!ROLES.includes(payload.role)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Server-side permission matrix (see docs/SECURITY.md). */
export function can(role: Role, action: "read" | "capture" | "ask" | "verify" | "export" | "delete" | "manage" | "playback_remote"): boolean {
  const matrix: Record<Role, string[]> = {
    owner: ["read", "capture", "ask", "verify", "export", "delete", "manage", "playback_remote"],
    operator: ["read", "capture", "ask", "verify", "export", "manage"],
    viewer: ["read", "ask"],
  };
  return matrix[role]?.includes(action) ?? false;
}
