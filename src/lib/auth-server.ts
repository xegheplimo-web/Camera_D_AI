import { cookies, headers } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { COOKIE_NAME, ROLES, can, verifyToken, type Role, type SessionPayload } from "./token";

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
export async function requestMeta() {
  const h = await headers();
  const ua = h.get("user-agent") ?? "unknown";
  const device = /Android/i.test(ua) ? "android" : /iPhone|iPad/i.test(ua) ? "ios" : /Windows/i.test(ua) ? "windows" : /Macintosh/i.test(ua) ? "macos" : "web";
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "local";
  return { ua, device, ip };
}
