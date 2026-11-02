# CURRENT_STATE — Camera D-AI v1.3 (audit 2026-11-02)

> Nguồn: audit độc lập Hermes (diff toàn tree + đọc mã) và Devin CLI (verify động trên Postgres container thật). Chi tiết đầy đủ: đối tác so sánh `v_3` vs `v1_3` và pipeline verify nằm trong thư mục làm việc của round so sánh; đây là trạng thái hợp nhất cho chương trình phát hành.

## Đã kiểm chứng (bằng chứng chạy thật, Windows + Node 24 + npm 11)

- `npm install` 394 packages, exit 0 — lockfile đã commit vào repo.
- `npm run typecheck` (tsc --noEmit): exit 0.
- `npm run build` (Next 16.2.6 Turbopack): exit 0, 0 warning, 14 trang + API routes.
- `npm run test:ai`: 26/26 PASS — gồm 18 integration end-to-end thật: Postgres container + `next start` spawn + fixture Hermes/Vision/OCR/Voice server (idempotency, RBAC, circuit breaker, lease, cancel, timeout, revoked session).
- `npm run test:camera`: 4/4 PASS — SSRF (private IPv4 allowlist), ONVIF parse, AES-256-GCM roundtrip, ProductMeta validation.
- `npm run lint`: 0 lỗi / 30 cảnh báo (6 quy tắc react-compiler strict tạm ở warning; nợ ghi trong ROADMAP).

## Trạng thái các nền tảng

| Thành phần | Trạng thái |
|---|---|
| Next.js 16 / React 19 / TypeScript | Build sạch, verify xong |
| Hermes Gateway + Jobs (queue, idempotency, leases, fallback) + Workers | Có mã + 18 integration test PASS trên DB thật |
| UI (D-AI Bot, Camera, Chat, Trí nhớ, Điều phối, Login) | Build lên; smoke browser có sẵn nhưng chưa chạy lại trên máy/môi trường mới |
| Camera LAN (ONVIF WS-Discovery, throttle, role-gate) | Code + unit test PASS; chưa test với camera vật lý |
| Camera IP/RTSP (AES-256-GCM + go2rtc loopback + MJPEG proxy có auth) | Code + unit test PASS; chưa có go2rtc/camera thật trong môi trường verify |
| Webcam USB (chọn thiết bị, reconnect có kiểm soát) | Code; chưa soak test |
| Product metadata (schema, migration 003/004, API, UI) | Unit test PASS |
| Voice call (theo lượt, qua /api/chat) | Code; chưa đo latency thật |
| PostgreSQL + Drizzle | Schema push PASS; migration idempotent; backup/restore chưa test |
| CI/CD | Workflow đầy đủ đã cấu hình; chờ lần chạy thật trên GitHub |
| Windows service / .exe / .apk | Chưa có |
| Admin thương mại / SaaS | Chưa có |

## Phân biệt kiểm chứng / chưa kiểm chứng

- **Đã kiểm chứng:** build pipeline, AI jobs contract suite, camera unit contracts, schema push.
- **Chưa kiểm chứng:** camera vật lý (ONVIF/RTSP thật), go2rtc thật, giọng nói thật (micro/loa), GPU inference thật, backup/restore, multi-tenant, thanh toán.

## Điểm ngặt đã vá trong repo publish (khác nguồn v1_3 gốc)

1. Trang login: bỏ box gợi ý mật khẩu demo còn sót (`CameraDAI!2026`…) — mâu thuẫn với seed fail-closed.
2. `package-lock.json` bổ sung để build có thể tái lập.
3. ESLint: 6 quy tắc react-compiler strict hạ về warning (nợ được ghi nhận, không ẩn).
