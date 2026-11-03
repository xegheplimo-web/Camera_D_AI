"use client";

import Link from "next/link";
import { Cpu, Database, Gauge, HardDrive, ScrollText, Trash2 } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { NoPermissionState } from "@/components/states";
import type { Admin, Settings } from "./types";

type Props = {
  isOwner: boolean;
  admin: Admin | null;
  settings: Settings | null;
  patchSettings: (patch: Partial<Settings>) => Promise<boolean>;
  onToggleDemo: (next: boolean) => void;
  phrase: string;
  setPhrase: (v: string) => void;
  adminAction: (action: string, label: string, extra?: string) => Promise<void> | void;
};

/** Nội dung tab Quản trị — chỉ mount khi role là owner/operator (xem SettingsClient). */
export default function AdminPanel({ isOwner, admin, settings, patchSettings, onToggleDemo, phrase, setPhrase, adminAction }: Props) {
  return (
    <div className="space-y-4">
      {isOwner && (
        <div className="glass flex flex-wrap items-center gap-3 p-4">
          <Cpu className="h-6 w-6 text-cyan-300" />
          <div className="flex-1"><div className="font-semibold">Trợ lý AI</div><p className="text-xs text-[#a9bad2]">Trợ lý AI xử lý câu hỏi, đọc ảnh và tóm tắt dữ liệu ngay trên máy chủ. Không tải model xuống thiết bị.</p></div>
          <Link href="/admin" className="btn btn-primary text-xs">Chi tiết kỹ thuật →</Link>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title={<span id="data" className="flex items-center gap-2"><Database className="h-4 w-4 text-amber-300" /> Dữ liệu & chế độ thật</span>}>
          <div className="space-y-3 text-sm">
            <label className="flex items-start gap-2 rounded-xl border border-white/10 p-2">
              <input type="checkbox" checked={settings?.demoMode ?? false} onChange={(e) => onToggleDemo(e.target.checked)} className="mt-0.5 accent-cyan-400" />
              <span>
                <b>Hiển thị dữ liệu mẫu</b>
                <span className="block text-xs text-[#a9bad2]">Tắt để mọi câu trả lời, thống kê và trí nhớ chỉ dùng dữ liệu thật. Bản ghi mẫu vẫn nằm trong DB nhưng bị loại khỏi truy vấn.</span>
              </span>
            </label>
            <label className="block text-xs text-[#a9bad2]">Thời gian giữ dữ liệu (ngày)
              <input type="number" min={1} max={365} value={settings?.retentionDays ?? 30} onChange={(e) => patchSettings({ retentionDays: Number(e.target.value) })} className="input mt-1" />
              <span className="mt-1 block text-[11px] text-emerald-200">Đã có hiệu lực: job retention chạy lúc khởi động và lặp mỗi 24h — xoá sự kiện/trích xuất/ảnh quá hạn (riêng camera có thể override trong mục Camera).</span>
            </label>
            <p className="text-xs text-[#a9bad2]">Sự kiện mẫu: <b>{admin?.demoEvents ?? "–"}</b> · Sự kiện thật: <b>{admin?.liveEvents ?? "–"}</b></p>
            <div className="flex flex-wrap gap-2">
              <a href="/api/report?days=30" className="btn btn-ghost">Xuất CSV 30 ngày</a>
            </div>
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Cpu className="h-4 w-4 text-emerald-300" /> AI & hiệu năng</span>}>
          <ul className="space-y-1.5 text-sm text-[#c6d4e6]">
            <li>• Nhận diện ảnh/khung hình: xử lý AI phía máy chủ; lượt đếm do trình duyệt báo được đánh dấu <b>chưa xác minh</b>.</li>
            <li>• OCR: xử lý phía máy chủ, gọi theo nhu cầu qua dịch vụ AI.</li>
            <li>• Hỏi đáp: phân tích ý định + SQL có kiểm soát; không để mô hình tự bịa số.</li>
            <li>• Tích hợp VLM cũ: {admin?.visionCloud ? <Badge color="emerald">đã bật (OPENAI_API_KEY)</Badge> : <Badge>tắt (mặc định)</Badge>} — không còn được gọi trực tiếp; cấu hình và quyền gửi dữ liệu do chủ hệ thống quản lý.</li>
            <li>• Chi phí API: $0 khi không bật VLM đám mây; chưa có bảng ước tính theo lượt.</li>
          </ul>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-xl border border-white/10 p-2"><HardDrive className="mb-1 h-4 w-4 text-cyan-300" /><div className="text-lg font-bold">{admin ? (admin.storageBytes / 1024 / 1024).toFixed(1) : "–"} MB</div><div className="text-[11px] text-[#a9bad2]">Dung lượng ảnh/clip</div></div>
            <div className="rounded-xl border border-white/10 p-2"><Gauge className="mb-1 h-4 w-4 text-emerald-300" /><div className="text-lg font-bold">{admin?.logs.length ?? "–"}</div><div className="text-[11px] text-[#a9bad2]">Bản ghi nhật ký gần đây</div></div>
          </div>
          <p className="mt-2 text-[11px] text-amber-200">Chỉ số GPU/VRAM và độ trễ suy luận chưa đo được trên bản web — sẽ có ở G3 khi có dịch vụ nền.</p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Trash2 className="h-4 w-4 text-rose-300" /> Vùng nguy hiểm (chủ hệ thống)</span>}>
          {!isOwner ? (
            <NoPermissionState what="xóa dữ liệu" />
          ) : (
            <div className="space-y-3 text-sm">
              <p className="text-xs text-[#a9bad2]">Để xác nhận, nhập chính xác <b className="font-mono text-rose-200">XOA DU LIEU</b>. Hành động được ghi vào nhật ký kèm người thực hiện.</p>
              <input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="XOA DU LIEU" className="input font-mono" aria-label="Cụm xác nhận" />
              <div className="rounded-xl border border-amber-400/20 bg-amber-500/5 p-2 text-xs text-[#a9bad2]">
                Dữ liệu mẫu sẽ xoá: <b className="text-amber-200">{admin?.demo?.events ?? "–"}</b> sự kiện · <b className="text-amber-200">{admin?.demo?.extractions ?? "–"}</b> trích xuất · <b className="text-amber-200">{admin?.demo?.assets ?? "–"}</b> ảnh (dữ liệu thật không đổi)
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => adminAction("purge_demo", "Xóa toàn bộ dữ liệu mẫu", `\nSẽ xoá ${admin?.demo?.events ?? "?"} sự kiện + ${admin?.demo?.extractions ?? "?"} trích xuất + ${admin?.demo?.assets ?? "?"} ảnh mẫu.`)} disabled={phrase !== "XOA DU LIEU"} className="btn btn-ghost"><Trash2 className="h-4 w-4" /> Xoá dữ liệu mẫu</button>
                <button onClick={() => adminAction("reset_all", admin?.demoSeedEnabled ? "XÓA TẤT CẢ dữ liệu và tạo lại dữ liệu mẫu" : "XÓA TẤT CẢ dữ liệu — hệ thống sẽ trống, KHÔNG tạo lại dữ liệu mẫu")} disabled={phrase !== "XOA DU LIEU"} className="btn btn-danger"><Trash2 className="h-4 w-4" /> Đặt lại toàn bộ</button>
              </div>
            </div>
          )}
          <p className="mt-2 text-[11px] text-[#a9bad2]">Sao lưu/khôi phục: dùng xuất CSV/JSON; quy trình backup tự động là hạng mục G7 chưa triển khai.</p>
        </Card>
      </div>

      <Card title={<span id="audit" className="flex items-center gap-2"><ScrollText className="h-4 w-4 text-cyan-300" /> Nhật ký thao tác</span>}>
        <div className="scroll-thin max-h-80 overflow-auto" tabIndex={0} role="region" aria-label="Bảng nhật ký thao tác">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#192941] text-left text-[#a9bad2]"><tr><th className="p-1.5">Thời gian</th><th>Người thực hiện</th><th>Hành động</th><th>Đối tượng</th><th>Thiết bị</th><th>Chi tiết</th></tr></thead>
            <tbody>
              {admin?.logs.map((l) => (
                <tr key={l.id} className="border-t border-white/5">
                  <td className="whitespace-nowrap p-1.5">{new Date(l.createdAt).toLocaleString("vi-VN")}</td>
                  <td>{l.actor ?? "—"} <span className="text-[#a9bad2]">({l.actorRole ?? "—"})</span></td>
                  <td className="font-mono text-cyan-200">{l.action}</td>
                  <td>{l.targetType}{l.targetId ? ` #${l.targetId}` : ""}</td>
                  <td className="font-mono text-[#a9bad2]">{l.device ?? "—"}</td>
                  <td className="max-w-xs truncate text-[#a9bad2]">{l.detail}</td>
                </tr>
              ))}
              {!admin?.logs.length && <tr><td colSpan={6} className="p-4 text-center text-slate-400">Chưa có thao tác nào hoặc bạn không có quyền xem nhật ký.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
