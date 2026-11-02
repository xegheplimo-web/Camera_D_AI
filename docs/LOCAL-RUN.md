# LOCAL-RUN — Runtime camera thật trên máy local (REAL-001)

Tài liệu này mô tả stack local đã chạy thật: **ffmpeg testsrc2 → mediaMTX (RTSP :8554) → go2rtc (:1984) → app MJPEG**, kèm cách tái dựng từ 0 và lệnh kiểm chứng. Không thay đổi logic nghiệp vụ `src/`.

```
ffmpeg testsrc2 720p@10fps --RTSP--> mediaMTX :8554/cam --RTSP--> go2rtc --MJPEG--> Next.js /api/cameras/{id}/stream
        publisher loop          0.0.0.0 (LAN IP)        127.0.0.1:1984 (api loopback)
```

## Bố cục thư mục

| Đường dẫn | Vai trò |
|---|---|
| `F:\Camera-D-AI\runtime\go2rtc\` | `go2rtc.exe` 1.9.15 portable + `go2rtc.yaml` |
| `F:\Camera-D-AI\runtime\mediamtx\` | `mediamtx.exe` 1.21.3 + `mediamtx.yml` |
| `F:\Camera-D-AI\runtime\pids\` | pidfile từng thành phần (`go2rtc.pid`, `mediamtx.pid`, `publisher.pid`) |
| `F:\Camera-D-AI\runtime\logs\` | `*.out.log` / `*.err.log` / `ffmpeg-publisher.log` |
| `scripts/local/stack.ps1` | Điều khiển `start`/`stop`/`status` |
| `scripts/local/rtsp-publisher.ps1` | Vòng lặp ffmpeg publish RTSP (do stack.ps1 spawn) |
| `scripts/local/ai-status.ps1` | Probe AI runtime local (llama.cpp router) |
| `.env.local.example` → `.env.local` | Cấu hình AI local (gitignored) |

## 1. Cài binary (đã làm sẵn — ghi lại để tái dựng)

```powershell
# go2rtc 1.9.15 win64 + mediaMTX 1.21.3 win-amd64, từ GitHub release chính thức:
#   https://github.com/AlexxIT/go2rtc/releases/download/v1.9.15/go2rtc_win64.zip
#   https://github.com/bluenviron/mediamtx/releases/download/v1.21.3/mediamtx_v1.21.3_windows_amd64.zip
# Giải nén vào F:\Camera-D-AI\runtime\{go2rtc,mediamtx}\
```

`go2rtc.yaml` tối thiểu (quan trọng — xem "Cạm bẫy" bên dưới):

```yaml
api:
  listen: 127.0.0.1:1984      # API quản trị CHỈ loopback — app cố định GO2RTC_HOST=127.0.0.1
rtsp:
  listen: 127.0.0.1:8554
webrtc:
  listen: :8555
# KHÔNG khai báo `streams:` — go2rtc tự ghi key khi app PUT /api/streams.
```

`mediamtx.yml`: `rtspAddress: :8554` (wildcard — bắt buộc để phục vụ IP LAN), `apiAddress: 127.0.0.1:9997`, auth `any` giới hạn dải private+loopback, path `cam`. Đầy đủ trong `F:\Camera-D-AI\runtime\mediamtx\mediamtx.yml`.

## 2. Điều khiển stack

```powershell
powershell -NoProfile -File scripts\local\stack.ps1 -Action start    # idempotent, in URL RTSP
powershell -NoProfile -File scripts\local\stack.ps1 -Action status   # port probes + HTTP health
powershell -NoProfile -File scripts\local\stack.ps1 -Action stop     # chỉ kill process của stack
```

- `start` tự phân giải IP LAN (IPv4 của interface giữ default route) — override bằng `-LanIp`/`DAI_LAN_IP`.
- `stop` chỉ dừng process khớp pidfile + marker CommandLine, quét sót theo marker runtime — **không động process ngoài** (app :3000, Postgres an toàn).
- Override thư mục runtime: `-RuntimeDir`/`DAI_RUNTIME_DIR`.

## 3. Thêm camera vào app

`validateCameraUrl()` chỉ nhận `rtsp://` tới **IPv4 private** và chặn loopback — phải dùng IP LAN của máy, không `127.0.0.1`:

```
rtsp://<IP-LAN>:8554/cam      # vd: rtsp://192.168.1.238:8554/cam
```

Trong UI: Camera → Thêm → `sourceType=rtsp`, dán URL trên. Hoặc qua API (cần session cookie role `manage`, vd user `operator`):

```bash
curl -X POST localhost:3000/api/cameras -H "Cookie: $C" -H "Content-Type: application/json" \
  -d '{"name":"local rtsp","location":"local","sourceType":"rtsp","rtspUrl":"rtsp://192.168.1.238:8554/cam"}'
curl -X POST localhost:3000/api/cameras/<id>/connect -H "Cookie: $C"
curl -N  localhost:3000/api/cameras/<id>/stream  -H "Cookie: $C"   # multipart/x-mixed-replace
```

## 4. Kiểm chứng

```bash
curl -s http://127.0.0.1:1984/api                                            # go2rtc api -> 200
ffprobe -v error -rtsp_transport tcp rtsp://192.168.1.238:8554/cam           # thấy stream h264
ffmpeg -rtsp_transport tcp -i rtsp://192.168.1.238:8554/cam -t 2 -f null -   # ~20 frame/2s
node .devin/real-001/verify-app-flow.mjs http://localhost:3000 <login> <pw> <rtspUrl> 5
#   -> login/create/connect/stream + đếm frame MJPEG (đạt 51 frame/5s lúc verify)
powershell -File scripts\local\ai-status.ps1                                 # probe llama.cpp router
```

## 5. AI service local

- Cấu hình mẫu: `.env.local.example` → copy `.env.local` (gitignore), điền `HERMES_API_KEY` đọc từ
  `%LOCALAPPDATA%\hermes\runtimes\llamacpp\server.json` (`scripts/local/ai-status.ps1` in sẵn base_url + model).
- Model thật trên máy này: `Qwen3.8-27B-TurboFCFusion-735-882-Here-Uncen-NEO-CODER-MAX-MTP-Q4_K_S` (llama.cpp router :18434 — **hiện chưa chạy**, ai-status sẽ báo).
- `DAI_VISION/OCR/VOICE_*`: chỉ điền khi có worker thật (OpenAI-compatible `/v1`).
- App đang chạy đọc `.env`/`.env.local` lúc khởi động — thay đổi env cần restart app mới nạp.

## Cạm bẫy đã gặp (đừng lặp lại)

1. **`streams: {}` trong go2rtc.yaml → PUT /api/streams trả 400** (`yaml: did not find expected key`) trên go2rtc 1.9.15. Parser patch-config không chịu map rỗng — bỏ hẳn key `streams:`. File comment UTF-8/dấu tiếng Việt cũng khiến parser này lỗi → giữ yaml ASCII.
2. **`127.0.0.1` không được làm URL camera** — bị `validateCameraUrl` chặn (chính sách SSRF). mediaMTX bind wildcard `:8554`; truy cập qua IP LAN. Trên Windows, `127.0.0.1:8554` (go2rtc) và `0.0.0.0:8554` (mediaMTX) bind cùng tồn tại; client loopback thấy go2rtc, client LAN-IP thấy mediaMTX.
3. **ffmpeg bắt buộc ở hai chỗ**: publisher testsrc2 và nhánh `ffmpeg:...#video=mjpeg` mà app tự đăng ký trong go2rtc (go2rtc spawn ffmpeg theo PATH của process — `stack.ps1` đảm bảo PATH chứa ffmpeg).
4. **`Get-NetTCPConnection` thiếu socket** trên máy này (các socket của binary Go không liệt kê dù đang phục vụ) → `stack.ps1` dùng TCP-connect probe + CIM process scan, không dùng bảng listener.
5. **File `.ps1` phải ASCII** — Windows PowerShell 5.1 đọc file không BOM theo ANSI, hỏng cú pháp nếu có dấu tiếng Việt.

## Logs & debug

| Thành phần | Log |
|---|---|
| go2rtc | `F:\Camera-D-AI\runtime\logs\go2rtc.{out,err}.log` |
| mediaMTX | `F:\Camera-D-AI\runtime\logs\mediamtx.{out,err}.log` |
| publisher/ffmpeg | `F:\Camera-D-AI\runtime\logs\ffmpeg-publisher.log` |
| app | `C:\Users\atton\AppData\Local\hermes\cache\scratch\camdai-3000.log` |
