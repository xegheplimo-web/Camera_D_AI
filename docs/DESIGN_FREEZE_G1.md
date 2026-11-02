# G1 — Camera D-AI Design Freeze v1.0

Tài liệu sống; bản tương tác nằm trong ứng dụng tại `/design` (yêu cầu đăng nhập).

## 1. Định vị

Trợ lý camera AI có trí nhớ: quan sát – ghi nhớ – trích xuất – tính toán – trò chuyện tiếng Việt. Robot là điểm tương tác, không phải vật trang trí. Mọi câu trả lời phải kèm bằng chứng hoặc nói rõ chưa đủ dữ liệu.

## 2. Design tokens

| Token | Giá trị | Vai trò |
|---|---|---|
| Background | `#080F1E` | Nền ứng dụng |
| Surface | `#111D31` | Card, panel |
| Raised surface | `#192941` | Dialog, sheet, control |
| Primary | `#22D3EE` | Nút và tương tác chính |
| Secondary | `#6685FF` | Thành phần phụ |
| Text | `#F3F7FF` | Chữ chính |
| Muted | `#A9BAD2` | Chú thích |
| Success | `#34D399` | Thành công |
| Warning | `#FBBF24` | Cảnh báo |
| Danger | `#FB7185` | Lỗi/nguy hiểm |

- Bo góc 12–20px, khoảng cách hệ 4/8px, vùng chạm ≥ 44×44px.
- Responsive 360px → 1920px; hỗ trợ tăng cỡ chữ và `prefers-reduced-motion`.
- Chỉ phát sáng khi tương tác/focus; panel tĩnh dùng surface phẳng.

## 3. Robot D-AI Bot — 7 trạng thái

| Trạng thái | Chuyển động | Thông báo |
|---|---|---|
| idle | chớp mắt, thở nhẹ | Sẵn sàng hỗ trợ |
| listening | mắt mở, vòng sáng tai | Đang lắng nghe |
| thinking | mắt di chuyển, vòng quay | Đang tìm trong trí nhớ |
| speaking | miệng/đèn theo âm | Đang trả lời |
| alert | viền cam, mắt nhọn | Có sự kiện cần xem |
| offline | đèn dịu, mắt ngang | Mất kết nối |
| error | mắt lo lắng nhẹ | Không xử lý được yêu cầu |

Có prop `still` cho thiết bị yếu/chế độ giảm chuyển động. Bản 3D runtime không bắt buộc ở G1: SVG hiện tại thay được bằng sprite/render sau mà không đổi API.

## 4. Bố cục

- **Windows**: sidebar điều hướng + robot/phiên; trung tâm camera, thao tác nhanh, chỉ số, sự kiện; phải hội thoại AI.
- **Mobile**: robot thu nhỏ + ô hỏi đáp/mic là trung tâm, bên dưới camera gần nhất và sự kiện; 5 tab dưới cùng.
- Chỉ số home: camera online, lượt vào/ra, cảnh báo, dung lượng, lần đồng bộ gần nhất, tỷ lệ dữ liệu mẫu.

## 5. Màn hình

01 Home · 02 Camera Live · 03 Ảnh & Trích xuất · 04 Hỏi đáp giọng nói · 05 Trí nhớ · 06 Thống kê · 07 Cảnh báo · 08 Cài đặt & quản trị. Chi tiết trạng thái và hành vi nút: xem tab “Màn hình & trạng thái” và “Hành vi nút” tại `/design`.

## 6. Bộ trạng thái bắt buộc

chưa có dữ liệu · đang tải · đã có dữ liệu · đang xử lý AI · thành công · lỗi có thể thử lại · mất mạng/mất máy chủ · không có quyền · AI chưa đủ bằng chứng · camera/mic bị từ chối. Component dùng chung: `EmptyState`, `LoadingState`, `ErrorState`, `NoPermissionState`, `OfflineBanner`.

## 7. Nguyên tắc dữ liệu

- Không cho AI tự bịa số: số liệu từ SQL/aggregation; LLM (nếu bật) chỉ diễn đạt.
- Phân biệt rõ: **đang thấy** (occupancy ước lượng), **lượt vào/ra** (đếm qua vạch), **ước tính bên trong** (chênh lệch, không phải số duy nhất).
- Kết quả ảnh: phân biệt dữ liệu AI quan sát với dữ liệu người dùng sửa (`rawResult` vs `result`, cờ `edited`).
- Sự kiện do client báo được gắn nhãn và cần duyệt.
- Mỗi thống kê có định nghĩa, phạm vi, múi giờ, bộ lọc, tỷ lệ dữ liệu mẫu.

## 8. Quyết định kỹ thuật

Giữ React/Next.js, làm web responsive/PWA trước; tách client khỏi backend khi đóng gói Windows/Android ở giai đoạn sau. Không chuyển sang Flutter ở G1 để tránh làm lại giao diện.

## 9. Điều kiện duyệt G1

1. Mọi màn hình có đủ 10 trạng thái ở mức chấp nhận được.
2. Bảng hành vi nút không còn mục “chưa rõ”.
3. Robot đủ 7 trạng thái + bản tĩnh.
4. Token và responsive đã áp dụng thực tế trong CSS.
5. Các mục chưa hỗ trợ được ghi rõ, không giả lập là đã có.


## Cập nhật — Thin client / Hermes orchestration

Giữ layout và robot. Thêm `/orchestration` để xem hai đường xử lý, health worker, tiến độ và retry/cancel. Chat hiển thị nhãn fast/Hermes/fallback; trích xuất dùng job phía server và consent cho AI ngoài mạng riêng. Xem `HERMES_ARCHITECTURE.md`. Các điểm G1 chưa có test thiết bị/model thật vẫn giữ trạng thái một phần, không nâng gate chỉ vì adapter đã build được.
