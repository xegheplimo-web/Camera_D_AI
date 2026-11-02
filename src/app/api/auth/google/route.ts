import { googleConfig, generateState, stateCookie, buildAuthorizeUrl } from "@/lib/auth/google";

export const dynamic = "force-dynamic";

function redirect(location: string, cookies: string[] = []) {
  const res = new Response(null, { status: 302, headers: { Location: location } });
  for (const c of cookies) res.headers.append("Set-Cookie", c);
  return res;
}

/** Start of the Google authorization-code flow: CSRF state cookie + redirect to consent. */
export async function GET() {
  const cfg = googleConfig();
  if (!cfg) return redirect("/login?google=error");
  const state = generateState();
  return redirect(buildAuthorizeUrl(cfg, state), [stateCookie(state)]);
}
