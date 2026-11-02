import { cookies } from "next/headers";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { COOKIE_NAME, verifyToken } from "@/lib/token";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST() {
  const jar = await cookies();
  const session = await verifyToken(jar.get(COOKIE_NAME)?.value);
  if (session) {
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.sid));
    await audit("auth.logout", { targetType: "session", targetId: session.sid });
  }
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return res;
}
