"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Star, Save, NotebookPen, Trash2, ShieldCheck, AlertTriangle } from "lucide-react";
import { Modal, EventBadge, Badge, type EventItem } from "./ui";
import { api, getDeviceId } from "@/lib/client";

export default function EventDetail({ e, onClose, onSaved }: { e: EventItem | null; onClose: () => void; onSaved?: () => void }) {
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [priority, setPriority] = useState("normal");
  const [saving, setSaving] = useState(false);
  const [perms, setPerms] = useState<{ verify: boolean; delete: boolean }>({ verify: false, delete: false });
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" }).then((r) => r.json()).then((j) => setPerms({ verify: !!j.permissions?.verify, delete: !!j.permissions?.delete })).catch(() => {});
  }, []);

  useEffect(() => {
    if (e) {
      setNote(e.note ?? "");
      setTags(e.tags.join(", "));
      setPriority(e.priority);
    }
  }, [e]);

  if (!e) return null;
  const assetId = e.thumb?.startsWith("/api/assets/") ? e.thumb.split("/").pop() : null;

  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/events/${e.id}`, {
        method: "PATCH",
        json: { note, priority, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), deviceId: getDeviceId() },
      });
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm("Xóa sự kiện này? Hành động được ghi nhật ký và không thể hoàn tác.")) return;
    setSaving(true);
    try {
      await api(`/api/events/${e.id}?confirm=yes`, { method: "DELETE" });
      onSaved?.();
      onClose();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Không xóa được");
    } finally {
      setSaving(false);
    }
  };

  const markReviewed = async () => {
    setSaving(true);
    try {
      await api(`/api/events/${e.id}`, { method: "PATCH", json: { reviewed: true } });
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={e.label}>
      <div className="space-y-3">
        {e.thumb &&
          (e.type === "clip" ? (
            <video src={e.thumb} controls className="w-full rounded-xl border border-white/10" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={e.thumb} alt={e.label} className="w-full rounded-xl border border-white/10" />
          ))}
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
          <EventBadge type={e.type} />
          <span>{new Date(e.happenedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</span>
          <span>· {e.camera}</span>
          {e.confidence != null && <span>· Tin cậy {(e.confidence * 100).toFixed(0)}%</span>}
          {e.source === "demo" && <Badge color="slate">Dữ liệu mẫu</Badge>}
          {e.clientReported ? <Badge color="amber">Nhận diện do trình duyệt báo — chưa xác minh</Badge> : <Badge color="emerald">Đã có nguồn máy chủ</Badge>}
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-400">Ghi chú</span>
          <textarea value={note} onChange={(x) => setNote(x.target.value)} rows={3} className="input" placeholder="Thêm ghi chú cho sự kiện…" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-slate-400">Thẻ (phân cách bằng dấu phẩy)</span>
          <input value={tags} onChange={(x) => setTags(x.target.value)} className="input" />
        </label>
        <div className="flex flex-wrap gap-2">
          {[
            ["normal", "Bình thường"],
            ["important", "Quan trọng"],
            ["critical", "Khẩn"],
          ].map(([k, l]) => (
            <button key={k} onClick={() => setPriority(k)} className={`btn ${priority === k ? "btn-primary" : "btn-ghost"} py-1`}>
              {k !== "normal" && <Star className="h-3.5 w-3.5" />} {l}
            </button>
          ))}
        </div>
        {err && <div className="flex gap-2 rounded-lg border border-rose-400/40 bg-rose-500/10 px-2 py-1.5 text-xs text-rose-100"><AlertTriangle className="h-4 w-4" />{err}</div>}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          {e.clientReported && perms.verify && <button onClick={markReviewed} disabled={saving} className="btn btn-ghost"><ShieldCheck className="h-4 w-4" /> Duyệt bằng chứng</button>}
          {perms.delete && <button onClick={remove} disabled={saving} className="btn btn-danger"><Trash2 className="h-4 w-4" /> Xóa</button>}
          {assetId && e.type !== "clip" && (
            <Link href={`/extract?asset=${assetId}`} className="btn btn-ghost"><NotebookPen className="h-4 w-4" /> Trích xuất từ ảnh này</Link>
          )}
          <button onClick={onClose} className="btn btn-ghost">Đóng</button>
          <button onClick={save} disabled={saving} className="btn btn-primary"><Save className="h-4 w-4" /> Lưu</button>
        </div>
      </div>
    </Modal>
  );
}
