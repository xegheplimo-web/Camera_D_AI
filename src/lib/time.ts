// Backend stores UTC; UI presents Asia/Ho_Chi_Minh (UTC+7, no DST).
export const VN_OFFSET_MS = 7 * 3600 * 1000;
export const TZ = "Asia/Ho_Chi_Minh";
import { sql as _sql } from "drizzle-orm";
export const TZSQL = _sql.raw("'Asia/Ho_Chi_Minh'");

export function startOfDayVN(d: Date = new Date()): Date {
  const local = new Date(d.getTime() + VN_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - VN_OFFSET_MS);
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

export function vnHour(d: Date): number {
  return new Date(d.getTime() + VN_OFFSET_MS).getUTCHours();
}

export function fmtTime(d: Date | string): string {
  return new Date(d).toLocaleTimeString("vi-VN", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

export function fmtDateTime(d: Date | string): string {
  return new Date(d).toLocaleString("vi-VN", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("vi-VN", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });
}

export type TimeRange = { start: Date; end: Date; label: string };

/** Parse a Vietnamese time expression. Range is [start, end). */
export function parseRange(q: string, now: Date = new Date()): TimeRange & { explicit: boolean } {
  const s = q.toLowerCase();
  const today = startOfDayVN(now);
  let r: TimeRange | null = null;
  if (/hôm kia/.test(s)) r = { start: addDays(today, -2), end: addDays(today, -1), label: "hôm kia" };
  else if (/hôm qua/.test(s)) r = { start: addDays(today, -1), end: today, label: "hôm qua" };
  else if (/tuần trước/.test(s)) {
    const dow = (new Date(today.getTime() + VN_OFFSET_MS).getUTCDay() + 6) % 7;
    const thisWeek = addDays(today, -dow);
    r = { start: addDays(thisWeek, -7), end: thisWeek, label: "tuần trước" };
  } else if (/tuần này|tuần nay/.test(s)) {
    const dow = (new Date(today.getTime() + VN_OFFSET_MS).getUTCDay() + 6) % 7;
    r = { start: addDays(today, -dow), end: addDays(today, 1), label: "tuần này" };
  } else if (/(\d+)\s*ngày/.test(s)) {
    const n = Math.min(90, parseInt(/(\d+)\s*ngày/.exec(s)![1], 10));
    r = { start: addDays(today, -(n - 1)), end: addDays(today, 1), label: `${n} ngày gần nhất` };
  } else if (/tháng này|tháng nay|30 ngày/.test(s)) {
    r = { start: addDays(today, -29), end: addDays(today, 1), label: "30 ngày gần nhất" };
  } else if (/(\d+)\s*giờ (qua|gần|trước)/.test(s)) {
    const n = Math.min(72, parseInt(/(\d+)\s*giờ/.exec(s)![1], 10));
    r = { start: new Date(now.getTime() - n * 3600000), end: now, label: `${n} giờ qua` };
  }
  const explicit = r !== null || /hôm nay|nay/.test(s);
  if (!r) r = { start: today, end: addDays(today, 1), label: "hôm nay" };

  // part of day refinement
  const base = startOfDayVN(r.start);
  const sameDay = r.end.getTime() - r.start.getTime() <= 86400000;
  if (sameDay) {
    if (/buổi sáng|sáng nay|\bsáng\b/.test(s)) r = { start: new Date(base.getTime() + 5 * 3600000), end: new Date(base.getTime() + 12 * 3600000), label: r.label + " (buổi sáng)" };
    else if (/buổi chiều|chiều nay|\bchiều\b/.test(s)) r = { start: new Date(base.getTime() + 12 * 3600000), end: new Date(base.getTime() + 18 * 3600000), label: r.label + " (buổi chiều)" };
    else if (/buổi tối|tối nay|\btối\b/.test(s)) r = { start: new Date(base.getTime() + 18 * 3600000), end: new Date(base.getTime() + 24 * 3600000), label: r.label + " (buổi tối)" };
  }
  return { ...r, explicit };
}
