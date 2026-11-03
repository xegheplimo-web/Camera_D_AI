import { googleConfig, generateState, stateCookie, buildAuthorizeUrl, resolveStartOrigin } from "@/lib/auth/google";

export const dynamic = "force-dynamic";

function redirect(location: string, cookies: string[] = []) {
  const res = new Response(null, { status: 302, headers: { Location: location } });
  for (const c of cookies) res.headers.append("Set-Cookie", c);
  return res;
}

/** Start of the Google authorization-code flow: CSRF state cookie + redirect to consent. */
export async function GET(req: Request) {
  const cfg = googleConfig();
  if (!cfg) return redirect("/login?google=error");
  // The state cookie only reaches the callback when OAuth starts on its origin;
  // a request on another host (LAN IP) bounces to the canonical origin first.
  // req.url is normalized to the listen origin, so the browser-facing host comes
  // from the forwarded/Host headers.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(/:$/, "");
  const canonical = host ? resolveStartOrigin(`${proto}://${host}`, cfg.callbackUrl) : null;
  if (canonical) return redirect(`${canonical}/api/auth/google`);
  const state = generateState();
  return redirect(buildAuthorizeUrl(cfg, state), [stateCookie(state)]);
}
