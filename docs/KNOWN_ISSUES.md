# KNOWN ISSUES — mở tại thời điểm audit 2026-11-02

| # | Mức | Vấn đề | Trạng thái xử lý |
|---|---|---|---|
| KI-01 | P2 | 26 cảnh báo mới từ 6 quy tắc react-compiler strict của `eslint-plugin-react-hooks` v7 (tổng 30 warning: set-state-in-effect, purity, static-components, refs, immutability) trên UI — pattern data-loading cũ | Tạm warning trong eslint.config.mjs; bật lại `error` khi refactor UI theo React Compiler (P1). Ghi ROADMAP |
| KI-02 | P1 | Chưa verify camera vật lý: ONVIF discovery thật, RTSP qua go2rtc thật, MJPEG proxy với nhiều camera | Chờ thiết bị thật; soak test 72h theo G2 |
| KI-03 | P1 | `tests/browser-smoke.ts` cần Playwright + server thật; chưa chạy lại trong môi trường mới trên Windows (đã có workflow E2E trên Linux runner, chờ kết quả CI) | Workflow e2e.yml đã cấu hình |
| KI-04 | P2 | Demo camera thumbnails phụ thuộc file tĩnh `public/cams/*.jpg` — ảnh demo, không phải stream thật | By design; camera thật qua đường ONVIF/RTSP |
| KI-05 | P1 | Backup/restore PostgreSQL và restore khóa CAMERA_CREDENTIAL_KEY chưa được thử nghiệm | Gate G4/G8 |
| KI-06 | P2 | MJPEG proxy không tối ưu cho nhiều camera đồng thời (README đã ghi) | Chuyển WebRTC/HLS theo ROADMAP P0 |
| KI-07 | P0 | Cảnh báo npm: `eslint@9` (no longer supported) và install script của `sharp` bị chính sách npm mặc định chặn (binary prebuilt vẫn dùng được, đã verify) | Theo dõi khi bump deps |
| KI-08 | P1 | Voice: chưa đo first-audio latency; chưa có fallback khi STT/TTS worker không khả thi (UI có degrade — cần test thật) | Gate G5 |

## Đã xử lý trong repo publish (không còn là issue mở)

- Mật khẩu fallback cứng trong seed (fail-closed) — đã trong nguồn v1.3.
- `GET /api/cameras` không auth — đã auth + mask ciphertext trong nguồn v1.3 (diff-verified).
- Credential DB hardcode trong drizzle config — đã chuyển env trong nguồn v1.3.
- Box gợi ý mật khẩu demo trên trang login — đã bỏ trong commit `ci:` của repo này.
