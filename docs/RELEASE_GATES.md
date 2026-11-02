# RELEASE GATES — Camera D-AI

> Nguồn chỉ thị: kế hoạch "hoàn thiện v1.3 thành sản phẩm thương mại" (GPT review 2026-11-02), hợp nhất với bằng chứng verify thực tế của Hermes. Trạng thái cổng chỉ đổi khi có bằng chứng (log/artifact), không đổi khi agent báo "xong".

| Gate | Nội dung bắt buộc | Điều kiện hoàn tất | Trạng thái (2026-11-02) |
|---|---|---|---|
| **G0 — Foundation** | Git, lockfile, CI, build sạch, bộ kiểm thử, audit code | Clean build + CI xanh | **~85%** — install/typecheck/build/30 tests PASS trên Postgres thật (sandbox Windows); lockfile + CI (quality matrix, e2e Postgres matrix N22/24, Playwright browser smoke, gitleaks/semgrep/trivy, CodeQL) đã cấu hình. Còn thiếu: lần chạy CI thật xanh trên GitHub, browser-smoke PASS trên Linux runner |
| **G1 — Security** | RBAC, phân quyền camera, tenant isolation, secrets, bảo vệ API | 0 lỗi P0/P1 chưa xử lý | **Một phần** — GET cameras có auth, seed fail-closed, RTSP chỉ private IP + AES-256-GCM, loopback gateway (đã diff-verified). Còn thiếu: security scans xanh thật, security review P0/P1 chính thức (theo docs/SECURITY.md) |
| **G2 — Camera Engine** | USB tự nhận, ONVIF LAN, RTSP/IP, go2rtc, service chạy nền | Camera chạy thật 24/7 | **Chưa bắt đầu verify thật** — code + unit tests PASS (SSRF, AES-GCM roundtrip) nhưng chưa có camera vật lý/go2rtc thật; cần soak test 72h |
| **G3 — Vision AI** | RF-DETR, tracker, OCR, đọc video | benchmark có bằng chứng | Chưa bắt đầu |
| **G4 — Memory & Products** | Ảnh/ghi chú riêng, sản phẩm, giá, trí nhớ, tìm kiếm | Lưu → tìm → sửa → khôi phục | Một phần qua integration tests + browser-smoke (upload/note/trích xuất); còn thiếu benchmark thực |
| **G5 — Voice + Hermes** | STT/TTS, hội thoại, nút gọi, điều phối | Kiểm thử micro/loa thật, P95 audio ≤2.5s | Chưa đo thật |
| **G6 — Mobile** | PWA/Android, ghép đôi, thông báo | Chạy thiết bị thật | Chưa bắt đầu |
| **G7 — Commercial** | Admin, gói, nạp tiền, metering | Đối soát đạt | Chưa bắt đầu |
| **G8 — Release** | Hiệu năng, đóng gói, rollback, tài liệu | Release Candidate phê duyệt | Chưa bắt đầu |

## Mốc phát hành
1. **Local/Private Pilot**: G0–G6 đạt.
2. **SaaS thương mại**: G7–G8 đạt. Không bán nhiều khách dựa trên kết quả bản local.

## Quy tắc cổng
- PASS/FAIL chỉ theo bằng chứng chạy thật (exit code + log + artifact); Devin/agent báo "xong" không được tính là bằng chứng.
- FAIL → thu log, phân loại, giao lại Devin với bằng chứng kèm theo; tối đa 3 lần cùng lỗi gốc không thay đổi → BLOCKED.
- Mỗi task có ID `CAM-Gx-nnn`; không chạy song song 2 task đụng cùng file/schema.
