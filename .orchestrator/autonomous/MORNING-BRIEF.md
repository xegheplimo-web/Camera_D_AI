# Việc cần Sếp quyết — chờ sáng

Các agent autonomous tự ghi thêm vào mục "Cần Sếp" khi gặp blocker không tự quyết được
(tiền, credential, phá huỷ không hoàn tác, pháp lý). Không agent nào được tự xử lý các mục này.

> **TL;DR — 3 câu trả lời mở khoá toàn bộ phần còn lại của dự án:**
> 1. "cho phép M1" → recreate `camdai-pg` (+healthcheck, giữ volume, ~10s downtime).
> 2. Cấp `SONAR_TOKEN` + `SONAR_PROJECT_KEY` → mở Q1, Q2, M10.
> 3. "cho phép M2/M3" → tạo role `app_rw` least-privilege rồi bật RLS.
> M2/M3/M9 đang chờ M1; ngoài 3 mục này không còn gì bị kẹt.

## Cần Sếp (chặn milestone)

| # | Milestone | Cần gì | Vì sao không tự làm được | Cách mở khoá |
|---|-----------|--------|--------------------------|--------------|
| 1 | Q1 | `SONAR_TOKEN` + `SONAR_PROJECT_KEY` (SonarCloud) | Gate Q1 = "0 BUG trên SonarCloud". Không có token ⇒ gate trả exit 3 (UNVERIFIABLE), loop từ chối `done`. Đã dò `.env`, `~/.camdai/*.env`, `.env.local`, config Hermes — không có. | Thêm 2 biến vào `C:\Users\atton\AppData\Local\hermes\.env` hoặc `F:\Camera-D-AI\publish\Camera_D_AI\.env`, rồi `python loop.py unblock Q1` |
| 2 | Q2 | cùng token trên | Gate Q2 = "0 VULNERABILITY". 16 lỗi đều trong `.github/workflows` (action chưa pin SHA, có `npx`, pip install không pin). | như trên, rồi `python loop.py unblock Q2` |
| 3 | M10 | cùng token trên | Gate M10 = Sonar new-code violations = 0 | như trên, rồi `python loop.py unblock M10` |
| 4 | PR #44 | Quyết định pháp lý: AGPL-3.0 + commercial license | PR đang `CONFLICTING/DIRTY`, nội dung là giấy phép — quyết định của chủ dự án, không phải kỹ thuật | Sếp chọn hướng, em rebase + merge |
| 5 | EZVIZ | Rotate credential camera | Credential đang plaintext ở `C:\Users\atton\.camdai\ezviz-rtsp.env`; đổi mật khẩu camera là thao tác trên thiết bị thật, có thể làm mất stream 796 | Sếp đổi trên app EZVIZ rồi cấp giá trị mới, em cập nhật file + verify frame 200 |

## Đã xong đêm nay — gate chạy thật, không phải "đã viết code"

| Commit | Milestone | Bằng chứng |
|--------|-----------|-----------|
| `e5068d2` | **M5** audit ghi sai danh tính | `audit()` nhận actor tường minh; login truyền identity của user vừa xác thực; `test:h01h` 2/2 (login B khi còn cookie A ⇒ ghi B), `test:h01g` 6/6 |
| `3c63c7c` | (việc của Sếp) preview ảnh bằng `next/image` | giữ nguyên thay đổi chưa commit của Sếp, không mất |
| `3725580` | **M6** quota ghi hình | `selectOldestToDelete` + `enforceRecordingQuota`; `RECORDING_QUOTA_GB=50`, đang dùng 24.57 GB; `test:m6` 5/5, test chỉ chạy trong thư mục tạm |
| `f27d679` | **M7** giới hạn consumer | MediaMTX `cam.maxReaders=10`, `all_others=16` (hot-reload, cùng PID, anon RTSP vẫn 401); app cap 8 → 429 + `Retry-After`; `test:m7` 4/4 |
| `c373a59` | **M8** backup/restore | diễn tập restore thật, md5 khớp **9/9 bảng**, marker `restore_verified.json` |
| `3e4555c` | **P1** cấu hình TỪNG camera (spec của Sếp) | registry 9 tính năng; drawer chỉ hiện mục của tính năng đã bật; tắt tính năng **không xoá** ảnh/sản phẩm; `test:p1` 6/6 |
| `cb2384a` | **P2** sản phẩm gắn nhiều camera | bảng `camera_products` (n-n) tạo bằng DDL chỉ-thêm, KHÔNG dùng `drizzle-kit push` trên DB thật; API tenant-scoped + audit; camera B không thấy sản phẩm của A; `test:p2` 6/6 |
| `ac250fe` | **P3** tường camera | route `/wall`, lưới kéo-thả, layout lưu theo **tenant+user**; tile lấy snapshot mỗi 3s nên **không chiếm slot MJPEG** (wall 10 camera không bóp chế độ xem 1 camera); `test:p3` 6/6 |
| `c519ef1` | Test bắt lỗi (RED) | `test:responsive` đo tràn ngang bằng Playwright; sửa `t1336` theo spec mới |
| `0405ac1` | **Sửa regression do P1** | P1 đã **xoá 6 switch AI** (live/record/playback/snapshot/ask/pricing) khỏi drawer và thay bằng mục mới. Đã khôi phục nguyên vẹn cơ chế "Chưa khả dụng" + PATCH theo revision; `test:t1336` 9/9 (không nới assertion nào) |
| `a749759` | **Siết gate** | Gate P1 giờ **bắt buộc** `test:t1336` xanh — gate chỉ kiểm cái được thêm thì không thấy cái bị xoá. Gate cũng tự nạp `.env` nên verdict không phụ thuộc env của người gọi |
| `c0d158e` | **P1 Responsive (lỗi trang chủ)** | Đo được tràn `2184px @1024`, `2176px @768`, `2565px @375`. Nguyên nhân: grid trang chủ không khai báo cột dưới `xl` ⇒ track `auto` nới theo max-content. Sửa `grid-cols-1` + `min-w-0` cho 3 con. **Không** dùng `overflow-x:hidden`. `test:responsive` **18/18 PASS**, tỉ lệ 16:9 vẫn 1.778 |

Trước đó: **M0** (khoá MediaMTX — anon RTSP 401, camera 796 frame 200) và **M4** (camera EZVIZ 796 online) đã xong.

## P4 đang làm — "Ghi vào máy" (spec mới của Sếp, 03:00)

Ba chức năng phải **tách bạch**, không gộp:

| Chức năng | Chạy ở đâu | Lưu ở đâu |
|---|---|---|
| Ghi tự động | máy chủ (MediaMTX + quota 50 GB đã có) | `runtime/recordings` |
| **Ghi vào máy** (mới) | trình duyệt | file người dùng tải về |
| Xem lại | máy chủ (RecordingsPanel đã có) | phát lại / tải đoạn |

Quyết định kỹ thuật đã chốt (vì `MediaRecorder` **không** đọc được `<img>` MJPEG):
vẽ frame đang decode vào `<canvas>` (`drawImage`) ~10 fps → `canvas.captureStream(10)`
→ `MediaRecorder` → Blob → `<a download>` để trình duyệt hỏi nơi lưu. Webcam thì ghi
trực tiếp `MediaStream`. **Không** ghi đĩa bằng code, **không** đụng recorder máy chủ.

Kèm 2 việc Sếp nêu: camera mới thêm phải `recordEnabled: true` (schema đang mặc định
`false`), và nút **Xem lại** phải có ngay trên camera ở trang chủ.

Gate P4 đã đăng ký và đang **đỏ** (đúng): `test:p4` + kiểm module không dùng `fs`
+ kiểm component có `captureStream`/`download` + kiểm API tạo camera bật ghi
+ `test:t1336` vẫn xanh.

## Loop tự bắt lỗi của chính nó (để Sếp tin, không phải tin lời em)

- `loop.py` là state machine, **không có LLM trong gate**: gate exit 0 mới được `done`.
- Gate chạy được từ **mọi thư mục** (trước đó `loop.py done` gọi gate từ sai cwd ⇒ fail oan — đã sửa).
- Mỗi milestone `done` lưu sha256 trên file liên quan; file đổi ⇒ tự `stale`, milestone phụ thuộc mất READY.
- Fencing: run đang mở thì runner thứ hai bị từ chối (`RUN IN PROGRESS`, exit 2) — cron 30 phút không giẫm chân.
- 4 lỗi của chính gate bị bắt trong đêm: `npm` không resolve trên Windows (PATHEXT); gate M5 false PASS (chỉ grep từ khoá); gate M7 regex không chịu thụt lề YAML; gate M5 chọn nhầm `h01g` rồi in "green" dù không hề chạy.
- Test **không có script trong `package.json`** bị coi là FAIL, không được bỏ qua im lặng (đúng lý do `h01g` đã mục 2 assertion mà không ai biết).
- Loop v2: `python test_loop.py` → **14/14 GREEN**; có `block --hard` (credential = dead-end, park ngay) và `unblock`.

## Ghi chú vận hành

- Cron: `a0f399983569`, mỗi 30 phút, workdir `F:\Camera-D-AI\publish\Camera_D_AI`.
- Watchdog: task `Hermes_CamDai_LoopWatchdog`, mỗi 10 phút, log `C:\Users\atton\AppData\Local\hermes\logs\camdai-loop-watchdog.log`.
- Fence heartbeat: `C:\Users\atton\AppData\Local\hermes\bin\camdai-fence-heartbeat.sh` (giữ run không bị coi là chết khi agent dài hơi).
- Trạng thái: `python loop.py status` trong `.orchestrator/autonomous`.
- **App `:3000` đang chạy** build mới nhất (`/wall` có trong route table): root 307, health 200, `/login` 200, `/api/cameras/1/snapshot` chưa đăng nhập → 401. Log `C:\Users\atton\AppData\Local\hermes\logs\camdai-app-3000.log`.
- Nếu app trả 500 bất thường: `netstat -ano | grep :3000` — có thể còn server `next start` sót từ test của Devin; kill PID đó rồi `npm start`.
- `python loop.py next` → **NOTHING READY (exit 2)**: mọi việc còn lại đều chờ Sếp, không phải loop treo.
