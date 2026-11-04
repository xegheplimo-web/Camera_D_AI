# MediaMTX — cấu hình chạy thật (Camera D-AI)

M0 (2026-11-05): khoá MediaMTX. Trước đây `F:/Camera-D-AI/runtime/mediamtx/mediamtx.yml`
nằm ngoài git và có **một user `any` mật khẩu rỗng** với đủ quyền
publish/read/playback/api cho cả dải private ⇒ bất kỳ máy nào trong LAN đọc được
luồng camera mà không cần credential (đã verify: `ffprobe rtsp://192.168.1.243:8554/cam`
trả H264 1280×720).

## Thành phần

| File | Vai trò |
| --- | --- |
| `mediamtx.yml` | Cấu hình đã track trong git. **Không chứa mật khẩu.** |
| `start-mediamtx.ps1` | Nạp user từ file secret ngoài repo rồi chạy `mediamtx.exe`. |

File secret mặc định: `%USERPROFILE%\.camdai\mediamtx.env` (không commit, không in log).

## Bốn user, quyền tách biệt

| User (env key) | Quyền | Dải IP | Ghi chú |
| --- | --- | --- | --- |
| `publisher` (`MEDIAMTX_PUBLISH_*`) | publish | private IPv4 | ffmpeg/camera đẩy luồng vào |
| `reader` (`MEDIAMTX_READ_*`) | read | private IPv4 | go2rtc/ffprobe đọc luồng |
| `playback` (`MEDIAMTX_PLAYBACK_*`) | playback | 127.0.0.1 | xem lại bản ghi |
| `any` (cố định trong script) | api | 127.0.0.1 | app gọi Control API; pass rỗng **chỉ** vì API đã bind loopback và app chưa gửi Basic auth |

`authInternalUsers: []` trong YAML là **có chủ ý**: bỏ trống khoá này thì mediaMTX
merge với 2 user `any` mặc định của nó và mở lại đúng lỗ hổng vừa vá.

## Chỉ ghi path hợp lệ

`pathDefaults.record: no`. Chỉ path khai báo trong `paths` (hiện tại `cam`) hoặc
path được control-plane bật `record: true` tường minh mới ghi hình.

## Khởi động

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File infra/mediamtx/start-mediamtx.ps1
```

Script chạy foreground (mediaMTX không tự daemon hoá). Muốn chạy nền: dùng Task
Scheduler hoặc process Hermes `persist_on_release`.

## Xoay mật khẩu

1. Sửa `MEDIAMTX_PUBLISH_PASS` / `MEDIAMTX_READ_PASS` / `MEDIAMTX_PLAYBACK_PASS`
   trong file secret (chỉ ký tự an toàn URL: `A-Za-z0-9-_`).
2. Cập nhật nơi tiêu thụ: URL publish của ffmpeg/camera, `producers` trong
   `runtime/go2rtc/go2rtc.yaml`.
3. Restart MediaMTX rồi chạy lại mục Kiểm tra.

## Kiểm tra (2 lớp)

```bash
# Lớp A — không credential phải THẤT BẠI (401)
ffprobe -v error -rtsp_transport tcp rtsp://192.168.1.243:8554/cam

# Lớp A — publish path chưa đăng ký phải 400 (kể cả khi có credential publish)
ffmpeg -f lavfi -i testsrc2=size=320x240:rate=5 -t 3 -f rtsp \
  "rtsp://publisher:<pass>@192.168.1.243:8554/khong_dang_ky"

# Lớp B — có credential read thì đọc được
ffprobe -v error -rtsp_transport tcp \
  "rtsp://reader:<pass>@192.168.1.243:8554/cam"

# Lớp B — camera thật 796 vẫn có frame (không đi qua MediaMTX)
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:1984/api/frame.jpeg?src=dai_cam_796'

# Lớp B — cấu hình user thật đang nạp
curl -s http://127.0.0.1:9997/v3/config/global/get
```
