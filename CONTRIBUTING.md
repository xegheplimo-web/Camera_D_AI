# Đóng góp cho Camera D-AI

Cảm ơn bạn muốn đóng góp. Dự án dùng mô hình **Open-Core + dual licensing**, nên mọi đóng góp
phải bảo đảm dự án có quyền phân phối lại dưới **cả** AGPL-3.0 **và** giấy phép thương mại.

## Quy trình

1. Mở issue mô tả vấn đề/thay đổi trước khi viết mã lớn.
2. Fork → branch ngắn (`fix/...`, `feat/...`).
3. Mỗi commit phải có **Signed-off-by** (DCO):
   `git commit -s -m "feat: ..."` — xác nhận bạn có quyền gửi đóng góp này.
4. Bắt buộc: `npm run typecheck`, `npm run lint`, test liên quan PASS. CI phải xanh.
5. PR mô tả: vấn đề, cách sửa, cách kiểm chứng (lệnh + kết quả thật), ảnh hưởng tới
   camera/recording/AI/chat.

## Thỏa thuận cấp phép đóng góp (CLA)

Ngoài DCO, với thay đổi **không nhỏ** (tính năng mới, refactor lớn), người đóng góp cần đồng ý
CLA tối thiểu:

> Tôi cấp cho chủ dự án quyền không giới hạn, không thu phí, không huỷ ngang để sử dụng,
> sửa đổi và phân phối lại đóng góp của tôi dưới AGPL-3.0 **và** dưới giấy phép thương mại,
> và xác nhận tôi có quyền cấp quyền đó.

Ghi dòng xác nhận trong PR: `CLA: accepted`.

## Không được gửi

- Mã, model, dữ liệu hoặc ảnh **không rõ nguồn gốc** hoặc không tương thích AGPL-3.0.
- Model có giấy phép hạn chế thương mại (ví dụ YOLO/Ultralytics AGPL với điều khoản riêng,
  CC-BY-NC) trừ khi có quyết định rõ ràng bằng văn bản.
- Bí mật, khóa API, mật khẩu camera, dữ liệu khách hàng thật.

## Bảo mật

Không mở issue công khai cho lỗ hổng. Xem `SECURITY.md`.
