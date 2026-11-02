import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { normalizeRole, requestMeta, issueSession, sessionCookie } from "@/lib/auth-server";
import { audit } from "@/lib/audit";
import { ensureSeed } from "@/lib/seed";
import { scryptSync, timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";

/** naive fixed-window limiter (per-process) to slow credential stuffing */
const attempts = new Map<string, { count: number; reset: number }>();
function rateLimited(key: string) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || rec.reset < now) {
    attempts.set(key, { count: 1, reset: now + 5 * 60_000 });
    return false;
  }
  rec.count++;
  return rec.count > 8;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false; // OAuth-only accounts have NULL password_hash
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const calc = scryptSync(password, salt, 64);
  const given = Buffer.from(hash, "hex");
  return given.length === calc.length && timingSafeEqual(given, calc);
}

export async function POST(req: Request) {
  await ensureSeed();
  const meta = await requestMeta();
  const body = await req.json().catch(() => null);
  const login = String(body?.login ?? "").trim().toLowerCase().slice(0, 64);
  const password = String(body?.password ?? "");
  if (!login || !password) {
    return Response.json({ title: "Thiếu thông tin đăng nhập", status: 400 }, { status: 400 });
  }
  if (rateLimited(`${meta.ip}:${login}`)) {
    return Response.json({ title: "Quá nhiều lần thử", detail: "Thử lại sau 5 phút", status: 429 }, { status: 429 });
  }
  const [user] = await db.select().from(users).where(eq(users.login, login)).limit(1);
  if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
    await audit("auth.login_failed", { targetType: "user", targetId: login, detail: meta.ip });
    return Response.json({ title: "Sai tên đăng nhập hoặc mật khẩu", status: 401 }, { status: 401 });
  }
  const token = await issueSession(user, meta);
  await audit("auth.login", { targetType: "user", targetId: user.id, detail: meta.ip });
  const res = Response.json({ ok: true, user: { id: user.id, name: user.displayName, role: normalizeRole(user.role) } });
  res.headers.append("Set-Cookie", sessionCookie(token));
  return res;
}
