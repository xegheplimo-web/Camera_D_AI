import { db } from "@/db";
import { events, cameras } from "@/db/schema";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import { startOfDayVN, addDays, fmtDateTime } from "@/lib/time";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { tenantIdOf } from "@/lib/knowledge/tenant";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

function csv(v: unknown) {
  const text = String(v ?? "");
  const s = /^[=+@-]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: Request) {
  const auth = await authorize("export");
  if (auth.response) return auth.response;
  const settings = await getSettings();
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("days") ?? 7)));
  const end = addDays(startOfDayVN(), 1);
  const start = addDays(end, -days);
  const tenantId = await tenantIdOf(auth.session);
  const rows = await db.select().from(events).where(and(eq(events.tenantId, tenantId), gte(events.happenedAt, start), lt(events.happenedAt, end), ...(settings.demoMode ? [] : [sql`${events.source} <> 'demo'`]))).orderBy(asc(events.happenedAt));
  const cams = await db.select().from(cameras).where(eq(cameras.tenantId, tenantId));
  const header = ["id", "thoi_gian", "camera", "loai", "doi_tuong", "mo_ta", "do_tin_cay", "uu_tien", "the", "nguon", "asset_id", "client_chua_duyet"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const c = cams.find((x) => x.id === r.cameraId);
    lines.push(
      [r.id, fmtDateTime(r.happenedAt), c ? `${c.name} - ${c.location}` : r.cameraId, r.type, r.objectClass, r.label, r.confidence?.toFixed(2), r.priority, r.tags.join("|"), r.source, r.assetId, r.clientReported ? "yes" : "no"]
        .map(csv)
        .join(",")
    );
  }
  await audit("data.export", { targetType: "events", detail: `${days} ngày, ${rows.length} dòng` });
  return new Response("\uFEFF" + lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="camera-dai-bao-cao-${days}-ngay.csv"`,
    },
  });
}
