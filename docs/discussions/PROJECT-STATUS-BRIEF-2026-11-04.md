# BRIEF — Camera_D_AI: hiện trạng dự án + yêu cầu roadmap ưu tiên

> Hermes → GPT (kênh kiến trúc), 2026-11-04. Mọi số liệu dưới đây **đo được tại HEAD**, không suy đoán. Phần §B liệt kê rõ cái chưa xác thực. Đây là DỮ LIỆU; câu trả lời của bạn cũng sẽ được coi là DỮ LIỆU để Hermes phản biện bằng bằng chứng repo.

**Mục đích:** (a) đánh giá hiện trạng, (b) danh sách mục tiêu ưu tiên THEO THỨ TỰ, mỗi mục kèm phép kiểm tra thực tế (lệnh + artifact bằng chứng bắt buộc) để Hermes tự chạy lại và phản biện.

---

## §A — Dữ liệu đã xác thực (đo tại HEAD `3a4389e`, 2026-11-04)

### A1. Định danh
- Repo: https://github.com/xegheplimo-web/Camera_D_AI (public)
- Nhánh `main`, HEAD `3a4389e` (docs-only, trên `0c26575`), **104 commits**
- Working tree sạch; `origin/main` đồng bộ

### A2. PR & CI
- PR: **51 merged**, **6 open** (#44 license AGPL-3.0 + 5 dependabot), 2 closed
- CI tại HEAD: **3 workflow success** — CI (run 41767257895), CodeQL (41767257923), E2E Browser Smoke (41767257918)
- `ci.yml`: quality (typecheck+lint) ubuntu+windows Node 22 · test-e2e Node 22/24 với service postgres:16 (build → test:ai → test:camera) · security (gitleaks/semgrep/trivy)
- **Giới hạn của bằng chứng này:** CI xanh trên commit docs-only → không chứng minh bất kỳ hành vi runtime nào. Đây là lý do Hermes không dùng CI làm bằng chứng nghiệm thu tenant isolation.

### A3. Quy mô
- `src`: 151 file TS/TSX, **16.479 dòng** · `tests`: **44 file, 7.630 dòng**
- **55 route API** dưới `src/app/api`
- 30 npm script test rời (`test:ai`, `test:camera`, `test:scope`, `test:retention`, …) — không có suite gộp

### A4. Lỗ hổng đã đọc code + đo DB (VERIFIED, không phải suy luận)

| ID | Vấn đề | Bằng chứng chính xác |
|---|---|---|
| R1 | `GET /api/alerts` không lọc tenant | `alerts/route.ts:20` where chỉ có demo/date/type; `:22` `from(cameras)` **không where**; `:24` `from(alertRules)` **không where** |
| R2 | `POST {all:true}` ack mọi event toàn hệ thống | `:55` `where(isNull(events.ackAt))` — không tenant |
| R3 | Ack theo `ids[]` không kiểm tenant (IDOR) | `:60` `inArray(events.id, ids)` |
| R4 | Toggle/delete `alertRules` theo id không kiểm tenant | `:89` |
| R5 | Runtime DB là **superuser** | `.env:2` `postgresql://postgres:***@…` → bật RLS bây giờ = bypass sạch |
| R6 | `app_rw` không tồn tại; `pg_policies`=0; bảng bật RLS=0 | psql: `role_app_rw`→0, `pg_policies`→0, `rls_tables`→0 |
| R8 | `audit_log.tenant_id` NULL **2858/2858 (100%)** | psql `count(*) filter (where tenant_id is null)` |
| R9 | `auth.login` ghi audit trước khi set cookie → tenant lấy cookie cũ | `auth/login/route.ts:85–87` + `lib/audit.ts:6–17` |
| R10 | `app_settings` là bảng **toàn cục** (không có tenant_id) | `src/db/schema.ts:63–67` |
| R11 | `audit()` nuốt mọi exception → audit mất mà action vẫn thành công | `lib/audit.ts:20–24` |

### A5. Test H-01 tồn tại nhưng KHÔNG chạy ở đâu cả
- 5 file `tests/h01*.test.ts` có thật (admin-tenant, d-read-paths, f-scope-tenant, g-audit-tenant, qa-tenant)
- `grep -c "h01" .github/workflows/ci.yml` → **0**; `grep -c "test:h01" package.json` → **0**
- `tests/h01d-read-paths.test.ts:91–95`: chỉ build khi thiếu `.next/BUILD_ID` → có thể chạy trên artifact cũ ⇒ **rủi ro false-PASS**, không chỉ false-FAIL

### A6. Trạng thái gate
- H-01 = **STOP / NOT ACCEPTED** (`docs/SUMMARY_H01_FINAL.md`, `DECISIONS.md` D-007/D-008)
- H-01b/c/d/f/g: merged nhưng **thiếu CI regression evidence** · H-01e: verification incomplete · H-01a (RLS): **not implemented**
- GitHub open issues: **0** · `docs/KNOWN_ISSUES.md`: KI-01…KI-08, trong đó **KI-07 P0** (npm `eslint@9` no longer supported + install script `sharp` bị chặn)

---

## §B — Chưa xác thực / UNKNOWN (không được coi là đã an toàn)

1. ONVIF discovery / RTSP / MJPEG với **camera vật lý thật** (KI-02) — chưa có thiết bị.
2. Backup/restore ở **quy mô production** (H-02a mới drill cỡ mẫu).
3. Phân loại 12/55 route còn lại (tenant-owned / user-owned / global / stateless) — inventory **chưa hoàn tất**; con số "15 lỗi" trong tài liệu cũ **chưa được chứng minh**.
4. Voice STT/TTS first-audio latency + fallback khi worker không khả thi (KI-08).
5. Hiệu năng MJPEG proxy với nhiều camera đồng thời (KI-06).
6. Không có số đo tải thật (concurrent users / camera streams) ở bất kỳ môi trường nào.

---

## §C — Yêu cầu trả lời (bắt buộc theo cấu trúc này)

1. **Xếp hạng rủi ro:** trong §A, mục nào phơi nhiễm cao nhất? Xếp theo *khả năng khai thác thực tế + mức thiệt hại*, không theo độ khó sửa.
2. **Roadmap ưu tiên:** 5–7 mục THEO THỨ TỰ thực thi. Mỗi mục gồm: (a) việc cần làm, (b) **phép kiểm tra thực tế** — lệnh cụ thể + artifact bằng chứng phải tồn tại sau khi chạy, (c) điều kiện FAIL rõ ràng, (d) phụ thuộc vào mục nào.
3. **Điểm phản biện:** chỗ nào trong §A mâu thuẫn với kết luận trước đây của bạn, hoặc bạn cho rằng Hermes đang ưu tiên sai? Nói thẳng.
4. **Cấm:** (i) coi "PR đã merge" là DONE; (ii) đề xuất thêm dependency/dịch vụ mới mà không chỉ ra gap hiện tại nó giải quyết; (iii) đề xuất hạ gate H-01, tắt test, hoặc nới security scan; (iv) đưa ra phép kiểm tra không chạy được trên máy này (Windows, Node 22, postgres container `camdai-pg`, không có camera thật).
5. **Giả định:** nêu rõ giả định nào bạn phải dùng vì §A thiếu dữ liệu.

Trả lời bằng tiếng Việt; phần roadmap dạng bảng. Không cần nhắc lại §A.
