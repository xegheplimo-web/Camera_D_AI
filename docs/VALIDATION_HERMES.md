# Kết quả kiểm tra — Gateway + Hermes adapters

Đây là kết quả đã chạy trong sandbox, không phải target hoặc benchmark model.

| Kiểm tra | Kết quả |
|---|---|
| `npx next typegen` | PASS |
| `npm exec tsc -- --noEmit --pretty false` | PASS |
| `npm run build` | PASS |
| Unit + API contract integration | Node test runner: 26 tests, 26 pass, 0 fail |
| Production startup + `/api/health` | PASS qua công cụ build_and_start |
| Chromium browser smoke | PASS: login, fast SQL, Hermes fallback, Memory async report, upload/note draft, missing-worker error |
| Responsive | PASS: 1440×1000, 768×1024, 390×844, 360×800; không tràn ngang ở trang Điều phối AI |
| Browser runtime/model requests | Không có uncaught page error; không có TensorFlow/Tesseract/model download trong các luồng đã kiểm tra |

## Artifacts thực

- `artifacts/validation/next-typegen.log`
- `artifacts/validation/typescript.log` (không có diagnostics)
- `artifacts/validation/production-build.log`
- `artifacts/validation/ai-tests.log`
- `artifacts/validation/browser-smoke.log`
- `artifacts/screenshots/orchestration-desktop.png`
- `artifacts/screenshots/orchestration-mobile.png`
- `artifacts/screenshots/chat-fallback-desktop.png`
- `artifacts/screenshots/extract-no-worker-desktop.png`

Các ảnh chụp dùng tài khoản operator thử riêng; ảnh upload trong smoke test là pixel fixture, không phải ảnh camera/ground-truth. User/job/media thử được dọn sau test.

## Không suy diễn từ kết quả này

- API integration dùng HTTP fixture cho Hermes/Vision/OCR/Voice; chỉ Memory/SQL chạy truy vấn thật trên dữ liệu test PostgreSQL.
- Không có instance Hermes, model GPU/OCR/STT/TTS thật được cấu hình trong preview. UI hiển thị chưa cấu hình và fallback đúng như kiểm tra.
- Không đo accuracy, count MAE, WER, first-audio/P95 hoặc speaker isolation trên thiết bị thật.
- Chromium headless không thay cho test Windows 11/Android/iOS/loa/micro/Bluetooth phần cứng.
- Chưa có Video Worker, RTSP, camera background 24/7, multi-tenant hoàn chỉnh hoặc security/soak certification.

Trạng thái: ứng dụng và ranh giới tích hợp hoạt động; **không tuyên bố production-ready cho triển khai camera AI nhiều khách hàng**.
