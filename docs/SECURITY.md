# Camera D-AI — Security foundation (trạng thái hiện tại)

Đây là một workspace camera có RBAC, chưa phải hệ thống SaaS multi-tenant đã kiểm thử production. Đọc thêm `HERMES_ARCHITECTURE.md` cho trust boundary mới.

## Các kiểm soát đã triển khai

- Cookie `dai_session` ký HMAC-SHA256, httpOnly, SameSite=Lax, Secure ở production; hạn 12 giờ. `AUTH_SECRET` phải có 32+ ký tự, không còn khóa fallback cố định trong source.
- Next.js 16 `src/proxy.ts` kiểm chữ ký **và** session DB/user hiện tại cho mọi protected page/API, kể cả media. User disabled, session revoked/expired hoặc role đổi không được tiếp tục dùng quyền từ token cũ.
- API gọi lại `authorize()` cho hành động cụ thể. Owner: quản trị/xóa; operator: vận hành/kiểm duyệt; viewer: xem/hỏi. Hội thoại riêng có thể tự xóa; không cho viewer xóa media/sự kiện gốc.
- API quản trị nguy hiểm yêu cầu owner + cụm `XOA DU LIEU`; event/extraction delete yêu cầu quyền và xác nhận; audit lấy danh tính từ session, không từ browser deviceId.
- Mutation request có Origin phải khớp Host/URL của Gateway. Không dùng forwarded host do client tự khai làm nguồn tin cậy. JSON-only ở các API AI mới. Client không có đường sửa endpoint/key worker.
- Job và message mới lọc user id. Owner có thể xem toàn bộ queue. Không chấp nhận user/role/device từ body để định danh.
- Rate limit theo phiên/user ở chat, job control, probe, extraction, frame, STT/TTS. Đây là fixed-window per-process; cần distributed limiter ở production nhiều instance.
- Hàng đợi dùng transaction, advisory lock và row lock; cùng key nhưng nội dung khác bị từ chối. Run-token + trạng thái DB chặn write sau cancel/retry/reclaim.
- Hermes chỉ là planner hạn quyền. Trước khi gửi user text, kiểm `/v1/toolsets`; còn terminal/file/web tool hoặc không xác minh được → fallback. Plan chỉ nhận tool name allowlist, không SQL/URL/code tùy ý. Không cấp DB credentials cho Hermes.
- Model/image/audio endpoints chỉ đọc biến môi trường server-side. Bearer key không vào UI, DB job hay logs. Redirect upstream bị chặn; timeout và cap JSON response 2 MB.
- AI ngoài mạng riêng mặc định tắt, endpoint remote cần HTTPS/key và owner opt-in. Trích xuất ảnh cần thêm consent per-job. Mặc định không tự gọi API đám mây chỉ vì tồn tại `OPENAI_API_KEY` cũ.
- Public event-ingestion luôn đánh dấu lượt đếm/phát hiện là `clientReported=true`; SQL totals loại chúng tới khi được duyệt. Client OCR/counts trong extraction payload bị bỏ qua; server đọc/cắt ảnh gốc.
- Worker output được kiểm schema, count/bbox, giữ `rawResult`, phân biệt bản sửa và `verifiedBy`. Ghi chú có số không được lấy làm fact.
- Audio chỉ được trả cho HTTP client đang hỏi, không điều khiển loa server/paired device. Hủy/ngắt lời/đăng xuất chặn playback trễ; STT audio không lưu DB.
- Media response `private, no-store`, không cache API trong service worker. Demo images `/cams/*` là tài nguyên minh họa công khai, không phải camera riêng tư.
- Body/frame/audio và kích thước pixel bị giới hạn; crop/decode trong `sharp`. CSV export escape quote và tiền tố công thức để giảm spreadsheet injection.
- Dispatcher endpoint tách khỏi cookie auth, yêu cầu `DAI_DISPATCH_TOKEN` riêng (32+ ký tự) và constant-time comparison. Token không có thì endpoint fail closed.

## Khoảng trống còn lại

1. Camera và asset lịch sử là dữ liệu workspace chung; chưa có tenant key/row-level tenant policy và camera ACL hoàn chỉnh.
2. Chưa có service identity/mTLS từng worker, secret vault, network allowlist/IP pinning đầy đủ. Cấu hình endpoint vẫn là quyền tin cậy của operator triển khai; phân loại LAN hostname không thay firewall/TLS.
3. Các tài khoản demo/password seed phải thay trước khi cho người khác truy cập. Seed env không đổi mật khẩu tài khoản đã tồn tại.
4. Gateway abort HTTP và chặn kết quả muộn; chưa chứng minh model/GPU phía worker thực sự dừng compute khi cancel. External retries cần worker hỗ trợ idempotency riêng.
5. Camera background ingest/RTSP/tracking chính xác, retention daemon, encrypted backup/restore, monitoring, quota tài nguyên và soak test chưa triển khai.
6. Chưa có benchmark model/giọng nói/loa thật, scan dependency/security đầy đủ hoặc xác nhận production readiness. Test fixture chỉ chứng minh hợp đồng ứng dụng.
7. Upload media store hiện nằm trong PostgreSQL dạng payload; cần file/object storage riêng và policy media ở quy mô lớn.
8. Passwords dùng scrypt; login limiter per-process và session TTL chưa thay cho MFA, account lockout và session management production đầy đủ.

## Đổi mật khẩu hiện hữu an toàn

Đặt `DAI_RESET_LOGIN` và `DAI_RESET_PASSWORD` (14+ ký tự) trong môi trường riêng rồi chạy `npm exec tsx -- scripts/set-password.ts`. Script dùng Drizzle, không in mật khẩu, cập nhật hash và thu hồi mọi phiên của user. Không truyền password vào URL hoặc ghi vào git.

Biến `ADMIN_PASSWORD`, `OPERATOR_PASSWORD`, `VIEWER_PASSWORD` chỉ dùng khi seed lần đầu. Sandbox có tài khoản demo để đánh giá UI; không mở public WAN với mật khẩu này.

## Trước khi triển khai đa thiết bị

Đặt secret/key độc lập, đổi mật khẩu demo, tắt demoMode, dùng TLS + VPN/tailnet/firewall, kiểm profile Hermes và log quyền, chạy bộ test, kiểm retention/backup thật. Chỉ phát hành nhiều khách hàng sau khi có tenant/camera ACL và chứng cứ security/load/recovery tương ứng.
