import { db } from "@/db";
import { events, assets, extractions, cameras, type AnswerPayload } from "@/db/schema";
import { and, asc, desc, eq, gte, lt, sql, ilike, or, inArray, type SQL } from "drizzle-orm";
import { parseRange, fmtTime, fmtDateTime, addDays, TZ, TZSQL } from "./time";
import { getSettings } from "./settings";
import { assetReadScope, extractionScope } from "./scope";
import type { SessionPayload } from "./token";

type Metric = {
  key: string;
  noun: string;
  types: string[];
  objectClass?: string;
};

const METRICS: Record<string, Metric> = {
  person_in: { key: "person_in", noun: "lượt khách vào", types: ["person_in"] },
  person_out: { key: "person_out", noun: "lượt ra", types: ["person_out"] },
  motorcycle: { key: "motorcycle", noun: "lượt xe máy", types: ["vehicle"], objectClass: "motorcycle" },
  car: { key: "car", noun: "lượt ô tô", types: ["vehicle"], objectClass: "car" },
  vehicle: { key: "vehicle", noun: "lượt phương tiện", types: ["vehicle"] },
  alert: { key: "alert", noun: "cảnh báo", types: ["alert"] },
  event: { key: "event", noun: "sự kiện", types: [] },
};

export async function thumbMap(session: SessionPayload, assetIds: (number | null)[]) {
  const ids = Array.from(new Set(assetIds.filter((x): x is number => typeof x === "number")));
  const map = new Map<number, string>();
  if (!ids.length) return map;
  const rows = await db.select({ id: assets.id, url: assets.url, kind: assets.kind }).from(assets).where(and(inArray(assets.id, ids), assetReadScope(session)));
  for (const r of rows) map.set(r.id, r.url && !r.url.startsWith("local:") ? r.url : `/api/assets/${r.id}`);
  return map;
}

function detectMetric(s: string): Metric {
  if (/cảnh báo|báo động/.test(s)) return METRICS.alert;
  if (/xe máy|xe gắn máy/.test(s)) return METRICS.motorcycle;
  if (/ô tô|oto|xe hơi/.test(s)) return METRICS.car;
  if (/\bxe\b|phương tiện/.test(s)) return METRICS.vehicle;
  if (/lượt ra|đi ra|\bra\b/.test(s) && !/vào/.test(s)) return METRICS.person_out;
  if (/sự kiện/.test(s)) return METRICS.event;
  return METRICS.person_in;
}

async function detectCamera(s: string): Promise<{ id: number; name: string } | null> {
  const cams = await db.select().from(cameras);
  const m = /camera\s*0?(\d+)|cam\s*0?(\d+)/.exec(s);
  if (m) {
    const n = parseInt(m[1] ?? m[2], 10);
    const c = cams.find((x) => x.code === `CAM-${String(n).padStart(2, "0")}`);
    if (c) return { id: c.id, name: `${c.name} – ${c.location}` };
  }
  const byLoc: [RegExp, string][] = [
    [/cửa/, "CAM-01"],
    [/bãi|sân/, "CAM-02"],
    [/trong nhà|trong cửa hàng/, "CAM-03"],
    [/kho/, "CAM-04"],
  ];
  for (const [re, code] of byLoc) {
    if (re.test(s)) {
      const c = cams.find((x) => x.code === code);
      if (c) return { id: c.id, name: `${c.name} – ${c.location}` };
    }
  }
  return null;
}

function metricWhere(m: Metric, start: Date, end: Date, cameraId?: number, demoCond?: SQL | null) {
  const conds: SQL[] = [gte(events.happenedAt, start), lt(events.happenedAt, end)];
  if (demoCond) conds.push(demoCond);
  if (m.types.length) conds.push(inArray(events.type, m.types));
  if (m.objectClass) conds.push(eq(events.objectClass, m.objectClass));
  if (cameraId) conds.push(eq(events.cameraId, cameraId));
  return and(...conds)!;
}

async function countOf(where: SQL) {
  const [r] = await db.select({ c: sql<number>`count(*)::int` }).from(events).where(where);
  return r.c;
}

const hourExpr = sql<number>`extract(hour from ${events.happenedAt} at time zone ${TZSQL})::int`;

async function hourly(where: SQL) {
  return db
    .select({ h: hourExpr, c: sql<number>`count(*)::int` })
    .from(events)
    .where(where)
    .groupBy(hourExpr)
    .orderBy(hourExpr);
}

function base(short: string, kind: AnswerPayload["kind"]): AnswerPayload {
  return { short, kind, details: [], evidence: [], evidenceCount: 0, nextActions: [], warnings: [] };
}

function memoryLink(params: Record<string, string | number | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  return `/memory?${p.toString()}`;
}

export async function answerQuestion(question: string, session: SessionPayload): Promise<AnswerPayload> {
  const q = question.trim();
  const s = q.toLowerCase();
  if (!q) return base("Bạn hãy nhập hoặc nói câu hỏi nhé.", "HELP");

  if (/^(xin )?chào|^hello|^hi(\s|!|$)|làm được gì|giúp gì|hướng dẫn/.test(s)) {
    const a = base("Xin chào! Mình là D-AI Bot – trợ lý camera của bạn. Mình trả lời dựa trên dữ liệu đã ghi nhận, kèm bằng chứng.", "HELP");
    a.details = [
      "“Hôm nay có bao nhiêu khách, khách đầu tiên lúc mấy giờ?”",
      "“Hôm qua có bao nhiêu xe máy vào bãi?”",
      "“Giờ cao điểm 7 ngày qua là khi nào?”",
      "“Tìm cảnh báo trong kho tuần này”",
      "“Có bao nhiêu ảnh và ghi chú đã lưu?”",
    ];
    a.nextActions = [{ label: "Mở Ảnh & Trích xuất", href: "/extract" }, { label: "Xem camera", href: "/camera" }];
    return a;
  }

  const { demoMode } = await getSettings();
  const demoCond = and(eq(events.clientReported, false), ...(demoMode ? [] : [sql`${events.source} <> 'demo'`]))!;
  const range = parseRange(s);
  const cam = await detectCamera(s);
  const assetScope = assetReadScope(session);
  const exScope = extractionScope(session);

  // --- Memory store counts (assets / notes / extractions) — scoped to this user + shared workspace media
  if (/ảnh đã lưu|bao nhiêu ảnh|số ảnh|ghi chú|trích xuất|video đã lưu|clip/.test(s) && !/tìm/.test(s)) {
    const [img] = await db.select({ c: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.kind, "image"), sql`${assets.origin} <> 'demo'`, assetScope));
    const [vid] = await db.select({ c: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.kind, "video"), assetScope));
    const [ex] = await db.select({ c: sql<number>`count(*)::int`, v: sql<number>`count(*) filter (where ${extractions.status} = 'VERIFIED')::int` }).from(extractions).where(exScope);
    const a = base(`Kho trí nhớ đang có ${img.c} ảnh, ${vid.c} video/clip và ${ex.c} ghi chú trích xuất (${ex.v} đã xác minh).`, "DETERMINISTIC_AGGREGATION");
    a.value = img.c;
    a.details = [`Ảnh do người dùng chụp/tải: ${img.c}`, `Video/clip đã lưu: ${vid.c}`, `Ghi chú trích xuất: ${ex.c}`, `Đã xác minh: ${ex.v} · Tạm: ${ex.c - ex.v}`];
    a.calculation = { aggregation: "COUNT", tables: ["assets", "extractions"], scope: session.role === "owner" ? "all" : "mine+shared", note: "Không tính ảnh mẫu của camera demo" };
    const recent = await db.select().from(extractions).where(exScope).orderBy(desc(extractions.createdAt)).limit(3);
    const tm = await thumbMap(session, recent.map((r) => r.assetId));
    a.evidence = recent.map((r) => ({ extractionId: r.id, label: r.title, time: fmtDateTime(r.createdAt), thumb: tm.get(r.assetId) ?? null }));
    a.evidenceCount = a.evidence.length;
    a.nextActions = [{ label: "Mở Trí nhớ", href: "/memory?tab=notes" }, { label: "Trích xuất ảnh mới", href: "/extract" }];
    return a;
  }

  // --- Search
  const isQuant = /bao nhiêu|mấy (lượt|người|xe|khách)|cao điểm|đông nhất|đầu tiên|gần nhất|tổng/.test(s);
  if (/^tìm|tìm kiếm|xuất hiện|biển số/.test(s) || (/khi nào|lúc nào/.test(s) && !isQuant && !/cao điểm/.test(s))) {
    const stop = new Set(["tìm", "kiếm", "cho", "tôi", "mình", "các", "những", "có", "không", "khi", "nào", "xuất", "hiện", "hôm", "nay", "qua", "tuần", "này", "trong", "lúc", "vào", "ở", "là", "và", "của", "giúp", "ngày", "tháng", "sáng", "chiều", "tối"]);
    const terms = s.replace(/[?.,!"“”]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !stop.has(w)).slice(0, 5);
    const termConds = terms.map((t) => or(ilike(events.label, `%${t}%`), ilike(events.note, `%${t}%`), sql`${events.tags}::text ilike ${"%" + t + "%"}`)!);
    const timeConds: SQL[] = range.explicit ? [gte(events.happenedAt, range.start), lt(events.happenedAt, range.end)] : [];
    if (demoCond) timeConds.push(demoCond);
    if (cam) timeConds.push(eq(events.cameraId, cam.id));
    const where = and(...timeConds, ...(termConds.length ? [or(...termConds)!] : []));
    const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(events).where(where);
    const rows = await db.select().from(events).where(where).orderBy(desc(events.happenedAt)).limit(6);
    const exConds = terms.map((t) => or(ilike(extractions.note, `%${t}%`), ilike(extractions.title, `%${t}%`), sql`${extractions.result}::text ilike ${"%" + t + "%"}`)!);
    const exRows = exConds.length ? await db.select().from(extractions).where(and(or(...exConds), exScope)).orderBy(desc(extractions.createdAt)).limit(4) : [];
    const tm = await thumbMap(session, [...rows.map((r) => r.assetId), ...exRows.map((r) => r.assetId)]);
    if (!c && !exRows.length) {
      const a = base(`Chưa tìm thấy dữ liệu khớp với “${terms.join(" ")}”${range.explicit ? ` trong ${range.label}` : ""}.`, "INSUFFICIENT_DATA");
      a.details = ["Thử từ khóa ngắn hơn (ví dụ: “xe máy”, “cảnh báo”, “kho”).", "Nếu cần trích xuất biển số/văn bản, hãy chụp ảnh và dùng màn Ảnh & Trích xuất."];
      a.nextActions = [{ label: "Mở Trí nhớ", href: "/memory" }, { label: "Trích xuất ảnh", href: "/extract" }];
      return a;
    }
    const a = base(`Tìm thấy ${c} sự kiện${exRows.length ? ` và ${exRows.length} ghi chú trích xuất` : ""} khớp “${terms.join(" ")}”${range.explicit ? ` (${range.label})` : ""}.`, "SEARCH");
    a.value = c;
    a.details = rows.slice(0, 4).map((r) => `${fmtDateTime(r.happenedAt)} — ${r.label}`);
    for (const e of exRows) a.details.push(`Ghi chú: ${e.title} (${e.status === "VERIFIED" ? "đã xác minh" : "chưa xác minh"})`);
    a.evidence = [
      ...rows.slice(0, 4).map((r) => ({ eventId: r.id, label: r.label, time: fmtTime(r.happenedAt), thumb: r.assetId ? tm.get(r.assetId) ?? null : null })),
      ...exRows.slice(0, 2).map((r) => ({ extractionId: r.id, label: r.title, time: fmtDateTime(r.createdAt), thumb: tm.get(r.assetId) ?? null })),
    ];
    a.evidenceCount = c + exRows.length;
    a.calculation = { aggregation: "FULL_TEXT_MATCH", terms, range: range.explicit ? [range.start.toISOString(), range.end.toISOString()] : "toàn bộ" };
    a.nextActions = [{ label: "Xem tất cả trong Trí nhớ", href: memoryLink({ q: terms.join(" ") }) }];
    return a;
  }

  const metric = detectMetric(s);
  const where = metricWhere(metric, range.start, range.end, cam?.id, demoCond);
  const scope = `${range.label}${cam ? ` tại ${cam.name}` : ""}`;

  // Is there any data at all in range? (to distinguish "0" from "unknown")
  const anyWhere = and(gte(events.happenedAt, range.start), lt(events.happenedAt, range.end), ...(cam ? [eq(events.cameraId, cam.id)] : []), ...(demoCond ? [demoCond] : []))!;
  const anyCount = await countOf(anyWhere);
  if (anyCount === 0) {
    const a = base(`Chưa xác định được: không có dữ liệu camera nào được ghi nhận trong ${scope}.`, "INSUFFICIENT_DATA");
    a.details = ["Có thể camera chưa bật, đang offline hoặc khoảng thời gian nằm ngoài lịch sử lưu trữ.", "Mình không đoán số khi không có dữ liệu nguồn."];
    a.nextActions = [{ label: "Kiểm tra camera", href: "/camera" }];
    a.calculation = { aggregation: "COUNT", table: "events", range: [range.start.toISOString(), range.end.toISOString()], result: "no_rows" };
    return a;
  }

  // --- Occupancy / net flow
  if (/hiện tại|đang có|còn bao nhiêu|chênh lệch|trong cửa hàng|trong phòng/.test(s)) {
    const inC = await countOf(metricWhere(METRICS.person_in, range.start, range.end, cam?.id, demoCond));
    const outC = await countOf(metricWhere(METRICS.person_out, range.start, range.end, cam?.id, demoCond));
    const net = Math.max(0, inC - outC);
    const a = base(`Ước lượng còn khoảng ${net} người bên trong (${inC} vào − ${outC} ra, ${scope}).`, "DETERMINISTIC_AGGREGATION");
    a.value = net;
    a.details = [`Lượt vào: ${inC}`, `Lượt ra: ${outC}`, `Chênh lệch: ${inC - outC}`];
    a.warnings = ["Đây là ước lượng từ chênh lệch vào/ra, không phải số người duy nhất. Nếu có lối đi khác hoặc đếm sót, kết quả có thể lệch."];
    a.calculation = { aggregation: "COUNT(in) - COUNT(out)", table: "events", range: [range.start.toISOString(), range.end.toISOString()], timezone: TZ };
    a.nextActions = [{ label: "Xem camera trực tiếp", href: "/camera" }];
    return a;
  }

  const total = await countOf(where);
  const hours = await hourly(where);
  const first = await db.select().from(events).where(where).orderBy(asc(events.happenedAt)).limit(1);
  const last = await db.select().from(events).where(where).orderBy(desc(events.happenedAt)).limit(1);
  let peak: { h: number; c: number } | null = null;
  for (const h of hours) if (!peak || h.c > peak.c) peak = h;

  const a = base("", "DETERMINISTIC_AGGREGATION");
  a.value = total;
  a.chart = hours.map((h) => ({ label: `${String(h.h).padStart(2, "0")}h`, value: h.c }));
  a.calculation = {
    aggregation: "COUNT",
    table: "events",
    filter: { type: metric.types.length ? metric.types : "*", objectClass: metric.objectClass ?? "*", camera: cam?.name ?? "tất cả" },
    range: `[${fmtDateTime(range.start)}, ${fmtDateTime(range.end)})`,
    timezone: TZ,
    trust: "Chỉ bản ghi máy chủ hoặc đã được người dùng duyệt; loại clientReported=true",
  };

  const askFirst = /đầu tiên|sớm nhất/.test(s);
  const askLast = /gần nhất|cuối cùng|mới nhất|muộn nhất/.test(s);
  const askPeak = /cao điểm|đông nhất|nhiều nhất/.test(s);

  if (total === 0) {
    a.short = `Không có ${metric.noun} nào trong ${scope}.`;
    a.details = [`Hệ thống vẫn ghi nhận ${anyCount} sự kiện khác trong khoảng này, nên con số 0 là có căn cứ.`];
  } else {
    const parts = [`${scope.charAt(0).toUpperCase() + scope.slice(1)} có ${total} ${metric.noun}.`];
    if (askFirst && first[0]) parts.push(`Đầu tiên lúc ${fmtTime(first[0].happenedAt)}.`);
    if (askLast && last[0]) parts.push(`Gần nhất lúc ${fmtTime(last[0].happenedAt)}.`);
    if (askPeak && peak) parts.push(`Cao điểm ${String(peak.h).padStart(2, "0")}:00–${String(peak.h + 1).padStart(2, "0")}:00 (${peak.c} lượt).`);
    a.short = parts.join(" ");
    a.details = [`Tổng ${metric.noun}: ${total}`];
    if (first[0]) a.details.push(`Thời gian đầu tiên: ${fmtTime(first[0].happenedAt)}${range.end.getTime() - range.start.getTime() > 86400000 ? ` (${fmtDateTime(first[0].happenedAt)})` : ""}`);
    if (last[0]) a.details.push(`Thời gian gần nhất: ${fmtTime(last[0].happenedAt)}${range.end.getTime() - range.start.getTime() > 86400000 ? ` (${fmtDateTime(last[0].happenedAt)})` : ""}`);
    if (peak) a.details.push(`Giờ cao điểm: ${String(peak.h).padStart(2, "0")}:00 – ${String(peak.h + 1).padStart(2, "0")}:00 (${peak.c} lượt)`);
  }

  // comparison with previous equal-length period
  const span = range.end.getTime() - range.start.getTime();
  if (span <= 86400000 * 31) {
    const prevStart = new Date(range.start.getTime() - span);
    const prev = await countOf(metricWhere(metric, prevStart, range.start, cam?.id, demoCond));
    const label = span === 86400000 ? "hôm trước" : "kỳ trước";
    const diff = total - prev;
    a.details.push(`So với ${label}: ${prev} (${diff >= 0 ? "+" : ""}${diff})`);
    if (range.end > new Date()) a.warnings.push("Khoảng thời gian chưa kết thúc — so sánh với kỳ trước có thể chưa tương đương.");
  }

  // evidence: first, middle, last
  if (total > 0) {
    const mid = await db.select().from(events).where(where).orderBy(asc(events.happenedAt)).offset(Math.floor(total / 2)).limit(1);
    const ev = [first[0], mid[0], last[0]].filter(Boolean);
    const uniq = ev.filter((e, i) => ev.findIndex((x) => x.id === e.id) === i);
    const tm = await thumbMap(session, uniq.map((e) => e.assetId));
    a.evidence = uniq.map((e) => ({ eventId: e.id, label: e.label, time: fmtTime(e.happenedAt), thumb: e.assetId ? tm.get(e.assetId) ?? null : null }));
    a.evidenceCount = total;
  }
  const clientReported = await db.select({ c: sql<number>`count(*)::int` }).from(events).where(and(where, eq(events.clientReported, true)));
  if (clientReported[0].c > 0) a.warnings.push(`${clientReported[0].c}/${total} bản ghi do trình duyệt tự báo (nhận diện phía client) — chưa được người dùng xác minh.`);
  if (!demoMode) a.details.push("Chế độ thực: đã loại trừ toàn bộ dữ liệu mẫu.");
  const demo = await db.select({ c: sql<number>`count(*)::int` }).from(events).where(and(where, eq(events.source, "demo")));
  if (demo[0].c > 0) a.warnings.push(`${demo[0].c}/${total} bản ghi là dữ liệu mẫu (demo). Có thể xóa trong Cài đặt.`);

  a.nextActions = [
    { label: "Xem bằng chứng trong Trí nhớ", href: memoryLink({ type: metric.types[0], from: range.start.toISOString(), to: range.end.toISOString(), camera: cam?.id }) },
    { label: "Xem thống kê", href: "/stats" },
  ];
  void addDays;
  return a;
}
