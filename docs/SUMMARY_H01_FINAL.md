# TỔNG HỢP H-01 — Báo cáo cho Sếp (2026-11-04)

**Repo:** https://github.com/xegheplimo-web/Camera_D_AI · **HEAD:** `0c26575` · **Nhánh:** `main`
**Trạng thái H-01:** STOP / NOT ACCEPTED — chưa được phép công bố DONE.

---

## 1. Một câu tóm tắt

Code H-01 đã merge nhưng **tenant isolation chưa được chứng minh**; đồng thời quá trình phản biện phát hiện **2 lỗ hổng cross-tenant đang sống trên HEAD** mà cả brief gửi GPT lẫn báo cáo tiến độ trước đó đều bỏ sót. Gate giữ đỏ là đúng.

---

## 2. Rủi ro đang tồn tại (đã đo, không phải suy đoán)

### 2.1 Rủi ro P0 — phơi nhiễm ngay

| # | Vấn đề | Bằng chứng | Ảnh hưởng |
|---|---|---|---|
| R1 | `GET /api/alerts` không lọc tenant khi đọc `events`, `cameras`, `alertRules` | `src/app/api/alerts/route.ts:20–24` | User tenant A thấy toàn bộ cảnh báo + tên/vị trí camera + quy tắc của tenant B |
| R2 | `POST /api/alerts {all:true}` ack **mọi** event chưa ack của toàn hệ thống | `alerts/route.ts:55` | Tenant A xóa dấu cảnh báo của tenant B và ghi `ackBy = tên A` vào dữ liệu B — sai lệch dữ liệu |
| R3 | Ack theo `ids[]` không kiểm tra tenant (IDOR) | `alerts/route.ts:60` | Đoán ID là thao tác được trên dữ liệu tenant khác |
| R4 | Toggle/delete `alertRules` theo ID không kiểm tra tenant | `alerts/route.ts:89,91,96` | Xóa/tắt quy tắc cảnh báo của tenant khác |
| R5 | App runtime kết nối DB bằng **superuser** | `.env:2` → `postgresql://postgres:***@…` | **Bật RLS bây giờ = vô nghĩa**; superuser bypass sạch. Đây là lý do không được hạ H-01a xuống P1 |
| R6 | `app_rw` không tồn tại, `pg_policies` = 0 | `psql` catalog | Không có lớp bảo vệ DB nào cả |
| R7 | Harness test có thể chạy trên artifact cũ | `tests/h01d-read-paths.test.ts:98–102` | Không chỉ false-FAIL mà còn có thể **false-PASS** — bằng chứng an toàn giả |

### 2.2 Rủi ro P1 — sai lệch dữ liệu / vận hành

| # | Vấn đề | Bằng chứng |
|---|---|---|
| R8 | `audit_log` có `tenant_id` nhưng **2858/2858 hàng NULL** (100%) | `select count(*) filter (where tenant_id is null)` |
| R9 | `auth.login` ghi audit trước khi set cookie mới → tenant lấy từ cookie cũ | `auth/login/route.ts:72` (audit) trước `:74` (Set-Cookie) + `lib/audit.ts:6–17` — *line ref hiệu chỉnh 2026-11-04 sau phản biện GPT R3* |
| R10 | `app_settings` là bảng **toàn cục** (không có `tenant_id`) | `src/db/schema.ts:63–67`; admin A đổi setting ảnh hưởng mọi tenant |
| R11 | `audit()` nuốt mọi exception → audit có thể mất hoàn toàn mà action vẫn thành công | `src/lib/audit.ts:20–24` |

### 2.3 Rủi ro P2 — độ tin cậy bằng chứng

- 5 suite `tests/h01*.test.ts` tồn tại nhưng **không nằm trong CI** (`grep -c h01 .github/workflows/ci.yml` → 0).
- CI dùng `npx drizzle-kit push` chứ không chạy file migration → không thể bảo đảm role/policy tồn tại ở môi trường thật.
- Tài liệu `38_H01CF_ACCEPTANCE.md` ghi H-01d/e "chưa làm" trong khi #58 đã merge cả hai → tài liệu lệch thực tế.

---

## 3. Đường đi tới Gate xanh (thứ tự đã chốt)

Thứ tự dưới đây **khác** đề xuất của GPT: GPT đặt CI lên bước 01; Hermes đặt việc vá leak đã xác nhận lên trước, vì đó là rủi ro đang phơi nhiễm thật, còn CI chỉ là công cụ chứng minh.

| Bước | Việc | Mức | Vì sao ở đây |
|---|---|---|---|
| **P0-1** ✅ **DONE** | Vá `/api/alerts`: thêm predicate tenant vào **cả 5 đường** (GET, ack-all, ack-by-id, rule toggle/delete, **rule create — hiện ghi vào `default(1)`**) | P0 | Đã vá + có CI gate: `tests/h01-alerts-tenant.test.ts` RED 6/6 trên code cũ → GREEN 6/6 sau vá; `npm run test:h01` chạy trong job `test-e2e` (`SKIP_BUILD=1`) |
| **P0-1b** ✅ **DONE** | Chặn `app_settings` cross-tenant: chọn nhánh **platform-global** — `app_settings` giữ nguyên là bảng toàn cục, chỉ tenant nền tảng (`PLATFORM_TENANT_ID = 1`) được PATCH; tenant khác fail-closed 403 + audit `settings.update.denied` | P0 | Đã vá + có CI gate: `tests/h01-settings-tenant.test.ts` RED 1/2 (owner tenant B PATCH → 200) trên code cũ → GREEN 2/2 sau vá; `npm run test:h01` chạy cả alerts + settings trong job `test-e2e` |
| **P0-2** | Đưa 5 suite H-01 vào CI qua `npm run test:h01`; sửa harness `BUILD_ID` (build một lần ở workflow, test đọc artifact vừa build) | P0 | Không có regression gate thì mọi bản vá sau đều không có bảo vệ |
| **P0-3** | Phân loại 12 route còn lại (tenant-owned / user-owned / global / stateless); miễn trừ 3 route đã đúng | P0 | Tránh sửa mù; `assets/[id]`, `cameras/[id]/stream`, `jobs/[id]` đã kiểm soát qua `authorizeResource`/`getJob` |
| **P0-4** | H-01a đúng thứ tự: (1) tạo `app_rw` không superuser/BYPASSRLS → (2) đổi `DATABASE_URL` của app → (3) bật RLS + `SET LOCAL` trong transaction | P0 | Đảo (2) và (3) tạo cảm giác an toàn giả |
| **P1-5** | Sửa audit attribution khi login + viết `tests/h01e-memory-worker.test.ts` chuyên dụng + đồng bộ tài liệu 38 | P1 | Audit là bằng chứng truy vết; sai attribution làm hỏng chính bằng chứng đó |

**Nguyên tắc RED-first:** RED phải chứng minh một hợp đồng/hành vi *chưa đạt*. Với route đã bảo vệ đúng, không được dựng lỗi giả để ép test đỏ — dùng **mutation test** (bỏ predicate tenant → assertion phải đỏ) để chứng minh test thực sự bắt được regression.

---

## 4. Chỗ Hermes phải tự nhận sai

Phương pháp kiểm kê route bằng `grep tenantIdOf` là **sai**. Ba route sau kiểm soát tenant gián tiếp và **không được sửa**:

- `src/app/api/assets/[id]/route.ts:10` → `authorizeResource(auth.session, "asset", id)`
- `src/app/api/cameras/[id]/stream/route.ts:12` → `authorizeResource(auth.session, "camera", id)`
- `src/app/api/jobs/[id]/route.ts:21–22` → `getJob(id, auth.session)` + `extractionScope(auth.session)`

Con số "24 route thiếu `tenantIdOf`" chỉ là **danh sách cần kiểm tra**, không phải 24 lỗ hổng. Trong đó 2 lỗ hổng đã xác nhận thật (`alerts`, và tác động cấu hình của `settings`).

---

## 5. Phép đo tái lập (chạy lại được bất kỳ lúc nào)

```bash
cd F:/Camera-D-AI/publish/Camera_D_AI

grep -c "h01" .github/workflows/ci.yml                                   # 0  → suite không chạy trong CI

docker exec camdai-pg psql -U postgres -d app_db -t -c \
  "select count(*) from pg_roles where rolname='app_rw';"                # 0  → role chưa tồn tại
docker exec camdai-pg psql -U postgres -d app_db -t -c \
  "select count(*) from pg_policies where schemaname='public';"          # 0  → RLS chưa bật

grep DATABASE_URL .env                                                   # postgresql://postgres:***@… → superuser

docker exec camdai-pg psql -U postgres -d app_db -t -c \
  "select count(*) filter (where tenant_id is null) || '/' || count(*) from audit_log;"   # 2858/2858
```

---

## 6. Trạng thái được phép công bố (chính xác)

| Hạng mục | Trạng thái |
|---|---|
| H-01b / c / d / f / g | Merged — **chưa đủ CI regression evidence** |
| H-01e | Implemented — **verification incomplete** |
| H-01a | **Not implemented** |
| P0-1 `/api/alerts` (5 đường) | **DONE** — cross-tenant READ/mass-WRITE/IDOR/create-default-tenant đã bịt; suite RED→GREEN 6/6 |
| Tenant route inventory | **Incomplete** — 1 bề mặt leak còn lại (`app_settings`: config control); **17** route chưa phân loại (đo lại tại HEAD `bad862d`, không phải 12) |
| H-02a backup/restore | Drill PASS quy mô mẫu (141 KB) — chưa chứng minh quy mô production |
| **H-01 overall** | **STOP / NOT ACCEPTED** |

---

## 7. Điều kiện duy nhất để chuyển ACCEPTED

1. Đúng SHA được nghiệm thu (không phải "PR đã merge").
2. Runtime của app không chạy bằng role bypass RLS — xác nhận bằng `pg_stat_activity` + role attributes, không bằng suy luận.
3. Ma trận tenant A/B chạy trên **mọi** tenant-owned path, gồm cả đường đọc file/redirect/stream (PostgreSQL không bảo vệ được các đường này).
4. 5 suite H-01 thực thi trong CI trên đúng SHA đó, có RED/GREEN evidence thật.
5. `38_H01CF_ACCEPTANCE.md` khớp với kết quả đo, không còn card DONE thiếu test.

Thiếu bất kỳ điều nào → vẫn STOP.

---

## 8. Tài liệu liên quan

| File | Nội dung |
|---|---|
| `docs/DECISIONS.md` §D-007, §D-008 | Quyết định từ chối roadmap GPT + áp dụng roadmap ưu tiên rủi ro |
| `docs/H01_REBUTTAL_AND_PRIORITY_2026-11-04.md` | Phản biện chi tiết + thứ tự ưu tiên + phép đo |
| `docs/discussions/GPT-REVIEW-H01-2026-11-04.md` | Toàn văn phản biện của GPT (dữ liệu tham chiếu) |
| `docs/KNOWN_ISSUES.md` | Danh sách issue mở tại thời điểm audit |
