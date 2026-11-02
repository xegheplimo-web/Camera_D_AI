# Camera D-AI v1.3 — Phát triển trực tiếp từ design-concept (3)

[![CI](https://github.com/xegheplimo-web/Camera_D_AI/actions/workflows/ci.yml/badge.svg)](https://github.com/xegheplimo-web/Camera_D_AI/actions/workflows/ci.yml)
[![E2E Browser Smoke](https://github.com/xegheplimo-web/Camera_D_AI/actions/workflows/e2e.yml/badge.svg)](https://github.com/xegheplimo-web/Camera_D_AI/actions/workflows/e2e.yml)
[![CodeQL](https://github.com/xegheplimo-web/Camera_D_AI/actions/workflows/codeql.yml/badge.svg)](https://github.com/xegheplimo-web/Camera_D_AI/actions/workflows/codeql.yml)

> **MÃ NGUỒN THỬ NGHIỆM**, chưa phải bộ cài `.exe` / `.apk`, chưa được xác minh production-ready.
>
> Bản v1.3 giữ nguyên Hermes Gateway / asynchronous Jobs / Workers / Memory của `(3).zip`. Các module v1.2 chỉ được hợp nhất khi mang lại chức năng còn thiếu.

## Có gì trong bản này?

- Giao diện D-AI Bot tiếng Việt, dashboard, camera, ảnh/trích xuất, trí nhớ, cảnh báo, chat, thống kê và AI Orchestration (giữ lại từ bản 3).
- **Camera LAN**: tự tìm camera ONVIF bằng WS-Discovery (UDP multicast trên LAN của máy chủ Windows), quét khi mở trang Camera và định kỳ khi có quyền quản lý. Chỉ phát hiện, **không tự thêm** thiết bị.
- **Camera IP/RTSP**: thêm thủ công, địa chỉ camera chỉ chấp nhận private IPv4, mã hóa nguồn AES-256-GCM, đăng ký nguồn với go2rtc tại localhost; xem bằng proxy MJPEG có xác thực.
- **Webcam USB**: chọn thiết bị, lưu lựa chọn, thử tự mở lại khi trình duyệt đã được cấp phép và thiết bị rút/cắm lại. **Chưa phải dịch vụ Windows ghi hình nền 24/7.**
- **Ảnh & sản phẩm**: ảnh có ghi chú riêng, bổ sung tên sản phẩm, SKU, giá VNĐ và số lượng do người dùng nhập; có thể lưu bản nháp và kiểm duyệt AI.
- **Gọi D-AI**: nút điện thoại ở header, thoại tiếng Việt theo lượt qua D-AI Gateway/Voice Worker hoặc trình duyệt; Hermes được Gateway gọi khi tác vụ cần điều phối. Hỗ trợ nói, nhập chữ, phát loa trên thiết bị đang sử dụng, ngắt tiếng, kết thúc cuộc gọi.
- Bỏ mật khẩu mặc định nguy hiểm đối với CSDL mới; yêu cầu cấu hình ba mật khẩu mạnh riêng biệt.

## Thành phần giữ nguyên từ `(3).zip`

`src/lib/ai/` gồm: Hermes planner, queue, leases, idempotency, các worker Vision/OCR/Memory/Voice, fallback, chính sách không đoán dữ liệu thiếu. Đây là điểm mạnh nhất của bản 3.

## Cài đặt trên Windows (môi trường phát triển)

Yêu cầu: **Node.js 22+**, PostgreSQL, một bản Hermes API Server đã cài (tùy chọn), go2rtc (khi dùng camera RTSP) và máy tính Windows kết nối cùng LAN với các camera.

1. Giải nén ZIP. Trong PowerShell, mở thư mục chứa `package.json`.
2. Sao chép `.env.example` thành `.env.local`. Thiết lập `DATABASE_URL`, `AUTH_SECRET` dài ít nhất 32 ký tự và 3 mật khẩu *riêng biệt* (`ADMIN_PASSWORD`, `OPERATOR_PASSWORD`, `VIEWER_PASSWORD`) dài từ 12 ký tự.
3. Tạo khóa mã hóa camera (32 byte hex):

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Điền kết quả vào `CAMERA_CREDENTIAL_KEY`. **Cất khóa này an toàn; mất khóa sẽ không thể giải mã các cấu hình RTSP đã lưu.**
4. Cài dependencies với Internet: `npm install`.
5. Với **database development mới**, chạy `npm run db:push:dev` (lệnh `drizzle-kit push` sẽ đối chiếu schema và có thể yêu cầu xác nhận; **không chạy trực tiếp trên production**).
6. Nếu nâng cấp từ một bản 3 đã có DB, **sao lưu trước**, chạy SQL trong `migrations/003_camera_gateway.sql`, `migrations/004_photo_product_fields.sql` qua `psql`, sau đó đối chiếu schema. Không chạy `db:push:dev` lên dữ liệu thật chưa được kiểm soát.
7. Chạy `npm run dev`; mở `http://127.0.0.1:3000` trên PC. Đăng nhập `owner` với mật khẩu đã cấu hình.
8. Mở **Camera** để tự dò ONVIF hoặc thêm `rtsp://user:password@192.168.x.y:554/path` khi đã biết URL của camera.

### go2rtc (khi dùng camera IP)

- Cài go2rtc theo tài liệu dự án chính thức: https://github.com/AlexxIT/go2rtc
- Lấy `deploy/go2rtc.example.yaml` làm cấu hình tham khảo, **ràng buộc API quản trị ở `127.0.0.1:1984`**; không mở trực tiếp go2rtc ra Internet.
- Khởi động go2rtc trước khi thêm camera IP, rồi thử **Kết nối lại** nếu đã thêm từ trước.
- ONVIF discovery cần multicast UDP 3702 không bị tường lửa/mesh Wi-Fi chặn. Camera cloud-only hoặc khác VLAN có thể không xuất hiện.
- URL RTSP phụ thuộc model, không tự đoán đường dẫn hoặc mật khẩu.
- MJPEG qua HTTP proxy giúp xem cơ bản, nhưng **không tối ưu cho nhiều camera/điện thoại**. Cần chuyển sang WebRTC/HLS có xác thực khi scale.

### Hermes và AI Workers

- Điền `HERMES_BASE_URL`, `HERMES_API_KEY`, `HERMES_MODEL`, cùng những biến `DAI_*` tương ứng khi có dịch vụ thực tế.
- D-AI **không tự khởi chạy Hermes hoặc tự cài model**. Nhân viên cần triển khai các worker tuân thủ API tương thích như tài liệu `docs/HERMES_ARCHITECTURE.md`.
- Câu hỏi số liệu đơn giản có thể đi đường Gateway/SQL; câu hỏi chuyên sâu được điều phối Hermes. Màn gọi sử dụng **cùng API `/api/chat`** của bản 3, không tạo một hệ Hermes song song.
- Chức năng hội thoại đang là **theo lượt**, chưa phải full-duplex WebRTC latency cực thấp như ChatGPT Live.

### Điện thoại

Giao diện hiện là web responsive/PWA; **chưa có APK/iOS native**. Điện thoại phải kết nối được tới máy chủ Windows bằng URL an toàn. Để dùng micro/camera trên điện thoại qua mạng, thường cần **HTTPS** (localhost trên PC là ngoại lệ). Không chuyển tiếp port trực tiếp ra Internet; sử dụng reverse proxy TLS và VPN/zero-trust phù hợp.

## Kiểm thử

- `npm run typecheck` / `npm run build` / `npm run test:ai`: chạy sau khi `npm install` thành công và có dịch vụ PostgreSQL cho các bài integration.
- `npm run test:camera`: 4 bài test cho ONVIF, RTSP, AES-GCM và giá/số lượng.
- Báo cáo xác minh hiện tại nằm tại `docs/VALIDATION_V1_3.md`.
- `artifacts/baseline-v3/validation` chỉ là log **bản 3 gốc**, không phải chứng nhận v1.3 build PASS.

## Những việc vẫn phải làm trước khi phát hành thương mại

- Windows background recorder 24/7, snapshot/timelapse và thư viện camera hãng/PTZ.
- WebRTC/HLS được bảo vệ, giám sát video real-time với tỷ lệ nhận diện đã đo trên dữ liệu gán nhãn.
- Phân vùng dữ liệu nhiều khách hàng (tenant isolation), backup, retention và giám sát tải.
- Hội thoại full-duplex, thiết bị Android/iOS native, quản trị SaaS, thanh toán và metering dùng API có đối soát.
- Audit SSRF/CSRF/RBAC/security/retention và soak test với camera thật.

Không dùng sản phẩm để nhận dạng danh tính hoặc giám sát nơi riêng tư khi chưa có căn cứ, quyền và sự thông báo cần thiết.
