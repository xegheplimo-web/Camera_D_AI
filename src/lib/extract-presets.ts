/** Task-type presets cho trang /extract: mỗi preset gắn sẵn câu lệnh điền vào ô ghi chú. */
export type TaskPreset = { type: string; label: string; note: string };

export const TASK_PRESETS: TaskPreset[] = [
  { type: "freeform", label: "Tự do", note: "Mô tả và trích xuất thông tin chính trong ảnh." },
  { type: "object_count", label: "Đếm đối tượng", note: "Đếm số lượng từng loại đối tượng trong ảnh (người, xe, đồ vật)." },
  { type: "ocr", label: "OCR văn bản", note: "Đọc và trích xuất toàn bộ văn bản xuất hiện trong ảnh." },
  { type: "plate", label: "Biển số xe", note: "Trích xuất biển số xe trong ảnh, liệt kê từng biển đọc được." },
  { type: "describe", label: "Mô tả ảnh", note: "Mô tả chi tiết nội dung ảnh: bối cảnh, người, đồ vật, chữ viết." },
];

export const taskPreset = (type: string) => TASK_PRESETS.find((p) => p.type === type);

/**
 * Preset chỉ tự điền khi ô ghi chú trống hoặc đang hiển thị đúng preset đã áp trước đó —
 * không bao giờ ghi đè văn bản người dùng tự sửa. `applied` ghi nhớ preset gần nhất đã điền.
 */
export function applyPreset(currentNote: string, appliedNote: string | null, presetNote: string): { note: string; applied: string } {
  const writable = !currentNote.trim() || (appliedNote !== null && currentNote === appliedNote);
  return { note: writable ? presetNote : currentNote, applied: presetNote };
}
