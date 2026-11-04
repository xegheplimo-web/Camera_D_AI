# H-01 — Hermes phản biện GPT bằng bằng chứng đo được + thứ tự ưu tiên chốt

> Ngày: 2026-11-04 · HEAD: `0c26575` · Nhánh: `main` · Working tree: sạch
> Nguồn đối chiếu: `docs/discussions/GPT-REVIEW-H01-2026-11-04.md` (13.359 ký tự, GPT trả lời trong 5m45s)
> Nguyên tắc: mỗi kết luận dưới đây gắn với một phép đo có thể chạy lại. Không có "cảm giác an toàn".

---

## 1. Kết luận điều hành

**STOP GATE giữ nguyên. H-01 = STOP / NOT ACCEPTED.**

Nhưng thứ tự ưu tiên của GPT bị sai ở một điểm quan trọng: **trên HEAD hiện tại có ít nhất 2 lỗ hổng cross-tenant đã xác nhận, không phải chỉ "cần kiểm tra".** Việc đưa CI plumbing lên bước 01 trong khi một endpoint còn mass-update được dữ liệu của mọi tenant là tối ưu hóa sai chỗ. Sửa lỗ hổng đã xác nhận trước, CI sau — nhưng cả hai đều thuộc P0.

Bằng chứng mới do Hermes tự đo, không có trong brief gửi GPT:

| # | Phát hiện | File:dòng | Mức |
|---|---|---|---|
| N1 | `GET /api/alerts` đọc `events`, `cameras`, `alertRules` **không lọc tenant** — user tenant A thấy alert + tên/vị trí camera + rule của tenant B | `src/app/api/alerts/route.ts:20–24` | **P0 — cross-tenant READ** |
| N2 | `POST /api/alerts {all:true}` ack **toàn bộ** event chưa ack của mọi tenant, và ghi `ackBy = tên user tenant A` vào hàng của tenant B | `src/app/api/alerts/route.ts:55` | **P0 — cross-tenant WRITE + data contamination** |
| N3 | `POST /api/alerts {ids:[...]}` ack theo ID không kiểm tra tenant → IDOR | `src/app/api/alerts/route.ts:60` | **P0 — IDOR** |
| N4 | `PUT /api/alerts` toggle/delete `alertRules` theo ID không kiểm tra tenant | `src/app/api/alerts/route.ts:89,91,96` | **P0 — cross-tenant WRITE** |
| N4b | `PUT /api/alerts {action:"create"}` **không ghi `tenantId`** → rơi về default `1`; owner tenant B tạo rule lại ghi vào tenant 1 | `src/app/api/alerts/route.ts:73–84`; `src/db/schema.ts:257–259` (`default(1)`) | **P0 — cross-tenant WRITE** *(GPT R3 bắt; Hermes xác nhận)* |
| N5 | `app_settings` là bảng **toàn cục** (`key` là PK, không có `tenant_id`); `getSettings()` đọc toàn bộ bảng; `PATCH /api/settings` chỉ cần `authorize("manage")` → owner tenant A đổi setting ảnh hưởng mọi tenant | `src/db/schema.ts:63–67`, `src/lib/settings.ts:19–29`, `src/app/api/settings/route.ts:17–36` | **P0 — cross-tenant CONFIG CONTROL** *(nâng từ P1 theo GPT R3; Hermes xác nhận)* |
| N6 | `audit_log` có cột `tenant_id` nhưng **2858/2858 hàng đều NULL** (100%, không phải "legacy") | `psql: select count(*) ... where tenant_id is null` | **P1 — admin audit panel rỗng ở mọi tenant** |
| N7 | Không có `app_rw`, không có RLS, **và app runtime kết nối bằng superuser** (`DATABASE_URL=postgresql://postgres:***@127.0.0.1:5432/app_db`) | `.env:2`; `pg_roles`; `pg_policies` | **P0 — RLS sẽ bị bypass nếu chỉ bật RLS** |

N7 là điểm quan trọng nhất: GPT nói phép đo psql trong container *chưa chứng minh* credential của app. Hermes đã đọc `.env` của chính app → app chạy bằng `postgres` superuser. Vì superuser bypass RLS hoàn toàn, **bật RLS mà không đổi credential là vô nghĩa**. Đây là lý do C3 phải giữ nguyên độ mạnh P0, không được hạ xuống MODIFY như GPT đề nghị.

---

## 2. Bảng phản biện C1–C6

| Claim gốc của Hermes | GPT verdict | Hermes verdict sau khi đo lại | Bằng chứng |
|---|---|---|---|
| C1 — 5 suite H-01 ngoài CI là khiếm khuyết ưu tiên số 1 | MODIFY | **MODIFY (đồng ý một phần)** — vẫn là P0 Verification, nhưng không phải P0 *đầu tiên* vì đã có lỗ hổng sống | `ci.yml:114–118` chạy vòng lặp 22 script; `python -c "…scripts… if 'h01'"` → `NONE`; 5 file `tests/h01*.test.ts` tồn tại nhưng không nằm trong graph |
| C2 — H-01e nên đóng ở trạng thái code done, test pending | MODIFY | **KEEP** — trạng thái đúng là IMPLEMENTED / VERIFICATION INCOMPLETE | `memory-worker.ts:11–20` fail-closed + predicate tenant; không có `tests/h01e-memory-worker.test.ts`; 4 assertion nằm trong `h01d-read-paths.test.ts` mà suite này không chạy trong CI |
| C3 — H-01a phải là P0 tiếp theo | MODIFY | **KEEP ở mức P0 đầy đủ — phản bác MODIFY của GPT** | `pg_roles` = 0 hàng `app_rw`; `pg_policies` = 0; `grep app_rw` toàn repo = 0; `grep "SET LOCAL" src/` = 0; `.env` chứng minh runtime dùng `postgres` superuser |
| C4 — 15 route thiếu predicate nên xử lý theo lô | KEEP | **MODIFY — phương pháp của GPT đúng, kết luận "chỉ là danh sách cần kiểm tra" sai một nửa** | GPT đúng: `assets/[id]:10`, `cameras/[id]/stream:12`, `jobs/[id]:21` đều gọi `authorizeResource`/`getJob`. Nhưng `alerts/route.ts` là **leak thật, không phải "cần kiểm tra"** (N1–N4) |
| C5 — PR #44 licensing ngoài roadmap kỹ thuật | KEEP | **KEEP** | Không có phụ thuộc kỹ thuật nào từ #44 |
| C6 — phải viết lại bảng trạng thái tài liệu 38 trước khi tuyên bố | MODIFY | **MODIFY (đồng ý với GPT)** — sửa tài liệu là điều kiện để tuyên bố DONE, không phải điều kiện để bắt đầu sửa lỗi | `38_H01CF_ACCEPTANCE.md` đánh dấu H-01d/H-01e chưa làm trong khi #58 đã merge cả hai |

### Chỗ Hermes phải tự nhận sai

Phương pháp grep `tenantIdOf` là **sai**. Ba route GPT chỉ ra thực sự có kiểm soát gián tiếp:

- `src/app/api/assets/[id]/route.ts:10` → `authorizeResource(auth.session, "asset", id)`
- `src/app/api/cameras/[id]/stream/route.ts:12` → `authorizeResource(auth.session, "camera", id)`
- `src/app/api/jobs/[id]/route.ts:21` → `getJob(id, auth.session)` + `extractionScope(auth.session)` ở dòng 22

Không được sửa ba file này. Chúng đã đúng.

### Chỗ GPT phải nhận sai

GPT kết luận C3 chỉ nên MODIFY vì "chưa chứng minh credential runtime". Bằng chứng `.env` đã chứng minh: app dùng `postgres` superuser. Không những RLS chưa bật — **nếu bật RLS ngay bây giờ, superuser sẽ bypass sạch**. Vì vậy:

1. Tạo `app_rw` (không superuser, không BYPASSRLS).
2. Đổi `DATABASE_URL` của app sang `app_rw`.
3. **Sau đó** mới bật RLS + `SET LOCAL`.

Đảo thứ tự 2 và 3 sẽ tạo cảm giác an toàn giả.

---

## 3. Thứ tự ưu tiên chốt (khác GPT ở bước đầu)

### P0-1 — Vá leak `/api/alerts` ngay (rẻ nhất, rủi ro cao nhất)

Đây là việc Hermes đặt **trước** bước CI của GPT. Lý do: một lỗi mass-write cross-tenant đang sống trên production HEAD; sửa nó là một file, vài dòng, rủi ro thấp. CI plumbing không làm giảm rủi ro này một giây nào.

RED-first: `tests/h01-alerts-tenant.test.ts`
Assertion (phải RED trên HEAD):
- Tenant A `GET /api/alerts` không thấy event/camera/rule của tenant B.
- Tenant A `POST {all:true}` không thay đổi `ack_at` của bất kỳ hàng nào thuộc tenant B.
- Tenant A `POST {ids:[id_của_B]}` trả 404 và không UPDATE hàng của B.
- Tenant A `PUT {action:"toggle"|"delete", id:rule_của_B}` trả 404.

Nghiệm thu:
```bash
npm run build
node --import tsx --test tests/h01-alerts-tenant.test.ts
```

### P0-1b — Chặn `app_settings` cross-tenant (blocker thứ hai, GPT R3 bổ sung)

`PATCH /api/settings` hiện cho phép `owner`/`operator` của bất kỳ tenant nào đổi bảng cấu hình **toàn cục** (`app_settings` không có `tenant_id`; `getSettings()` đọc cả bảng). Đây là **cross-tenant configuration control**, không phải vấn đề tài liệu: tenant A đổi `remoteProcessingAllowed`/`remotePlayback`/`retentionDays` → thay đổi hành vi xử lý dữ liệu của tenant B.

Phải quyết định rõ quyền sở hữu trước khi sửa:
- Nếu `app_settings` là **platform-global**: chỉ platform administrator được PATCH; owner tenant bị 403.
- Nếu là **tenant-local**: thêm `tenant_id` vào bảng + mọi đọc/ghi phải scoped.

Không được đồng nhất "owner của một tenant" với "administrator của toàn nền tảng".

RED-first: `tests/h01-settings-tenant.test.ts` — owner tenant B PATCH → 403 (global) hoặc chỉ ảnh hưởng hàng của tenant B (local); `getSettings(tenant B)` không trả giá trị do tenant A đặt.

### P0-2 — Đưa 5 suite H-01 vào CI + `test:h01` (theo GPT bước 01)

Bao gồm sửa lỗi harness `BUILD_ID` (`h01d-read-paths.test.ts:98–102` chỉ build khi artifact thiếu → có thể chạy trên code cũ). Chuẩn hóa: build một lần ở workflow, test chỉ đọc artifact vừa build.

RED-first: `tests/h01-ci-contract.test.ts` — `missingSuites.length === 0`.

### P0-3 — Phân loại + kiểm chứng 12 route còn lại

Sau khi trừ 3 route đã xác nhận đúng (`assets/[id]`, `cameras/[id]/stream`, `jobs/[id]`), 12 route còn lại phải phân loại tenant-owned / user-owned / global / stateless. `alerts` đã xử lý ở P0-1. `settings` là quyết định kiến trúc (N5): hoặc chấp nhận global settings và ghi rõ, hoặc thêm `tenant_id`.

### P0-4 — H-01a: `app_rw` → đổi credential → RLS + `SET LOCAL`

Theo đúng thứ tự 1-2-3 ở trên. RED-first: `tests/h01a-rls.test.ts`.

Điểm chặn: CI dùng `npx drizzle-kit push`, không chạy file migration. `migrations/014_app_role.sql` không tồn tại (dãy là 003–013, 015). Vì vậy role/policy phải được tạo bằng migration thật và verify bằng catalog query, không bằng "file tồn tại".

### P1-5 — Audit attribution khi login + H-01e dedicated test

`auth.login` ghi audit trước khi cookie mới được set → `tenant_id` lấy từ cookie cũ (NULL hoặc tenant A). 2858/2858 hàng NULL hiện tại là bằng chứng định lượng. Vị trí chính xác tại HEAD `3a4389e`: audit ở `auth/login/route.ts:72`, Set-Cookie ở `:74` *(hiệu chỉnh sau phản biện GPT R3 — bản trước ghi sai 85–87)*. RED-first: `tests/h01g-login-attribution.test.ts`.

---

## 4. Phép đo tái lập được (chạy lại bất kỳ lúc nào)

```bash
cd F:/Camera-D-AI/publish/Camera_D_AI

# 1. CI có chạy suite H-01 không?
grep -c "h01" .github/workflows/ci.yml            # 0

# 2. DB có role/RLS chưa?
docker exec camdai-pg psql -U postgres -d app_db -t -c \
  "select count(*) from pg_roles where rolname='app_rw';"          # 0
docker exec camdai-pg psql -U postgres -d app_db -t -c \
  "select count(*) from pg_policies where schemaname='public';"    # 0

# 3. Credential runtime của app
grep DATABASE_URL .env                            # postgresql://postgres:***@...

# 4. Audit log có bao nhiêu hàng không tenant?
docker exec camdai-pg psql -U postgres -d app_db -t -c \
  "select count(*) filter (where tenant_id is null) || '/' || count(*) from audit_log;"  # 2858/2858

# 5. Route không có tenantIdOf/withTenant
for f in $(find src/app/api -name route.ts); do grep -q "tenantIdOf\|withTenant" "$f" || echo "$f"; done | wc -l   # 24
```

---

## 5. Trạng thái được phép công bố

| Hạng mục | Trạng thái |
|---|---|
| H-01b / H-01c / H-01d / H-01f / H-01g | Merged — **chưa đủ CI regression evidence** |
| H-01e | Implemented — **verification incomplete** |
| H-01a | **Not implemented** |
| Tenant route inventory | **Incomplete** — 2 leak xác nhận (`alerts`, `settings` config impact), 12 chưa phân loại |
| H-02a backup/restore | Drill PASS ở quy mô mẫu (141 KB) — chưa chứng minh quy mô production |
| **H-01 overall** | **STOP / NOT ACCEPTED** |

Điều kiện duy nhất để chuyển ACCEPTED: đúng SHA + runtime không bypass RLS + tenant-owned paths có ma trận A/B + regression tests thực thi trong CI + RED/GREEN evidence + acceptance doc khớp kết quả.
