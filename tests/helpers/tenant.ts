/**
 * Bảo đảm tenant mặc định (id=1) tồn tại trước khi fixture ghi hàng tenant-scoped.
 * DB dựng bằng `drizzle-kit push` không chạy seed của migrations/008 (slug 'default'),
 * trong khi camera_settings/knowledge_* có FK → tenants(id) và mọi bảng tenant-scoped
 * default tenant_id=1. Idempotent: gọi bao nhiêu lần cũng được; setval sequence để
 * tenant tạo sau không cướp id=1 (fixture "tenant 2" trúng id=1 sẽ phá cross-tenant).
 */
import { sql } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants } from "../../src/db/schema";

export async function ensureDefaultTenant(): Promise<void> {
  await db.insert(tenants).values({ id: 1, slug: "default", name: "Default tenant" }).onConflictDoNothing({ target: tenants.id });
  await db.execute(sql`select setval(pg_get_serial_sequence('tenants','id'), greatest(1, (select coalesce(max(id),1) from tenants)))`);
}

/**
 * Chặn suite phá huỷ chạy nhầm vào DB dev dùng chung.
 * RED-phase của H-01c đã từng gọi reset_all bản chưa sửa và xoá sạch `app_db` local.
 * CI (env CI=true) dùng service postgres riêng nên bỏ qua guard; local muốn chạy
 * trên DB dev phải khai báo tường minh ALLOW_DESTRUCTIVE_TEST=1.
 */
export function assertDestructiveTestDb(): void {
  const url = process.env.DATABASE_URL ?? "";
  const name = (() => {
    try { return new URL(url).pathname.replace(/^\//, ""); } catch { return ""; }
  })();
  if (process.env.CI) return;
  if (process.env.ALLOW_DESTRUCTIVE_TEST === "1") return;
  if (name && /(^|_)(test|ci|e2e|scratch)$/.test(name)) return;
  throw new Error(
    `Suite này gọi reset_all (xoá dữ liệu). DATABASE_URL đang trỏ DB "${name || "?"}" — ` +
      `hãy dùng DB test riêng, hoặc đặt ALLOW_DESTRUCTIVE_TEST=1 nếu thật sự muốn chạy trên DB này.`
  );
}
