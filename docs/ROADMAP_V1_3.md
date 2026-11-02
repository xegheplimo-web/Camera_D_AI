# Roadmap còn lại theo độ ưu tiên

## P0 — trước khi cho người dùng ngoài LAN sử dụng
1. Lắp deps, chạy build TypeScript, integration test Postgres và browser smoke trên Windows.
2. Bảo mật permission/tenant mọi API; audit dữ liệu không được xuyên tài khoản, giới hạn tốc độ, bảo vệ admin go2rtc.
3. Soak test webcam/RTSP/ONVIF với ít nhất 3 hãng camera và mạng có mất kết nối; có health real, không báo online giả.
4. Chuyển stream viewer MJPEG sang WebRTC/HLS có token/ACL; tối ưu băng thông và CPU.
5. Backup/restore tested, retention media và chính sách thông báo ghi hình.

## P1 — sản phẩm sử dụng thực tế
6. Camera service Windows chạy nền, system tray + auto-start, ghi hình liên tục, restart recovery (không phụ thuộc browser).
7. Nâng AI detection lên worker GPU (RF-DETR/ByteTrack hoặc benchmark model cạnh tranh); đo accuracy/latency/FPS bằng dataset thật.
8. Kho ảnh đa ảnh/sản phẩm, SKU, giá lịch sử, CSV/Excel, thumbnail và object storage thay base64.
9. Trí nhớ vector với liên kết video/ảnh theo mốc thời gian.
10. STT/TTS tiếng Việt qua worker, ngắt lời và truyền âm thanh thời gian thực.

## P2 — đa thiết bị và thương mại
11. PWA mobile hardened hoặc Android app native, HTTPS/VPN và đăng nhập thiết bị.
12. Multi-tenant, phân quyền mỗi camera, số camera/gói, hạn mức worker.
13. Admin SaaS, hóa đơn, xử lý webhook giao dịch an toàn, metering sử dụng GPT/DeepSeek, tín dụng prepaid.
14. PTZ, multi-camera, cảnh báo/push, desktop installer đã ký.

## P3 — mở rộng
15. Model video understanding lớn hơn, phân tích theo yêu cầu, chạy nhiều GPU và autoscale.
16. iOS/TestFlight, đăng ký thiết bị, dashboard mobile nâng cao.
17. Kiểm thử pháp lý/licensing khi bán phần mềm và bộ model kết hợp.

## Nợ kỹ thuật ghi nhận (được hạ về cảnh warning trong ESLint)

- 6 quy tắc nghiêm ngặt của `eslint-plugin-react-hooks` v7 (react-compiler lints: `set-state-in-effect`, `purity`, `static-components`, `refs`, `immutability`) đang ở mức **warning** trên `src/**` — codebase dùng pattern data-loading/listener cũ. Khi refactor UI theo chuẩn React Compiler (thuộc vòng P1), bật lại ở mức `error` và xóa dòng cấu hình trong `eslint.config.mjs`.
- Đã được chỉnh sửa so với nguồn gốc merge: trang đăng nhập loại bỏ box gợi ý mật khẩu demo (`CameraDAI!2026`…) — không còn đúng với hành vi seed (bắt buộc env password) sau khi merge v1.2/v1.3.
