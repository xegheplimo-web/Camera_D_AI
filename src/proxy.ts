import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_NAME } from "@/lib/token";
import { serverSession } from "@/lib/auth-server";

const PUBLIC = [/^\/login(?:\/|$)/, /^\/api\/auth\/(?:login|me|google)(?:\/|$)/, /^\/api\/health(?:\/|$)/,
  /^\/manifest\.webmanifest$/, /^\/sw\.js$/, /^\/icons\//, /^\/cams\//, /^\/favicon\.ico$/];

// Next.js 16 Proxy uses the Node runtime, so revoked DB sessions are checked for every protected request.
export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/internal/")) return NextResponse.next(); // constant-time service-token check in each handler
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin) {
      const allowed = new Set([req.nextUrl.host, req.headers.get("host")]);
      let originHost: string;
      try { originHost = new URL(origin).host; } catch { originHost = "invalid"; }
      if (!allowed.has(originHost)) return NextResponse.json({ title: "Origin không được phép", status: 403 }, { status: 403 });
    }
  }
  if (PUBLIC.some((p) => p.test(path))) return NextResponse.next();
  let session;
  try { session = await serverSession(req.cookies.get(COOKIE_NAME)?.value); } catch { session = null; }
  if (session) return NextResponse.next();
  if (path.startsWith("/api/")) return NextResponse.json({ type: "about:blank", title: "Cần đăng nhập bằng phiên còn hiệu lực", status: 401 }, { status: 401, headers: { "Content-Type": "application/problem+json" } });
  const url = req.nextUrl.clone();
  url.pathname = "/login"; url.search = "";
  if (path !== "/") url.searchParams.set("next", path);
  return NextResponse.redirect(url);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
