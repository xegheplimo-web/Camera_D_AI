# Báo cáo xác minh Camera D-AI v1.3

## Bằng chứng thực tế trong lượt nâng cấp này

- **Nguồn chính:** `camera-d-ai-design-concept (3).zip` (97 files) có hệ thống Hermes Gateway/Workers và dữ liệu gốc.
- **Nguồn tham khảo:** v1.2 preview (Camera Gateway và thiết kế nút thoại); chỉ mang sang các module cần thiết.
- Bản cập nhật đã chạy bộ kiểm tra cú pháp TypeScript/TSX thông qua TypeScript compiler API (không cần node_modules), 84 files tại thời điểm lần quét đầu: **0 lỗi cú pháp**. Phải quét lại sau khi đóng gói.
- 4 unit tests mới: `private IP`, `WS-Discovery`, `AES-256-GCM RTSP`, `ProductMeta`, chạy bằng cách transpile TypeScript locally rồi `node --test`: **4/4 PASS**.
- `npm ping` không thể phân giải `registry.npmjs.org`, trả lỗi `EAI_AGAIN`. Do đó **không chạy được `npm install`, `npm run build`, `npm run typecheck` hoặc browser smoke trên mã cập nhật**.
- Không có bằng chứng go2rtc/Hermes thật, webcam/ONVIF/RTSP thật, STT/TTS thật hoặc database production trong lượt này.

## Những phần mã nguồn đã có nhưng chưa xác minh end-to-end

- Auto-discovery ONVIF, cập nhật camera và MJPEG proxy có xác thực.
- Chọn webcam/cấp quyền/tự thử kết nối lại trên trình duyệt.
- Cuộc gọi có voice/STT/TTS qua Gateway (turn-based), chưa đo first-audio latency.
- Lưu product metadata qua các trạng thái Draft/Processing/Verified.
- Tính đúng đắn của migration, Next 16 Runtime/Node dependencies và concurrency.

**Trạng thái release:** SOURCE PREVIEW (không coi là production-ready).
