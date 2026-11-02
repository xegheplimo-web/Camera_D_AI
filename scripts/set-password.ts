import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { db, pool } from "../src/db";
import { users, sessions, auditLog } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const login = process.env.DAI_RESET_LOGIN?.trim().toLowerCase();
  const password = process.env.DAI_RESET_PASSWORD;
  if (!login || !password || password.length < 14) throw new Error("Set DAI_RESET_LOGIN and DAI_RESET_PASSWORD (14+ characters) in the process environment.");
  const salt = randomBytes(16).toString("hex");
  const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  await db.transaction(async (tx) => {
    const [user] = await tx.update(users).set({ passwordHash: hash }).where(eq(users.login, login)).returning({ id: users.id });
    if (!user) throw new Error("Account not found. No changes applied.");
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, user.id));
    await tx.insert(auditLog).values({ actor: "server-cli", action: "auth.password_reset", targetType: "user", targetId: String(user.id), detail: "All prior sessions revoked" });
  });
  console.log("Password updated; prior sessions revoked. Password not logged.");
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Password reset failed"); process.exitCode = 1; }).finally(() => pool.end());
