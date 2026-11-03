# Báo cáo lỗ hổng bảo mật

**Không** mở issue công khai cho lỗ hổng chưa được xử lý.

## Kênh

Gửi email tới chủ sở hữu repository (địa chỉ trong phần Contact của GitHub) với tiêu đề
`[SECURITY] Camera D-AI` và nội dung:

- Mô tả lỗ hổng, mức ảnh hưởng (đọc được gì/chiếm được gì).
- Bước tái hiện tối thiểu.
- Phiên bản/commit bị ảnh hưởng.
- Bằng chứng (log, ảnh chụp) — **đã che** mật khẩu, token, URL RTSP có credential.

## Cam kết

- Phản hồi trong 72 giờ làm việc.
- Không tiết lộ công khai trước khi có bản vá hoặc sau 90 ngày, tuỳ mức độ.
- Ghi nhận tên người báo cáo (nếu muốn) trong ghi chú phát hành.

## Phạm vi ưu tiên

Xác thực/phân quyền, rò rỉ credential camera (RTSP URL, mật khẩu), truy cập chéo tenant,
path traversal khi phát lại/xuất clip, SSRF qua URL camera, và rò rỉ dữ liệu trong log.
