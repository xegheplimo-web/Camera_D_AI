import { authorize } from "@/lib/auth-server";
import { authorizeResource } from "@/lib/scope";
import { problem } from "@/lib/audit";
import { readLocalAsset } from "@/lib/camera/detector";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return problem(400, "Mã ảnh không hợp lệ");
  const scoped = await authorizeResource(auth.session, "asset", id);
  if (!scoped.ok) return scoped.response;
  const row = scoped.row;
  if (row.url?.startsWith("local:")) {
    const buf = await readLocalAsset(row.url);
    if (!buf) return new Response("Gone", { status: 410 });
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": row.mime,
        "Cache-Control": "private, no-store",
        "Vary": "Cookie",
        ETag: `"${row.sha256}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (row.url) return Response.redirect(new URL(row.url, req.url), 302);
  if (!row.data) return new Response("Gone", { status: 410 });
  const buf = Buffer.from(row.data, "base64");
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": row.mime,
      "Cache-Control": "private, no-store",
      "Vary": "Cookie",
      ETag: `"${row.sha256}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
