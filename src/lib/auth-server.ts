import { cookies, headers } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { clientIp, type HeaderSource } from "./http-guard";
import { COOKIE_NAME, ROLES, SESSION_TTL_SECONDS, can, signToken, verifyToken, type Role, type SessionPayload } from "./token";

export type Authorized = { session: SessionPayload; response?: undefined } | { session?: undefined; response: Response };

export async function serverSession(cookie: string | undefined): Promise<SessionPayload | null> {
  const token = await verifyToken(cookie);
  if (!token) return null;
  const [row] = await db.select({ role: users.role, name: users.displayName }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, token.sid), eq(users.id, token.sub), eq(users.disabled, false), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()))).limit(1);
  if (!row || !ROLES.includes(row.role as Role)) return null;
  return { ...token, role: row.role as Role, name: row.name };
}
export async function currentSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  return serverSession(jar.get(COOKIE_NAME)?.value);
}
export async function authorize(action: Parameters<typeof can>[1] = "read"): Promise<Authorized> {
  const session = await currentSession();
  const problem = (status: number, title: string) => new Response(JSON.stringify({ type: "about:blank", title, status }), { status, headers: { "Content-Type": "application/problem+json" } });
  if (!session) return { response: problem(401, "Phiên đã hết hiệu lực. Hãy đăng nhập lại.") };
  if (!can(session.role, action)) return { response: problem(403, "Vai trò hiện tại không đủ quyền thực hiện thao tác này.") };
  return { session };
}
export function normalizeRole(v: unknown): Role { return ROLES.includes(v as Role) ? v as Role : "viewer"; }
/**
 * Request metadata for session issuance/audit. X-Forwarded-For is trusted only
 * when the direct peer is inside TRUSTED_PROXY_CIDR (see clientIp); without a
 * resolvable peer the ip falls back to "unknown" — never a client claim.
 */
export async function requestMeta(h?: HeaderSource, remoteAddr?: string | null) {
  const hdrs = h ?? (await headers());
  const ua = hdrs.get("user-agent") ?? "unknown";
  const device = /Android/i.test(ua) ? "android" : /iPhone|iPad/i.test(ua) ? "ios" : /Windows/i.test(ua) ? "windows" : /Macintosh/i.test(ua) ? "macos" : "web";
  return { ua, device, ip: clientIp(hdrs, remoteAddr) };
}
/** Shared session issuance for password and Google OAuth sign-in. */
export async function issueSession(user: { id: number; displayName: string; role: string }, meta: { device: string; ua: string; ip: string }): Promise<string> {
  const sid = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await db.insert(sessions).values({ id: sid, userId: user.id, device: meta.device, userAgent: meta.ua, ip: meta.ip, expiresAt });
  return signToken({ sid, sub: user.id, name: user.displayName, role: normalizeRole(user.role), device: meta.device, exp: Math.floor(expiresAt.getTime() / 1000) });
}
export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}
