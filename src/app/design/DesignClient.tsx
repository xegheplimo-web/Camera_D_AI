"use client";

import { useState } from "react";
import { CheckCircle2, CircleDashed, XCircle, Palette, Bot, LayoutGrid, ListChecks, Route, ClipboardList, ShieldAlert } from "lucide-react";
import Robot, { MOOD_LABEL } from "@/components/Robot";
import type { RobotMood } from "@/components/AppState";
import { Badge } from "@/components/ui";

type Status = "met" | "partial" | "missing";
const MOODS: RobotMood[] = ["idle", "listening", "thinking", "speaking", "alert", "offline", "error"];

const TOKENS = [
  ["Background", "#080F1E", "Nền ứng dụng"],
  ["Surface", "#111D31", "Card, panel"],
  ["Raised surface", "#192941", "Dialog, sheet, control"],
  ["Primary", "#22D3EE", "Nút và tương tác chính"],
  ["Secondary", "#6685FF", "Thành phần phụ"],
  ["Text", "#F3F7FF", "Chữ chính"],
  ["Muted", "#A9BAD2", "Chú thích, metadata"],
  ["Success", "#34D399", "Trạng thái thành công"],
  ["Warning", "#FBBF24", "Cảnh báo"],
  ["Danger", "#FB7185", "Lỗi, thao tác nguy hiểm"],
];

const SCREENS: { id: string; name: string; states: string; status: Status; note: string }[] = [
  { id: "01", name: "Home — Trang chủ", states: "empty/loading/data/offline/error/thiếu bằng chứng", status: "met", note: "Robot + 3 vùng; thẻ đo lường camera online, dung lượng, lần đồng bộ, dữ liệu mẫu." },
  { id: "02", name: "Camera Live", states: "live/mất kết nối/khôi phục/không quyền/mic-cam bị từ chối", status: "partial", note: "Webcam thật + overlay + vạch đếm. Ghi 24/7 và RTSP chưa có (cần dịch vụ nền)." },
  { id: "03", name: "Ảnh & Trích xuất", states: "EMPTY→IMAGE_READY→ANNOTATED→PROCESSING→REVIEW→VERIFIED/FAILED", status: "met", note: "Crop/rotate/ROI, OCR, đối tượng, so sánh với ảnh gốc, đánh dấu AI vs đã sửa." },
  { id: "04", name: "Hỏi đáp giọng nói", states: "idle/nghe/ngừng gửi/xử lý/trả lời/lỗi/không có dữ liệu", status: "partial", note: "Voice Worker qua Gateway + dự phòng thiết bị; barge-in có; chưa test model/loa thật." },
  { id: "05", name: "Trí nhớ AI", states: "empty/loading/data/filter trống/không quyền xóa", status: "met", note: "Lọc ngày, camera, loại, đối tượng, thẻ, mức ưu tiên, nguồn dữ liệu." },
  { id: "06", name: "Thống kê & tính toán", states: "data/empty/truy vết nguồn/cảnh báo dữ liệu thiếu", status: "met", note: "Mỗi chỉ số có định nghĩa, phạm vi, múi giờ, bộ lọc và tỷ lệ dữ liệu mẫu." },
  { id: "07", name: "Cảnh báo", states: "empty/data/đã đọc/không quyền quản lý", status: "met", note: "Quy tắc phía máy chủ, chống lặp theo cooldown, xác nhận đã đọc, mở bằng chứng." },
  { id: "08", name: "Cài đặt & quản trị", states: "owner/operator/viewer, wizard, xác nhận nguy hiểm", status: "met", note: "Phiên thiết bị, chế độ thật, retention, nhật ký; backup tự động còn thiếu." },
];

const BUTTONS = [
  ["Đăng nhập / Đăng xuất", "POST /api/auth/login · /api/auth/logout", "Kiểm tra mật khẩu scrypt, tạo huỷ phiên trong DB", "met"],
  ["Mic", "Voice Worker / Web Speech dự phòng", "Bật mic, hiện transcript, gửi câu hỏi; từ chối quyền → thông báo", "partial"],
  ["Nút gửi câu hỏi", "POST /api/chat", "SQL có kiểm soát + bằng chứng; 429 khi quá tần suất", "met"],
  ["Bật webcam", "getUserMedia", "Live; lỗi quyền → thông báo + giữ ảnh mẫu", "met"],
  ["Nhận diện / Đếm qua vạch", "Gateway → Vision Worker + POST /api/events", "Gắn clientReported=true, chống trùng idempotency", "partial"],
  ["Chụp ảnh / Ghi clip", "POST /api/assets + /api/events", "Ảnh lưu vào trí nhớ; clip webm tối đa 15 giây", "met"],
  ["Trích xuất", "POST /api/extractions", "Ảnh + ROI + ghi chú; số trong ghi chú không thành dữ kiện", "met"],
  ["Xác nhận / Lưu tạm / Sai", "PATCH /api/extractions/{id}", "Giữ rawResult, tăng version, ghi verified_by", "met"],
  ["Xuất CSV/JSON", "GET /api/report · client export", "Cần quyền export; ghi nhật ký", "met"],
  ["Xóa sự kiện/ghi chú", "DELETE /api/events|extractions", "Chỉ owner, xác nhận, ghi nhật ký", "met"],
  ["Đặt lại dữ liệu", "POST /api/admin", "Chỉ owner + cụm “XOA DU LIEU”", "met"],
  ["Camera IP/RTSP", "—", "Chưa có gateway media", "missing"],
  ["Ghi hình khi đóng trình duyệt", "—", "Cần dịch vụ nền Windows", "missing"],
  ["Phát giọng trên thiết bị khác", "—", "Cần ghép đôi + đồng ý + quyền", "missing"],
  ["Thông báo đẩy", "—", "PWA + Web Push chưa triển khai", "missing"],
];

const ACCEPTANCE: [string, Status, string][] = [
  ["Mọi API nhạy cảm đều yêu cầu phiên + quyền", "met", "Proxy + authorize(); /api/admin owner-only."],
  ["deviceId trình duyệt không dùng làm xác thực", "met", "Danh tính lấy từ token ký HMAC và bản ghi session."],
  ["Xóa/đặt lại dữ liệu được bảo vệ", "met", "Owner + cụm xác nhận + audit."],
  ["Không tin dữ liệu nhận diện do client gửi", "partial", "Không nhận số đếm từ client làm fact; dùng worker server, lượt đếm client cần duyệt."],
  ["Không hiển thị dữ liệu mẫu như dữ liệu thật", "met", "Cờ demoMode loại trừ demo khỏi truy vấn; badge “mẫu”."],
  ["Mỗi báo cáo/thống kê có truy vết nguồn", "met", "Bảng nguồn + định nghĩa + múi giờ + cảnh báo."],
  ["Câu trả lời thiếu dữ liệu phải nói rõ", "met", "INSUFFICIENT_DATA khi không có bản ghi."],
  ["100% nút có hành động thật hoặc ghi rõ chưa hỗ trợ", "partial", "Bảng hành vi bên cạnh là nguồn sự thật."],
  ["Camera tiếp tục ghi khi đóng trình duyệt", "missing", "Giới hạn của bản web."],
  ["Đo sai số đếm trên video gán nhãn", "missing", "Chưa có bộ dữ liệu ground-truth."],
  ["Đo P95 trả lời và độ trễ âm thanh đầu tiên", "partial", "API trả latencyMs cho câu hỏi; chưa có SLO đo trên thiết bị."],
  ["Kiểm thử Windows/Android ở kích thước mục tiêu", "partial", "Responsive 360px→1920px; chưa có biên bản thiết bị thật."],
  ["Kiểm thử mất mạng/khôi phục/khởi động lại", "partial", "Có test fixture timeout, cancel, lease recovery; chưa có test khởi động lại host thật."],
  ["Tài liệu cài đặt/sao lưu/khôi phục", "partial", "docs/ có audit, design freeze, security; thiếu runbook sao lưu."],
];

const API_MAP: [string, string, string][] = [
  ["/api/auth/login · logout · me", "Login, shell, cài đặt", "Phiên, vai trò, quyền"],
  ["/api/dashboard", "Home", "Chỉ số, camera, sự kiện, dung lượng, demoShare"],
  ["/api/cameras", "Camera, Cài đặt", "Danh sách/nguồn camera"],
  ["/api/events (+/[id])", "Camera, Trí nhớ, Cảnh báo", "Bản ghi, nhãn, ưu tiên, ack, clientReported"],
  ["/api/assets (+/[id])", "Camera, Trích xuất", "Ảnh/clip đã kiểm MIME, SHA-256"],
  ["/api/extractions (+/[id])", "Ảnh & Trích xuất, Trí nhớ", "Kết quả AI, xác minh, version"],
  ["/api/chat", "Home, Hỏi đáp, Tìm bằng AI", "Fast SQL 200 / job điều phối 202 + bằng chứng"],
  ["/api/orchestration · /api/jobs", "Điều phối AI", "Worker status, kế hoạch, tiến độ, retry/cancel"],
  ["/api/vision/frame · /api/voice/*", "Camera / Voice", "Adapter worker trực tiếp, không tải model client"],
  ["/api/stats · /api/report", "Thống kê", "Tổng hợp có kiểm soát + CSV"],
  ["/api/alerts", "Cảnh báo", "Danh sách, ack, quy tắc"],
  ["/api/settings · /api/admin", "Cài đặt", "Chế độ thật, retention, phiên, audit"],
];

function Icon({ s }: { s: Status }) {
  if (s === "met") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (s === "partial") return <CircleDashed className="h-4 w-4 text-amber-400" />;
  return <XCircle className="h-4 w-4 text-rose-400" />;
}
const label: Record<Status, string> = { met: "Đạt", partial: "Một phần", missing: "Chưa có" };

const TABS = [
  ["audit", "G0 · Audit", ShieldAlert],
  ["tokens", "Design tokens", Palette],
  ["robot", "D-AI Bot", Bot],
  ["screens", "Màn hình & trạng thái", LayoutGrid],
  ["buttons", "Hành vi nút", ListChecks],
  ["api", "API ↔ UI", ClipboardList],
  ["acceptance", "Nghiệm thu", ListChecks],
  ["roadmap", "Roadmap", Route],
] as const;

export default function DesignClient() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("audit");
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Camera D-AI · Design Freeze v1.0</h1>
        <p className="text-sm text-[#a9bad2]">Kiến trúc mới: Gateway + Hermes + AI Workers. Bàn giao G0 + G1: audit trung thực, token, robot, trạng thái, hành vi, nghiệm thu. Đây là tài liệu sống gắn với mã nguồn đang chạy — không phải mockup rời.</p>
      </div>
      <div className="scroll-thin flex gap-1 overflow-x-auto rounded-xl bg-white/5 p-1">
        {TABS.map(([k, l, I]) => (
          <button key={k} onClick={() => setTab(k)} className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs ${tab === k ? "bg-cyan-400/20 text-white" : "text-[#a9bad2] hover:text-white"}`}>
            <I className="h-3.5 w-3.5" /> {l}
          </button>
        ))}
      </div>

      {tab === "audit" && (
        <section className="glass space-y-3 p-4">
          <h2 className="font-semibold">Phần có thật / phần còn thiếu</h2>
          <p className="text-sm text-[#a9bad2]">Bản trước có giao diện tốt nhưng thiếu nền tảng xác thực: API quản trị cho phép đặt lại toàn bộ dữ liệu mà không xác thực. Đó là lỗi P0 và đã được sửa trong bản này.</p>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              ["Có thật", "met", ["Next.js/React UI tiếng Việt, robot SVG 7 trạng thái", "Camera webcam + overlay + đếm có chống trùng", "Ảnh/ROI/OCR/đối tượng + kiểm duyệt kết quả", "Hỏi đáp SQL có kiểm soát + bằng chứng", "PostgreSQL + Drizzle, audit, session, RBAC"]],
              ["Một phần", "partial", ["Webcam phụ thuộc trình duyệt, chưa có dịch vụ nền", "Adapter Vision/OCR qua Gateway; cần worker/model thật", "Voice Worker tùy cấu hình; Web Speech/giọng thiết bị dự phòng", "Chưa tách dữ liệu theo người dùng", "Chưa đo sai số đếm / độ trễ trên thiết bị thật"]],
              ["Chưa có", "miss", ["App Windows/Android đóng gói riêng", "Camera RTSP và ghi 24/7", "Backup/khôi phục tự động", "Thông báo đẩy, ghép đôi QR", "iOS/TestFlight, nhiều GPU"]],
            ].map(([title, s, list]) => (
              <div key={String(title)} className="rounded-xl border border-white/10 p-3">
                <div className="mb-1 flex items-center gap-2 font-semibold"><Icon s={s as Status} /> {title}</div>
                <ul className="space-y-1 text-xs text-[#c6d4e6]">{(list as string[]).map((x) => <li key={x}>• {x}</li>)}</ul>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-100">
            Quyết định kỹ thuật: giữ React/Next.js và làm web responsive/PWA trước; tách client khỏi backend sau khi Design Freeze được duyệt. Không chuyển sang Flutter ở giai đoạn này.
          </div>
        </section>
      )}

      {tab === "tokens" && (
        <section className="glass space-y-4 p-4">
          <h2 className="font-semibold">Màu sắc</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {TOKENS.map(([name, hex, role]) => (
              <div key={name} className="rounded-xl border border-white/10 p-2">
                <div className="mb-1.5 h-10 rounded-lg border border-white/10" style={{ background: hex }} />
                <div className="text-xs font-semibold text-white">{name}</div>
                <div className="font-mono text-[11px] text-[#a9bad2]">{hex}</div>
                <div className="text-[10px] text-[#a9bad2]">{role}</div>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-white/10 p-3"><div className="text-xs text-[#a9bad2]">Bo góc</div><div className="text-sm text-white">12 / 16 / 20 px</div><div className="mt-2 flex gap-2"><span className="h-8 w-8 rounded-xl bg-cyan-400/25" /><span className="h-8 w-8 rounded-2xl bg-cyan-400/25" /><span className="h-8 w-8 rounded-[20px] bg-cyan-400/25" /></div></div>
            <div className="rounded-xl border border-white/10 p-3"><div className="text-xs text-[#a9bad2]">Khoảng cách</div><div className="text-sm text-white">Hệ 4 / 8 px</div><div className="mt-2 flex items-end gap-1">{ [4,8,12,16,24,32].map(n => <span key={n} className="rounded bg-sky-400/40" style={{ width: 6, height: n }} />) }</div></div>
            <div className="rounded-xl border border-white/10 p-3"><div className="text-xs text-[#a9bad2]">Ánh sáng</div><div className="text-sm text-white">Glow chỉ khi tương tác</div><div className="mt-2 flex gap-2"><button className="btn btn-primary py-1 text-xs">Chính</button><button className="btn btn-ghost py-1 text-xs">Phụ</button><button className="btn btn-danger py-1 text-xs">Nguy hiểm</button></div></div>
          </div>
          <p className="text-xs text-[#a9bad2]">Vùng chạm ≥ 44×44px; responsive 360px → 1920px; prefers-reduced-motion tắt chuyển động; mọi trạng thái đều có nhãn chữ, không chỉ màu.</p>
        </section>
      )}

      {tab === "robot" && (
        <section className="glass space-y-3 p-4">
          <h2 className="font-semibold">D-AI Bot — 7 trạng thái</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {MOODS.map((m) => (
              <div key={m} className="flex flex-col items-center rounded-xl border border-white/10 p-2 text-center">
                <Robot mood={m} size={92} still />
                <div className="mt-1 text-xs font-semibold capitalize">{m}</div>
                <div className="text-[10px] text-[#a9bad2]">{MOOD_LABEL[m]}</div>
              </div>
            ))}
          </div>
          <ul className="space-y-1 text-xs text-[#a9bad2]">
            <li>• Chuyển trạng thái tức thì; phiên bản tĩnh (<code>still</code>) cho thiết bị yếu và chế độ giảm chuyển động.</li>
            <li>• Biểu cảm dùng chung một khuôn mặt, một bảng màu trên mọi màn hình; không dùng robot để trang trí.</li>
            <li>• Bản 3D runtime chưa bắt buộc: hiện là SVG nhẹ, có thể thay bằng sprite/render tối ưu ở G5 mà không đổi API.</li>
            <li>• Trạng thái offline/error do mất mạng hoặc lỗi xử lý, không dùng để đe dọa người dùng.</li>
          </ul>
        </section>
      )}

      {tab === "screens" && (
        <section className="glass space-y-2 p-4">
          <h2 className="mb-2 font-semibold">Màn hình & độ phủ trạng thái</h2>
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-[#a9bad2]"><tr><th className="p-1.5">#</th><th>Màn hình</th><th>Trạng thái</th><th>Hoàn thiện</th><th>Ghi chú</th></tr></thead>
              <tbody>
                {SCREENS.map((s) => (
                  <tr key={s.id} className="border-t border-white/5">
                    <td className="p-1.5 font-mono text-[#a9bad2]">{s.id}</td>
                    <td className="p-1.5 font-medium">{s.name}</td>
                    <td className="p-1.5 text-xs text-[#a9bad2]">{s.states}</td>
                    <td className="p-1.5"><span className="flex items-center gap-1 text-xs"><Icon s={s.status} /> {label[s.status]}</span></td>
                    <td className="p-1.5 text-xs text-[#c6d4e6]">{s.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 rounded-xl border border-white/10 p-3 text-xs text-[#c6d4e6]">
            <b className="text-white">Bộ trạng thái bắt buộc:</b> chưa có dữ liệu · đang tải · đã có dữ liệu · đang xử lý AI · thành công · lỗi có thể thử lại · mất mạng/mất máy chủ · không có quyền · AI chưa đủ bằng chứng · camera/mic bị từ chối quyền. Component dùng chung: <code>EmptyState, LoadingState, ErrorState, NoPermissionState, OfflineBanner</code>.
          </div>
        </section>
      )}

      {tab === "buttons" && (
        <section className="glass space-y-2 p-4">
          <h2 className="mb-2 font-semibold">Hành vi từng nút / luồng</h2>
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-[#a9bad2]"><tr><th className="p-1.5">Điều khiển</th><th>API / công nghệ</th><th>Hành vi</th><th>Trạng thái</th></tr></thead>
              <tbody>
                {BUTTONS.map(([n, api, beh, s]) => (
                  <tr key={n} className="border-t border-white/5 align-top">
                    <td className="p-1.5 font-medium">{n}</td>
                    <td className="p-1.5 font-mono text-xs text-cyan-200">{api}</td>
                    <td className="p-1.5 text-xs text-[#c6d4e6]">{beh}</td>
                    <td className="p-1.5"><span className="flex items-center gap-1 text-xs"><Icon s={s as Status} /> {label[s as Status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "api" && (
        <section className="glass space-y-2 p-4">
          <h2 className="mb-2 font-semibold">API ↔ dữ liệu UI</h2>
          <div className="grid gap-2 md:grid-cols-2">
            {API_MAP.map(([a, ui, data]) => (
              <div key={a} className="rounded-xl border border-white/10 p-2 text-xs">
                <div className="font-mono text-cyan-200">{a}</div>
                <div className="mt-1 text-[#c6d4e6]">Dùng ở: {ui}</div>
                <div className="text-[#a9bad2]">Dữ liệu: {data}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-[#a9bad2]">Mọi route (trừ đăng nhập và healthcheck) yêu cầu phiên hợp lệ; lỗi trả <code>application/problem+json</code>; POST gây tác dụng phụ có idempotency và audit.</p>
        </section>
      )}

      {tab === "acceptance" && (
        <section className="glass space-y-2 p-4">
          <h2 className="font-semibold">Checklist nghiệm thu (trung thực)</h2>
          <p className="mb-2 text-xs text-[#a9bad2]">Chỉ tuyên bố production-ready khi các mục dưới đây có bằng chứng chạy thật.</p>
          <div className="space-y-1.5">
            {ACCEPTANCE.map(([n, s, note]) => (
              <div key={n} className="flex items-start gap-2 rounded-xl border border-white/10 p-2 text-sm">
                <Icon s={s} />
                <div className="flex-1">
                  <div>{n}</div>
                  <div className="text-xs text-[#a9bad2]">{note}</div>
                </div>
                <Badge color={s === "met" ? "emerald" : s === "partial" ? "amber" : "rose"}>{label[s]}</Badge>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === "roadmap" && (
        <section className="glass space-y-2 p-4">
          <h2 className="mb-2 font-semibold">Roadmap G0 → G8</h2>
          {[
            ["G0 Audit", "met", "Báo cáo có thật/thiếu + lỗi P0 đã sửa (xác thực quản trị, deviceId)."],
            ["G1 Design Freeze", "met", "Token, robot 7 trạng thái, trạng thái màn hình, hành vi nút, API↔UI, checklist."],
            ["G2 Security Foundation", "partial", "Session/RBAC/audit/headers/rate limit đã có. Còn: tách dữ liệu theo người dùng, quyền theo camera, chứng chỉ TLS nội bộ."],
            ["G3 Camera Engine", "missing", "Dịch vụ nền Windows, RTSP/MediaMTX, ghi 24/7, đo sai số đếm."],
            ["G4 Image & Memory", "partial", "Vòng ảnh→AI→duyệt→lưu→tìm đã chạy; thiếu vector search và model VLM cục bộ."],
            ["G5 Conversational AI", "partial", "STT/TTS thiết bị + reasoning SQL. Thiếu faster-whisper/VieNeu streaming, ngắt lời server-side."],
            ["G6 Multi-device", "partial", "Responsive + PWA + phiên thiết bị; thiếu app đóng gói, ghép đôi QR, điều hướng âm thanh chéo thiết bị."],
            ["G7 Production", "missing", "Monitoring, backup/restore, installer, soak test, SLO."],
            ["G8 iOS/Scale", "missing", "Phụ thuộc G7."],
          ].map(([g, s, note]) => (
            <div key={g} className="flex items-start gap-2 rounded-xl border border-white/10 p-2 text-sm">
              <Icon s={s as Status} />
              <div className="flex-1"><div className="font-medium">{g}</div><div className="text-xs text-[#a9bad2]">{note}</div></div>
              <Badge color={s === "met" ? "emerald" : s === "partial" ? "amber" : "rose"}>{label[s as Status]}</Badge>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
