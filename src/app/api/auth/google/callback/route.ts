import { cookies } from "next/headers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  GOOGLE_STATE_COOKIE,
  clearStateCookie,
  exchangeCode,
  fetchUserInfo,
  googleConfig,
  googleLoginAllowed,
  profileEmail,
  stateMatches,
} from "@/lib/auth/google";
import { issueSession, requestMeta, sessionCookie } from "@/lib/auth-server";
import { ensureGoogleSeed } from "@/lib/seed";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Google redirect target. Fail-closed: only a Google-verified email matching an
 * existing, enabled users.login row gets a session; everything else lands on
 * /login?google=denied (or ?google=error for upstream/infra failures).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  // Response.redirect() headers are immutable, so 302s are built explicitly to carry Set-Cookie.
  const redirect = (kind: "denied" | "error") => {
    const res = new Response(null, { status: 302, headers: { Location: `/login?google=${kind}` } });
    res.headers.append("Set-Cookie", clearStateCookie());
    return res;
  };

  const cfg = googleConfig();
  if (!cfg) return redirect("error");
  if (url.searchParams.get("error")) return redirect("error"); // consent-screen errors (incl. access_denied)

  const jar = await cookies();
  const stored = jar.get(GOOGLE_STATE_COOKIE)?.value;
  const given = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!stateMatches(given, stored)) {
    await audit("auth.google_denied", { targetType: "oauth", detail: "state mismatch" });
    return redirect("denied");
  }
  if (!code) return redirect("error");

  const token = await exchangeCode(cfg, code);
  if (!token.ok) {
    await audit("auth.google_error", { targetType: "oauth", detail: token.error });
    return redirect("error");
  }
  const info = await fetchUserInfo(token.value.accessToken);
  if (!info.ok) {
    await audit("auth.google_error", { targetType: "oauth", detail: info.error });
    return redirect("error");
  }

  const email = profileEmail(info.value);
  await ensureGoogleSeed();
  const [user] = email ? await db.select().from(users).where(eq(users.login, email)).limit(1) : [undefined];
  if (!user || !googleLoginAllowed(info.value, user)) {
    await audit("auth.google_denied", { targetType: "user", targetId: email ?? info.value.sub, detail: "email not provisioned or unverified" });
    return redirect("denied");
  }
  if (user.googleSub !== info.value.sub) {
    try {
      await db.update(users).set({ googleSub: info.value.sub }).where(eq(users.id, user.id));
    } catch {
      // users_google_sub_idx: the sub is already bound to another account — never steal the link.
      await audit("auth.google_denied", { targetType: "user", targetId: user.id, detail: "google_sub already linked elsewhere" });
      return redirect("denied");
    }
  }

  const meta = await requestMeta();
  const sessionToken = await issueSession(user, meta);
  await audit("auth.login", { targetType: "user", targetId: user.id, detail: `${meta.ip} via google` });
  const res = new Response(null, { status: 302, headers: { Location: "/" } });
  res.headers.append("Set-Cookie", sessionCookie(sessionToken));
  res.headers.append("Set-Cookie", clearStateCookie());
  return res;
}
