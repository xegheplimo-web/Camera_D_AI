import { db } from "@/db";
import { alertRules, assets, cameras, events, extractions } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { audit, problem } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { authorizeResource } from "@/lib/scope";
import { removeRecordingPath } from "@/lib/camera/recorder";
import { removeGo2rtcStream } from "@/lib/camera/stream";
import { publicCamera } from "@/lib/camera/public";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<number | null> {
  const id = Number((await ctx.params).id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** PATCH — sửa name/location/enabled/retentionDays (null = theo retention toàn cục). owner + operator. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  const id = await paramId(ctx);
  if (!id) return problem(400, "Mã camera không hợp lệ");
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return problem(400, "Thân yêu cầu không hợp lệ");

  const set: { name?: string; location?: string; enabled?: boolean; retentionDays?: number | null } = {};
  if ("name" in body) {
    const v = String(body.name ?? "").trim();
    if (!v || v.length > 60) return problem(400, "Tên camera phải 1–60 ký tự");
    set.name = v;
  }
  if ("location" in body) {
    const v = String(body.location ?? "").trim();
    if (!v || v.length > 80) return problem(400, "Vị trí phải 1–80 ký tự");
    set.location = v;
  }
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return problem(400, "enabled phải là boolean");
    set.enabled = body.enabled;
  }
  if ("retentionDays" in body) {
    const v = body.retentionDays;
    if (v === null || v === 0) set.retentionDays = null; // null/0 → kế thừa retention toàn cục
    else if (!Number.isSafeInteger(v) || v < 1 || v > 365) return problem(400, "Retention camera phải là 1–365 ngày hoặc null");
    else set.retentionDays = v;
  }
  if (!Object.keys(set).length) return problem(400, "Không có thay đổi hợp lệ");

  const scoped = await authorizeResource(auth.session, "camera", id, "write");
  if (!scoped.ok) return scoped.response;
  const [row] = await db.update(cameras).set(set).where(eq(cameras.id, id)).returning();
  if (!row) return problem(404, "Không tìm thấy camera");
  await audit("camera.update", { targetType: "camera", targetId: id, detail: Object.entries(set).map(([k, v]) => `${k}=${v}`).join(", ") });
  return Response.json(publicCamera(row));
}

/**
 * DELETE — chỉ owner (quyền "delete"), bắt buộc ?confirm=yes.
 * Còn event tham chiếu → 409; thêm &cascade=yes để xoá kèm events (extractions
 * trỏ event đó được gỡ event_id, giữ hàng). Luôn dọn stream go2rtc + gỡ
 * alert_rules.camera_id + assets.camera_id trong cùng transaction.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("delete");
  if (auth.response) return auth.response;
  const id = await paramId(ctx);
  if (!id) return problem(400, "Mã camera không hợp lệ");
  const url = new URL(req.url);
  if (url.searchParams.get("confirm") !== "yes") {
    return problem(400, "Thiếu xác nhận", "Gọi DELETE với ?confirm=yes; nếu còn sự kiện thêm &cascade=yes");
  }
  const scoped = await authorizeResource(auth.session, "camera", id, "write");
  if (!scoped.ok) return scoped.response;
  const cam = scoped.row;

  const [{ c: eventCount }] = await db.select({ c: sql<number>`count(*)::int` }).from(events).where(eq(events.cameraId, id));
  const cascade = url.searchParams.get("cascade") === "yes";
  if (eventCount > 0 && !cascade) {
    return Response.json({ title: "Camera còn sự kiện liên kết", detail: `Còn ${eventCount} sự kiện — gọi lại với &cascade=yes để xoá kèm`, status: 409, events: eventCount }, { status: 409 });
  }

  let streamRemoved = false;
  let warning: string | null = null;
  if (cam.streamName) {
    try {
      await removeGo2rtcStream(cam.streamName);
      streamRemoved = true;
    } catch {
      warning = "Đã xoá camera trong DB nhưng go2rtc chưa gỡ stream — xoá tay trong go2rtc.";
    }
  }

  // T-1340: gỡ path recorder mediaMTX (best-effort như go2rtc — không chặn xoá DB).
  const rec = await removeRecordingPath(cam.streamName ?? `dai_cam_${id}`);
  const recordingRemoved = rec.reachable && !rec.pathExists;
  if (!rec.reachable && (cam.streamName || cam.sourceCiphertext)) {
    warning = [warning, "mediaMTX chưa gỡ path — xoá tay trong mediaMTX."].filter(Boolean).join(" ");
  }

  await db.transaction(async (tx) => {
    if (eventCount > 0) {
      // extractions.asset_id NOT NULL nên giữ hàng — chỉ gỡ con trỏ event trước khi xoá events.
      await tx.update(extractions).set({ eventId: null })
        .where(sql`${extractions.eventId} in (select id from events where camera_id = ${id})`);
      await tx.delete(events).where(eq(events.cameraId, id));
    }
    await tx.update(alertRules).set({ cameraId: null }).where(eq(alertRules.cameraId, id));
    await tx.update(assets).set({ cameraId: null }).where(eq(assets.cameraId, id));
    await tx.delete(cameras).where(eq(cameras.id, id));
  });
  await audit("camera.delete", {
    targetType: "camera",
    targetId: id,
    detail: `${cam.code} · ${cam.name}; events=${eventCount}; cascade=${cascade}; stream=${cam.streamName ?? "-"}`,
  });
  return Response.json({ ok: true, deleted: id, eventsRemoved: eventCount, streamRemoved, recordingRemoved, warning });
}
