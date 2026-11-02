# Camera D-AI — Gateway + Hermes + AI Workers

## Quyết định triển khai

Giữ React/Next.js/PWA, robot và các màn hình hiện có. Client chỉ làm UI, media capture, upload, ghi chú, transcript, hiển thị bằng chứng và phát âm thanh. Đã bỏ tải TensorFlow/COCO-SSD/Tesseract từ trình duyệt. Không cài Hermes hay model GPU vào điện thoại.

Hermes Agent của Nous Research là **bộ lập kế hoạch**; Gateway xác thực và thực thi kế hoạch khai báo qua worker allowlist. Máy chủ Hermes vẫn cần provider/model và tài nguyên riêng. Gateway không giả rằng Hermes tự thay thế GPU, storage, SQL hay engine camera.

## Hai đường xử lý

```text
FAST PATH (không gọi Hermes)
Camera D-AI → Gateway → SQL / media / lưu ghi chú / một worker chuyên môn → kết quả

ORCHESTRATED PATH
Camera D-AI → Gateway → job PostgreSQL → Hermes (kế hoạch JSON)
                                      → Gateway kiểm tra allowlist
                                      → Memory/SQL | Vision | OCR Workers
                                      → kết quả + bằng chứng + trạng thái job
```

- “Hôm nay có bao nhiêu khách?” → `/api/chat` trả HTTP 200, chạy SQL có tham số; không probe/call Hermes.
- “Phân tích toàn bộ camera tuần trước, tìm bất thường và lập báo cáo” → HTTP 202 + `job.id`; client theo dõi `/api/jobs/{id}`.
- Chụp/tải ảnh, xem media, lưu ghi chú nháp và thống kê không qua Hermes.
- Trích xuất đơn (OCR hoặc nhận diện) → Gateway gọi thẳng worker.
- Trích xuất nhiều công cụ (đếm + đọc nhãn/bảng) → Hermes chọn kế hoạch, Gateway giao các worker, tối đa hai bước chuyên môn song song.
- STT/TTS → Voice Worker trực tiếp; khi chưa cấu hình, dùng Web Speech/giọng thiết bị với nhãn dự phòng. Web Speech có thể dùng dịch vụ của nhà cung cấp trình duyệt; không hứa là ASR offline.

## Hợp đồng Hermes (đã đối chiếu tài liệu chính thức)

- API server: `POST /v1/chat/completions`, Bearer token từ `HERMES_API_KEY`, `model=hermes-agent` hoặc alias profile.
- Gateway gửi `Idempotency-Key`, `X-Hermes-Session-Key` riêng theo job, `stream:false`. Chỉ chấp nhận `choices[0].finish_reason === "stop"` và JSON đúng schema.
- Kế hoạch chỉ có `{"tools":["memory.summary","memory.events"]}` hoặc `vision.extract` / `ocr.extract` cho job ảnh.
- Không chấp nhận trường SQL, URL, shell command, tham số tùy ý hoặc tool name khác. Không chạy `eval`, shell hay SQL do Hermes sinh.
- `/api/jobs` của Hermes là API **lịch cron**; không dùng làm hàng đợi tác vụ Camera D-AI. Bản này dùng hàng đợi PostgreSQL riêng.

### Bắt buộc dùng profile planner hạn quyền

Hermes API mặc định có thể chạy terminal/file/web tools. **System prompt không phải ranh giới bảo mật.** Tạo profile riêng cho Camera D-AI; dùng cấu hình toolset theo `api_server`/`hermes tools` và `agent.disabled_toolsets` của phiên bản đang cài để tắt toàn bộ công cụ trực tiếp, plugin và MCP không được phép. Không dùng profile trợ lý cá nhân có filesystem/DB credentials.

Trước khi gửi nội dung người dùng, adapter kiểm tra `GET /v1/toolsets`. Nếu response không xác minh được hoặc còn toolset được bật có tool thực, Gateway trả `UNSAFE_HERMES_PROFILE` và dùng fallback. Endpoint `/v1/models` chỉ chứng minh kết nối HTTP, không chứng minh cấu hình toolset an toàn hoặc chất lượng model.

Không cài đặt hay chạy Hermes trong sandbox này. Chưa có kết quả end-to-end với một Hermes thật; các test dùng API fixture được ghi rõ.

## Registry worker

| Worker | Hợp đồng | Hiện trạng |
|---|---|---|
| Memory/SQL | Các hàm SQL allowlist nội bộ | Chạy được không cần model |
| Vision | OpenAI-compatible `POST /v1/chat/completions`, inline `image_url` | Adapter đã có; cần endpoint/model thực |
| OCR | Cùng hợp đồng ảnh, chỉ đọc chữ/bảng/nhãn | Adapter đã có; cần endpoint/model thực |
| Voice STT | `POST /v1/audio/transcriptions`, multipart, tiếng Việt | Adapter + thu âm tối đa 30 giây ở client |
| Voice TTS | `POST /v1/audio/speech`, audio response qua Gateway | Adapter + playback trên đúng client |
| Video | Engine video chuyên dụng | **Chưa triển khai**, không giả lập là đã phân tích clip |

Faster-whisper/VieNeu/PaddleOCR không được mặc định coi là có HTTP API này. Khi dùng chúng, triển khai adapter server tương thích hợp đồng; cấu hình đúng model id thay vì đoán tên. GPU, batching, stream ingest và lịch tài nguyên thuộc triển khai worker, không thuộc client.

### Trích xuất và bằng chứng

Gateway đọc ảnh gốc đã lưu, decode và kiểm kích thước với `sharp`, cắt ROI trên server, giới hạn 40 MP/25 MB, resize tối đa 1600px, bỏ EXIF khi gửi worker. Không tin `local`, số lượng, OCR hoặc kích thước do client tự báo.

Worker trả `summary`, `details`, `objects`, `ocrText`, `structured`, `confidence`, `warnings`. Gateway kiểm kiểu, số hữu hạn, count nguyên không âm, bbox nằm trong ảnh; unknown không biến thành 0. Kết quả lưu `REVIEW_REQUIRED`, giữ `rawResult`, người có quyền mới xác minh. Merge Vision/OCR không cộng đôi số đối tượng. Mỗi kết quả gắn asset id, SHA-256 và vùng chọn.

## Chống bịa số và phương án dự phòng

- SQL là nguồn số liệu. Các job báo cáo dùng thời gian/phạm vi đóng băng khi tiếp nhận, múi giờ `Asia/Ho_Chi_Minh` và mốc kết thúc không vượt thời điểm tiếp nhận.
- Mọi lượt do browser POST đều `clientReported=true`, kể cả khi body cố gửi `false`. Không đưa bản ghi chưa duyệt vào số đếm SQL/biểu đồ.
- Chế độ thực loại bản ghi demo khỏi query, timeline và xuất báo cáo. Bằng chứng chỉ lấy id đã truy xuất từ DB, không tin id do model sinh.
- Hermes timeout/mất kết nối/đang tắt/kế hoạch không hợp lệ → báo cáo SQL **partial**, ghi rõ không phân tích lại video hay kết luận bất thường bằng thị giác.
- Worker ảnh không cấu hình/lỗi → job thất bại có thể thử lại; giữ ảnh và ghi chú, không tạo số đếm/văn bản giả.
- Kết quả worker một phần → `partial`, lưu cảnh báo phần thiếu; không tự chuyển sang “đã xác minh”.

## Job bền vững và vận hành

- PostgreSQL: `ai_jobs`, `ai_services`; index user+idempotency key; request hash phát hiện key dùng với body khác.
- Trạng thái: queued → running → succeeded / partial / failed / cancelled.
- Tối đa 8 job active/người, 2 job nặng đồng thời toàn Gateway, tối đa 3 lần chạy. Advisory lock + row lock tránh nhận trùng việc.
- Lease 90 giây; ngân sách chạy 55 giây; từng call upstream 1–20 giây. Lease hết hạn có thể tiếp quản khi được dispatch lại.
- Hủy: đổi trạng thái trong DB, abort HTTP cục bộ, điều kiện run-token chặn kết quả đến muộn kể cả ở instance khác. **Không bảo đảm GPU/Hermes ở phía sau đã ngừng tính toán khi HTTP disconnect.**
- 2 lỗi kết nối liên tiếp → circuit mở 30 giây; Fast path SQL không phụ thuộc circuit Hermes. Người vận hành có thể probe lại.
- Side effect DB được chống trùng; external worker vẫn cần hỗ trợ Idempotency-Key để tránh lặp inference khi crash/retry. Không tuyên bố exactly-once cho dịch vụ bên ngoài.

Preview dùng `next.after()` sau tiếp nhận và khi poll job để tiếp tục hàng đợi. Không tạo timer chạy nền âm thầm trong Next. Để chạy job khi không mở trình duyệt, cấu hình `DAI_DISPATCH_TOKEN` riêng (32+ ký tự), `DAI_GATEWAY_URL` rồi giám sát `node scripts/ai-dispatcher.mjs` bằng Windows Task Scheduler/systemd/process supervisor. Script `--once` dùng cho cron hoặc smoke test. Endpoint dispatcher chỉ nhận Bearer service token; không chấp nhận browser deviceId.

Đây là cơ chế job, **không phải** engine camera ghi 24/7. RTSP, video ingest/recording nền, GPU scheduler và worker video vẫn cần giai đoạn G3 riêng.

## Cấu hình và riêng tư

Xem `.env.example`. Tất cả endpoint/key đọc server-side; không dùng `NEXT_PUBLIC_*`, không trả key qua status API và không cho browser sửa URL worker.

- `HERMES_BASE_URL` nhận root hoặc `/v1`, giữ prefix `/p/<profile>/v1`; `HERMES_API_KEY` bắt buộc, không có key mặc định.
- Vision/OCR cần `DAI_*_BASE_URL`, `DAI_*_MODEL`; key riêng theo triển khai. Kết nối ngoài mạng riêng bắt buộc HTTPS + key.
- Mặc định chặn AI ngoài mạng riêng. Chỉ owner được bật `remoteProcessingAllowed`. Ảnh trích xuất còn cần checkbox đồng ý riêng `allowRemote` theo job; bật model/env không đồng nghĩa đồng ý gửi ảnh.
- Hostname LAN/tailnet được phân loại theo cấu hình tin cậy; đây không thay thế firewall, TLS, DNS policy hay cách ly worker.
- TTS trả về chính HTTP client đang hỏi. Không có remote speaker command; không fallback phát loa server. Client chặn audio cũ khi hủy/ngắt lời/đăng xuất.
- STT audio không lưu DB; giới hạn body 6 MB, kiểm magic bytes, timeout upstream. Giới hạn 30 giây ở client không thay thế giới hạn giải mã/duration trên audio adapter production.
- Job và hội thoại mới lọc theo user; owner có thể xem toàn bộ queue. Camera/asset lịch sử vẫn là một workspace dùng chung có RBAC, **chưa có multi-tenant/camera ACL hoàn chỉnh**. Không quảng bá sẵn sàng SaaS nhiều khách hàng.

## Cấu hình auth hiện hữu

`AUTH_SECRET` không còn fallback hardcoded; cần 32+ ký tự. Sandbox được cấp một giá trị ngẫu nhiên trong `.env`, không in ra log. Mật khẩu demo chỉ dành preview. `ADMIN_PASSWORD`/`OPERATOR_PASSWORD`/`VIEWER_PASSWORD` chỉ có hiệu lực ở lần seed đầu; tài khoản đã tồn tại dùng `scripts/set-password.ts` (qua biến môi trường, không in mật khẩu), sau đó mọi phiên cũ của tài khoản bị thu hồi.

## Nguồn chính thức

- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- https://platform.openai.com/docs/api-reference/audio/createTranscription
- https://platform.openai.com/docs/api-reference/audio/createSpeech
- https://sharp.pixelplumbing.com/api-resize/#extract

Các nguồn được tham khảo cho giao thức; không phải chứng cứ đã cài model, đo accuracy, voice latency hay kiểm thử thiết bị thật.
