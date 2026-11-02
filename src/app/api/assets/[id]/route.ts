import { db } from "@/db";
import { assets } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const [row] = await db.select().from(assets).where(eq(assets.id, Number(id))).limit(1);
  if (!row) return new Response("Not found", { status: 404 });
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
