import { currentSession } from "@/lib/auth-server";
import { can } from "@/lib/token";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await currentSession();
  if (!s) return Response.json({ authenticated: false }, { status: 200 });
  return Response.json({
    authenticated: true,
    user: { id: s.sub, name: s.name, role: s.role, device: s.device },
    permissions: {
      capture: can(s.role, "capture"),
      verify: can(s.role, "verify"),
      export: can(s.role, "export"),
      delete: can(s.role, "delete"),
      manage: can(s.role, "manage"),
      remotePlayback: can(s.role, "playback_remote"),
    },
  });
}
