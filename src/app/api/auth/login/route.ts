import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { normalizeRole, requestMeta, issueSession, sessionCookie } from "@/lib/auth-server";
import { audit } from "@/lib/audit";
import { ensureSeed } from "@/lib/seed";
import { createFixedWindowLimiter, readJsonBody, remoteAddrFrom, toProblem, type FixedWindowLimiter } from "@/lib/http-guard";
import { scryptSync, timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";

/**
 * Bounded fixed-window limiter (per-process) to slow credential stuffing:
 * max 5 attempts per ip:login bucket per 5-minute lock window, at most 5000
 * tracked buckets (expired sweep + LRU eviction — the map can never grow
 * without limit). Buckets fall back to "unknown" when the client IP is not
 * determinable, so XFF spoofing cannot mint fresh buckets.
 */
const loginLimiter = createFixedWindowLimiter({ maxAttempts: 5, windowMs: 5 * 60_000, maxEntries: 5000 });
const MAX_BODY_BYTES = 8 * 1024;

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false; // OAuth-only accounts have NULL password_hash
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const calc = scryptSync(password, salt, 64);
  const given = Buffer.from(hash, "hex");
  return given.length === calc.length && timingSafeEqual(given, calc);
}

type LoginUser = Pick<typeof users.$inferSelect, "id" | "displayName" | "role" | "disabled" | "passwordHash">;

export interface LoginDeps {
  seed: () => Promise<unknown>;
  findUser: (login: string) => Promise<LoginUser | undefined>;
  audit: (action: string, meta: { targetType?: string; targetId?: string | number | null; detail?: string }) => Promise<unknown>;
  issueSession: (user: LoginUser, meta: { device: string; ua: string; ip: string }) => Promise<string>;
  limiter: FixedWindowLimiter;
}

const json = (status: number, body: Record<string, unknown>) => Response.json({ status, ...body }, { status });

export async function handleLogin(req: Request, deps: LoginDeps): Promise<Response> {
  await deps.seed();
  const meta = await requestMeta(req.headers, remoteAddrFrom(req));
  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    return toProblem(err);
  }
  const fields = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (body !== null && !fields) return json(422, { title: "Payload đăng nhập không hợp lệ" });
  const rawLogin = fields?.login;
  const rawPassword = fields?.password;
  if ((rawLogin != null && typeof rawLogin !== "string") || (rawPassword != null && typeof rawPassword !== "string"))
    return json(422, { title: "Trường đăng nhập không hợp lệ" });
  const login = (typeof rawLogin === "string" ? rawLogin : "").trim().toLowerCase().slice(0, 64);
  const password = typeof rawPassword === "string" ? rawPassword : "";
  if (!login || !password) {
    return json(400, { title: "Thiếu thông tin đăng nhập" });
  }
  if (deps.limiter.limited(`${meta.ip}:${login}`)) {
    return json(429, { title: "Quá nhiều lần thử", detail: "Thử lại sau 5 phút" });
  }
  const user = await deps.findUser(login);
  if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
    await deps.audit("auth.login_failed", { targetType: "user", targetId: login, detail: meta.ip });
    return json(401, { title: "Sai tên đăng nhập hoặc mật khẩu" });
  }
  const token = await deps.issueSession(user, meta);
  await deps.audit("auth.login", { targetType: "user", targetId: user.id, detail: meta.ip });
  const res = Response.json({ ok: true, user: { id: user.id, name: user.displayName, role: normalizeRole(user.role) } });
  res.headers.append("Set-Cookie", sessionCookie(token));
  return res;
}

export async function POST(req: Request) {
  return handleLogin(req, {
    seed: ensureSeed,
    findUser: async (login) => (await db.select().from(users).where(eq(users.login, login)).limit(1))[0],
    audit,
    issueSession,
    limiter: loginLimiter,
  });
}
