/**
 * P1 — tính năng per-camera: nguồn sự thật duy nhất cho danh mục tính năng
 * và cách đọc cờ `camera_settings.features` (jsonb). Mỗi camera một bộ cờ
 * riêng — camera quầy thu ngân nhận diện hàng hoá, camera cửa đếm người,
 * camera cửa sau cảnh báo xâm nhập. Tắt tính năng chỉ giấu UI/ngừng sinh dữ
 * liệu mới, TUYỆT ĐỐI không xoá ảnh/ghi chú/lịch sử đã lưu.
 */
export type CameraFeatureId =
  | "watch" | "record" | "motion" | "product" | "stock"
  | "people" | "vehicle" | "intrusion" | "delivery";

export const CAMERA_FEATURES: {
  id: CameraFeatureId; label: string; hint: string; group: string;
}[] = [
  { id: "watch", label: "Xem trực tiếp", hint: "Mở luồng camera để xem trực tiếp mọi lúc.", group: "Cơ bản" },
  { id: "record", label: "Ghi hình", hint: "Lưu video trên máy chủ để xem lại và trích xuất clip.", group: "Cơ bản" },
  { id: "motion", label: "Phát hiện chuyển động", hint: "Nhận biết khi có chuyển động trong khung hình.", group: "An ninh" },
  { id: "intrusion", label: "Cảnh báo xâm nhập", hint: "Cảnh báo khi có người/vật vào khu vực cấm.", group: "An ninh" },
  { id: "product", label: "Nhận diện hàng hóa", hint: "Nhận diện sản phẩm trên quầy/kệ từ ảnh camera.", group: "Hàng hóa" },
  { id: "stock", label: "Đếm hàng trong kho", hint: "Đếm số lượng hàng tồn kho từ hình ảnh camera.", group: "Hàng hóa" },
  { id: "delivery", label: "Theo dõi giao nhận", hint: "Theo dõi hoạt động giao/nhận hàng tại cửa.", group: "Hàng hóa" },
  { id: "people", label: "Đếm người", hint: "Đếm lượt người ra vào qua vạch đếm.", group: "Đếm & nhận diện" },
  { id: "vehicle", label: "Nhận diện phương tiện", hint: "Nhận diện xe ra vào khu vực camera.", group: "Đếm & nhận diện" },
];

/**
 * Chuẩn hoá `camera_settings.features` thành map cờ đầy đủ cho client:
 * `watch` mặc định BẬT (camera nào cũng xem được trừ khi tắt rõ), mọi tính
 * năng khác mặc định TẮT. Khoá lạ (cờ tương lai) được giữ nguyên — không
 * được làm mất dữ liệu khi đọc. Input lỗi (null/mảng/chuỗi/số) trả về
 * mặc định, không ném lỗi.
 */
export function normalizeFeatures(raw: unknown): Record<CameraFeatureId, boolean> {
  const o = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const out: Record<string, unknown> = { ...o };
  out.watch = o.watch !== false;
  for (const f of CAMERA_FEATURES) {
    if (f.id !== "watch") out[f.id] = o[f.id] === true;
  }
  return out as Record<CameraFeatureId, boolean>;
}
