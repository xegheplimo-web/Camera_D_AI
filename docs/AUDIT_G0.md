> Ghi chú cập nhật kiến trúc: tài liệu dưới đây là audit bản G0 ban đầu. Hiện tại client không còn chạy COCO/Tesseract; đã chuyển sang Gateway + Hermes + AI Workers. Trạng thái mới, cấu hình và giới hạn được ghi trong `HERMES_ARCHITECTURE.md` và `TESTING_HERMES.md`.

# G0 — Audit bản Camera D-AI (trước Design Freeze v1.0)

Phạm vi: rà soát mã nguồn hiện có, API, dữ liệu, bảo mật. Không tuyên bố production-ready.

## 1. Phát hiện P0 (đã sửa trong bản này)

| # | Vấn đề | Ảnh hưởng | Trạng thái |
|---|--------|-----------|------------|
| P0-1 | `POST /api/admin` cho phép xóa/đặt lại toàn bộ dữ liệu mà không xác thực | Bất kỳ ai truy cập được URL đều phá dữ liệu | Đã sửa: session + role owner + cụm xác nhận `XOA DU LIEU` + audit |
| P0-2 | `deviceId` do trình duyệt gửi được dùng trong nhật ký như danh tính | Giả mạo người thao tác | Đã sửa: danh tính lấy từ token ký HMAC + bản ghi `sessions` |
| P0-3 | Không có lớp đăng nhập, mọi API đọc dữ liệu camera/mở ảnh | Rò rỉ ảnh và lịch sử | Đã sửa: middleware chặn toàn bộ route trừ `/login`, `/api/auth/*`, `/api/health` |
| P0-4 | Dữ liệu nhận diện do client gửi được coi như sự kiện thật | Số liệu sai, không truy vết | Đã giảm thiểu: cờ `clientReported`, cảnh báo trong câu trả lời, thao tác “Duyệt bằng chứng” |
| P0-5 | Dữ liệu mẫu trộn với dữ liệu thật | Báo cáo sai | Đã sửa: `demoMode`, badge “mẫu”, cảnh báo trong chat/thống kê |

## 2. Có thật (chạy được trong repo này)

- Next.js App Router + PostgreSQL/Drizzle; build production và healthcheck chạy được.
- Đăng nhập, phiên ký HMAC httpOnly, RBAC 3 vai trò, thu hồi phiên, nhật ký thao tác.
- Camera webcam thật, overlay nhận diện, vạch đếm có vùng trễ + chống đếm trùng + idempotency.
- Chụp ảnh/clip, lưu asset có kiểm MIME bằng magic bytes, SHA-256, giới hạn 25 MB.
- Trích xuất ảnh: ROI, xoay, cắt, OCR tiếng Việt, nhận diện đối tượng, cấu trúc hoá, kiểm duyệt, version, giữ bản AI gốc.
- Hỏi đáp tiếng Việt: phân tích ý định → truy vấn SQL tham số hoá → câu trả lời có calculation + bằng chứng; trả `INSUFFICIENT_DATA` khi thiếu dữ liệu.
- Trí nhớ có bộ lọc, thống kê có truy vết nguồn, cảnh báo có quy tắc + xác nhận đã đọc.
- PWA: manifest, service worker chỉ cache app shell.

## 3. Một phần

- Nhận diện/OCR chạy phía client (COCO-SSD 80 lớp, Tesseract) — chưa có pipeline server/GPU.
- STT/TTS dùng API trình duyệt; chất lượng tiếng Việt phụ thuộc thiết bị.
- Đếm người: đúng luồng nhưng chưa đo sai số trên video gán nhãn.
- Chưa tách dữ liệu theo người dùng/camera (hiện là một không gian dữ liệu chung có phân quyền).
- Chưa có app Windows/Android đóng gói; dùng PWA responsive.

## 4. Chưa có (không được coi là đã xong)

- Camera IP/RTSP, media gateway, ghi 24/7 khi đóng trình duyệt.
- Backup/khôi phục tự động, retention job chạy theo lịch, monitoring/SLO.
- Web Push thật, ghép đôi QR, phát giọng trên thiết bị khác.
- Vector search, VLM cục bộ, iOS/TestFlight.

## 5. Việc bắt buộc trước khi cho người khác truy cập

1. Đặt `AUTH_SECRET` và đổi mật khẩu các tài khoản demo (`ADMIN_PASSWORD`, `OPERATOR_PASSWORD`, `VIEWER_PASSWORD`).
2. Tắt `demoMode` khi dùng dữ liệu thật.
3. Dùng TLS và mạng riêng (VPN/tailnet), không mở cổng ra Internet.
4. Xem lại `docs/SECURITY.md` cho các khoảng trống còn lại.
