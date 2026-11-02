import { db } from "@/db";
import { events, cameras, type AnswerPayload } from "@/db/schema";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { parseRange, fmtDateTime, TZ, TZSQL } from "@/lib/time";
import { thumbMap } from "@/lib/qa";
import { AiError, type JobInput } from "./types";
import type { SessionPayload } from "@/lib/token";

type Scope = { where: SQL; start: Date; end: Date; label: string; camera: string };
export async function reportScope(input: JobInput): Promise<Scope> {
  const range = parseRange(input.question ?? "", new Date(input.asOf));
  range.end = new Date(Math.min(range.end.getTime(), new Date(input.asOf).getTime()));
  const allCams = await db.select().from(cameras);
  const m = /(?:camera|cam)\s*0?(\d+)/i.exec(input.question ?? "");
  const camera = m ? allCams.find((c) => c.code === `CAM-${m[1].padStart(2, "0")}`) : null;
  if (m && !camera) throw new AiError("CAMERA_NOT_FOUND", "Không tìm thấy camera trong yêu cầu.", 404);
  const filters = [gte(events.happenedAt, range.start), lt(events.happenedAt, range.end), eq(events.clientReported, false)];
  if (!input.demoMode) filters.push(sql`${events.source} <> 'demo'`);
  if (camera) filters.push(eq(events.cameraId, camera.id));
  return { where: and(...filters)!, start: range.start, end: range.end, label: range.label, camera: camera ? `${camera.name} – ${camera.location}` : "Tất cả camera" };
}

export async function summaryWorker(input: JobInput) {
  const scope = await reportScope(input);
  const [totals] = await db.select({
    total: sql<number>`count(*)::int`,
    entries: sql<number>`count(*) filter (where ${events.type} = 'person_in')::int`,
    exits: sql<number>`count(*) filter (where ${events.type} = 'person_out')::int`,
    vehicles: sql<number>`count(*) filter (where ${events.type} = 'vehicle')::int`,
    alerts: sql<number>`count(*) filter (where ${events.type} = 'alert')::int`,
    demo: sql<number>`count(*) filter (where ${events.source} = 'demo')::int`,
  }).from(events).where(scope.where);
  const day = sql<string>`to_char(${events.happenedAt} at time zone ${TZSQL}, 'DD/MM')`;
  const daily = await db.select({ label: day, value: sql<number>`count(*) filter (where ${events.type} = 'person_in')::int` }).from(events).where(scope.where).groupBy(day).orderBy(sql`min(${events.happenedAt})`);
  return { scope, totals, daily };
}

export async function evidenceWorker(input: JobInput, session: SessionPayload) {
  const scope = await reportScope(input);
  // Evidence is resolved from DB only. No remote model can invent an event ID.
  const rows = await db.select().from(events).where(scope.where)
    .orderBy(sql`case when ${events.type} = 'alert' or ${events.priority} = 'critical' then 0 else 1 end`, desc(events.happenedAt)).limit(6);
  const thumbs = await thumbMap(session, rows.map((r) => r.assetId));
  return rows.map((r) => ({ eventId: r.id, label: r.label, time: fmtDateTime(r.happenedAt), thumb: r.assetId ? thumbs.get(r.assetId) ?? null : null }));
}

export type MemorySummary = Awaited<ReturnType<typeof summaryWorker>>;
export function buildReport(summary: MemorySummary, evidence: AnswerPayload["evidence"], fallbackReason?: string, role?: SessionPayload["role"]): AnswerPayload {
  const { totals: t, scope, daily } = summary;
  const warnings = [
    "Báo cáo chỉ đọc metadata/sự kiện đã lưu; chưa phân tích lại video gốc hoặc kết luận bất thường bằng thị giác.",
    "Lượt vào/ra là số bản ghi qua vạch, không phải số người duy nhất. Thời gian không có bản ghi không chứng minh camera đã hoạt động liên tục.",
    "Đã loại trừ bản ghi do trình duyệt tự báo chưa được duyệt.",
  ];
  if (fallbackReason) warnings.unshift(fallbackReason);
  if (t.demo > 0) warnings.push(`${t.demo}/${t.total} bản ghi là dữ liệu mẫu (demo), không phải số liệu camera thực.`);
  if (scope.end > new Date()) warnings.push("Khoảng thời gian chưa kết thúc.");
  return {
    short: t.total ? `Đã tổng hợp ${t.total} sự kiện ${scope.label}: ${t.entries} lượt vào, ${t.exits} lượt ra, ${t.vehicles} phương tiện và ${t.alerts} cảnh báo.` : `Chưa đủ dữ liệu để lập báo cáo ${scope.label}. Không có sự kiện hợp lệ trong phạm vi này.`,
    kind: t.total ? "GROUNDED_REPORT" : "INSUFFICIENT_DATA",
    value: t.total,
    details: [
      `Phạm vi: ${fmtDateTime(scope.start)} → ${fmtDateTime(scope.end)} (không gồm mốc cuối) · ${TZ}`,
      `Camera: ${scope.camera}`,
      ...(t.alerts ? [`Có ${t.alerts} cảnh báo đã lưu cần mở bằng chứng để kiểm tra; chưa xác nhận đây là bất thường thực tế.`] : ["Không có bản ghi cảnh báo hợp lệ trong phạm vi; không có nghĩa là không xảy ra bất thường."]),
      `Lượt vào: ${t.entries} · Lượt ra: ${t.exits} · Chênh lệch: ${t.entries - t.exits} (không suy ra số người đang có mặt)`,
    ],
    calculation: { worker: "Memory/SQL", table: "events", aggregation: "COUNT(*) FILTER", filter: { clientReported: false, demoIncluded: t.demo > 0, camera: scope.camera }, range: [scope.start.toISOString(), scope.end.toISOString()], timezone: TZ, totals: t },
    evidence, evidenceCount: t.total, chart: daily,
    nextActions: [{ label: "Mở dữ liệu nguồn", href: `/memory?from=${encodeURIComponent(scope.start.toISOString())}&to=${encodeURIComponent(scope.end.toISOString())}&trust=verified` }, ...(role === "owner" ? [{ label: "Xem tác vụ AI", href: "/admin" }] : [])],
    warnings,
  };
}
