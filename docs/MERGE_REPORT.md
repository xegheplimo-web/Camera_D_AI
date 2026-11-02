# Merge report — Concept (3) → Camera D-AI v1.3

| Module | Nguồn | Quyết định |
|---|---|---|
| Hermes scheduler / Vision / OCR / Memory / Voice worker | Concept (3) | **Giữ nguyên** |
| Job idempotency, audit, lease, fallback, API `/api/chat` | Concept (3) | **Giữ nguyên** |
| UI D-AI Bot, Chat, Trang chủ, Trí nhớ, Điều phối, Login | Concept (3) | **Giữ nguyên** |
| ONVIF WS-Discovery backend | v1.2 | Thêm, giới hạn role và tần suất |
| Thêm camera private IP/RTSP với AES-256-GCM | v1.2 | Thêm vào schema và API camera |
| go2rtc admin loopback + MJPEG proxy | v1.2 | Thêm, không expose khóa/nguồn RTSP |
| Trả JSON camera | Concept (3) + v1.2 | Loại `sourceCiphertext` ở `/api/cameras` và `/api/dashboard` |
| Webcam chooser + recovery | v1.3 | Thêm cho client, không tuyên bố service chạy nền |
| Gọi thoại bằng nút điện thoại | v1.3 + ý tưởng v1.2 | Gọi qua `/api/chat` bản 3, không bypass Dispatcher |
| Sản phẩm/giá/ghi chú theo ảnh | v1.3 | Lưu qua extractions với migration mới |
| Fixed fallback passwords | Concept (3) | Loại bỏ: config bắt buộc trên DB mới |
| Demo camera thumbnails bị thiếu | v1.2 | Bổ sung 4 file để không vỡ giao diện mẫu |
| Bảo trì cấu hình DB | v1.3 | Thay drizzle config chứa URI demo cứng bằng env |

## Không mang qua

- `/api/hermes/turn` từ v1.2: sẽ bypass queue/authorization model v3, có nguy cơ tách hai đường logic AI.
- Bất kỳ kết luận **production PASS** từ tệp cũ: các kết quả test cũ không chứng minh bản code mới.
- Giả định camera cloud-only có RTSP hoặc camera mã hóa H.265 luôn chạy MJPEG không cần transcoding.
