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
