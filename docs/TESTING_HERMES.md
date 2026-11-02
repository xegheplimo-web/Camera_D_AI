# Kiểm thử Gateway / Hermes / Workers

## Cách chạy lại

1. Cài dependencies theo lockfile, đặt `DATABASE_URL`, `AUTH_SECRET` và bootstrap môi trường.
2. Áp dụng schema bổ sung với `npx drizzle-kit push` (không drop/reset DB).
3. `npx next typegen`
4. `npm exec tsc -- --noEmit --pretty false`
5. `npm run build`
6. `npm exec tsx -- --test tests/ai-unit.test.ts tests/ai-integration.test.ts`

Test integration khởi động Next trên port trống và HTTP fixture trên loopback, tạo user/camera/asset/sự kiện riêng. Tắt process và dọn dữ liệu fixture ở cuối, phục hồi settings/service health. Chỉ dùng Drizzle cho DB. Chạy ở sandbox/test DB, không chạy trong lúc người dùng production đang thay đổi settings.

## Test đang có

### Unit

- Phân biệt fast SQL với điều phối báo cáo sâu.
- Chọn single-worker/multi-worker theo yêu cầu.
- Từ chối tool không có trong allowlist, SQL/URL/shell field, JSON sai.
- ROI: số hữu hạn, biên và kích thước hợp lệ.
- Kết quả ảnh: unknown không đổi thành 0, bbox đúng vùng, không cộng đôi Vision/OCR.
- RBAC, chữ ký và hạn phiên.
- Endpoint config: giữ profile prefix, không credentials trong URL, TLS ngoài LAN.

### Integration (API fixture, KHÔNG phải model thật)

- Chưa login 401; viewer write 403; cross-origin 403; dispatcher token sai 401.
- Fast answer không gọi Hermes; chỉ đếm dữ liệu nguồn và loại clientReported.
- Key lặp không tạo chat/job mới; key dùng với body khác bị từ chối.
- Báo cáo sâu chạy qua kế hoạch Hermes giả lập, Memory/SQL thật và evidence id thật từ fixture DB.
- Hermes offline, profile có terminal tool, hoặc plan không hợp lệ → partial có cảnh báo.
- Trích xuất đơn bỏ qua Hermes; worker nhận ROI cắt phía server; client count bị bỏ qua.
- Compound extraction ghép OCR mà không cộng đôi count; rawResult không bị sửa khi human review.
- Note draft lưu được khi không cần AI; không xác minh draft như kết quả AI.
- Worker JSON sai → failed + giữ nguồn; retry đúng cùng job.
- Cancel không lưu kết quả đến muộn.
- Timeout có lỗi rõ, không có kết quả bịa.
- Lease hết hạn được tiếp quản bằng cùng job/request key.
- Tối đa hai job nặng; job thứ ba chờ; SQL không đi vào hàng đợi nặng.
- Trần ba lần chạy; circuit breaker sau hai lỗi upstream.
- Voice proxy: đúng hợp đồng audio/STT, output_target=requester_device, không gọi Hermes.
- Phiên thu hồi không đọc được job/media.

## Chạy browser smoke

Sau khi production server đang chạy, dùng `npm exec tsx -- tests/browser-smoke.ts`. Đổi `DAI_TEST_BASE_URL` khi không dùng localhost:3000. Script tạo tài khoản operator riêng, chụp ảnh, kiểm tra 1440/768/390/360px và dọn dữ liệu thử ở cuối.

## Bằng chứng trình duyệt

Ảnh thật từ Chromium headless ở `artifacts/screenshots/`:

- `orchestration-desktop.png`
- `orchestration-mobile.png`
- `chat-fallback-desktop.png`

Kiểm tra browser tập trung đăng nhập, điều hướng, fast/fallback, trích xuất thiếu worker, lưu nháp, responsive và không tải model client. Đây **không phải** biên bản Windows 11/Android/iOS thật và không chứng minh audio đã phát trên loa phần cứng.

## Chưa kiểm chứng

- Hermes Agent instance/model/provider thật, driver GPU và worker OCR/Vision/Voice production.
- Accuracy detector/tracker/OCR hoặc benchmark tiếng Việt.
- Speaker isolation trên hai thiết bị vật lý, Bluetooth, độ trễ audio đầu tiên và P95.
- Ghi camera 24h, RTSP/media gateway, khởi động lại host thật.
- SaaS multi-tenant, permissions theo camera, object storage và backup/restore.
- Soak/load/security scan đầy đủ; build pass không thay cho chứng nhận production.

Không ghi fixture count (ví dụ 7 hộp) hay thời gian HTTP loopback thành benchmark AI thực tế.
