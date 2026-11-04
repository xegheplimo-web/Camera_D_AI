"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CopyCheck, Eye, GitMerge, Loader2, RefreshCw, Undo2, Unlink, X } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, Card, Modal } from "@/components/ui";
import { EmptyState, ErrorState, LoadingState, NoPermissionState } from "@/components/states";
import { useApp } from "@/components/AppState";

/**
 * T-1351 — UI "Rà soát trùng": liệt kê cặp trùng, xem trước, gộp, giữ riêng, hoàn tác.
 *
 * Hợp đồng API (đã có sẵn, không sửa ở đây):
 *  - GET  /api/knowledge/duplicates/pairs?cameraId=  → PairsResult
 *  - GET  /api/knowledge/merge/preview?sourceId=&targetId= → MergePreview
 *  - POST /api/knowledge/merge            { sourceId, targetId, priceChoice? } → MergeResult
 *  - POST /api/knowledge/merge/undo       { logId } → UndoResult
 *  - POST /api/knowledge/duplicates/keep-separate { a, b } → { key, fingerprint }
 *
 * Nguyên tắc sản phẩm: hai giá khác nhau thì KHÔNG tự chọn — người dùng phải chọn.
 * Gộp không xoá dữ liệu; hoàn tác được trong 24 giờ.
 */

/* ---------- kiểu dữ liệu phản chiếu JSON API (không import module server) ---------- */

type Identity = Record<string, string | number | null | undefined>;

type PairSide = {
  id: number;
  title: string;
  priceVnd: number | null;
  identity: Identity;
  images: number;
};

type PairClass = "EXACT_CANDIDATE" | "LIKELY_DUPLICATE" | "REVIEW_REQUIRED" | "DIFFERENT_VARIANT";

type PairView = {
  key: string;
  class: PairClass;
  similarity: number;
  reasons: string[];
  priceConflict: boolean;
  a: PairSide;
  b: PairSide;
};

type PairsResult = {
  pairs: PairView[];
  counts: { exact: number; review: number; variantsHidden: number; decidedHidden: number };
};

type MergePreview = {
  ok: boolean;
  code?: "SAME_ITEM" | "NOT_FOUND" | "ALREADY_MERGED" | "PRICE_REVIEW_REQUIRED";
  message?: string;
  prices?: { source: number | null; target: number | null };
  counts: { images: number; duplicateImages: number; priceHistory: number };
  identity: { source: Identity; target: Identity; differs: string[] };
};

type MergeResult = {
  ok: boolean;
  logId: number;
  movedImages: number;
  skippedDuplicateImages: number;
  movedPriceHistory: number;
  priceKept: number | null;
};

type UndoResult = {
  ok: boolean;
  restoredImages: number;
  restoredPriceHistory: number;
  sourceId: number;
  targetId: number;
};

/* ---------- nhãn hiển thị ---------- */

const CLASS_META: Record<PairClass, { label: string; color: string }> = {
  EXACT_CANDIDATE: { label: "Trùng chắc chắn", color: "emerald" },
  LIKELY_DUPLICATE: { label: "Khả năng trùng cao", color: "amber" },
  REVIEW_REQUIRED: { label: "Cần xem lại", color: "sky" },
  DIFFERENT_VARIANT: { label: "Khác biến thể", color: "slate" },
};

const IDENTITY_LABEL: Record<string, string> = {
  gtin: "GTIN",
  brand: "Hãng",
  productLine: "Dòng",
  variant: "Biến thể",
  flavor: "Vị",
  netQuantity: "Dung tích",
  netUnit: "Đơn vị",
  packCount: "Quy cách",
  sellingUnit: "Đơn vị bán",
  internalSku: "SKU nội bộ",
};

const fmtVnd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${new Intl.NumberFormat("vi-VN").format(n)} ₫`;

/** Tóm tắt các trường định danh đang có, tối đa 3 trường để thẻ gọn. */
function identitySummary(id: Identity): string {
  const order = ["gtin", "brand", "productLine", "variant", "flavor", "netQuantity", "packCount", "sellingUnit", "internalSku"];
  const out: string[] = [];
  for (const k of order) {
    const v = id?.[k];
    if (v === null || v === undefined || v === "") continue;
    if (k === "netQuantity") {
      const unit = id.netUnit ? ` ${id.netUnit}` : "";
      out.push(`${IDENTITY_LABEL[k]} ${v}${unit}`);
    } else {
      out.push(`${IDENTITY_LABEL[k] ?? k}: ${v}`);
    }
    if (out.length >= 3) break;
  }
  return out.join(" · ");
}

/* ---------- thành phần ---------- */

export default function DuplicateReview({ cameraId, initialRole }: { cameraId: number | null; initialRole: string }) {
  const { role: ctxRole } = useApp();
  const role = ctxRole && ctxRole !== "viewer" ? ctxRole : initialRole;
  const canManage = role === "owner" || role === "operator";

  const [data, setData] = useState<PairsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; undoLogId?: number } | null>(null);

  // Hộp thoại xem trước/gộp
  const [selected, setSelected] = useState<PairView | null>(null);
  const [keep, setKeep] = useState<"a" | "b">("a");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [priceChoice, setPriceChoice] = useState<"source" | "target" | "">("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = cameraId ? `?cameraId=${cameraId}` : "";
      setData(await api<PairsResult>(`/api/knowledge/duplicates/pairs${qs}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không tải được danh sách cặp trùng.");
    } finally {
      setLoading(false);
    }
  }, [cameraId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Xem trước — chỉ đọc, không ghi. Dùng số thứ tự để bỏ qua phản hồi cũ khi
  // người dùng đổi hướng giữ hoặc đóng hộp thoại trước khi máy chủ trả lời.
  const previewSeq = useRef(0);

  const loadPreview = useCallback(async (pair: PairView, keepSide: "a" | "b") => {
    const seq = previewSeq.current + 1;
    previewSeq.current = seq;
    const sourceId = keepSide === "a" ? pair.b.id : pair.a.id;
    const targetId = keepSide === "a" ? pair.a.id : pair.b.id;
    setPreview(null);
    setPreviewErr(null);
    setPriceChoice("");
    setPreviewLoading(true);
    try {
      const r = await api<MergePreview>(`/api/knowledge/merge/preview?sourceId=${sourceId}&targetId=${targetId}`);
      if (seq === previewSeq.current) setPreview(r);
    } catch (e) {
      if (seq === previewSeq.current) setPreviewErr(e instanceof Error ? e.message : "Không xem trước được lần gộp này.");
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  }, []);

  const openPreview = (p: PairView) => {
    setFlash(null);
    setKeep("a");
    setSelected(p);
    void loadPreview(p, "a");
  };

  const changeKeep = (side: "a" | "b") => {
    setKeep(side);
    if (selected) void loadPreview(selected, side);
  };

  const closePreview = () => {
    previewSeq.current += 1;
    setSelected(null);
    setPreview(null);
    setPreviewErr(null);
    setPriceChoice("");
    setPreviewLoading(false);
  };

  const doMerge = async () => {
    if (!selected || !preview) return;
    if (preview.code === "PRICE_REVIEW_REQUIRED" && !priceChoice) {
      setPreviewErr("Hai mục có giá khác nhau — chọn giá giữ lại trước khi gộp.");
      return;
    }
    const sourceId = keep === "a" ? selected.b.id : selected.a.id;
    const targetId = keep === "a" ? selected.a.id : selected.b.id;
    const sourceTitle = keep === "a" ? selected.b.title : selected.a.title;
    const targetTitle = keep === "a" ? selected.a.title : selected.b.title;

    setBusy(selected.key);
    setPreviewErr(null);
    try {
      const r = await api<MergeResult>("/api/knowledge/merge", {
        method: "POST",
        json: { sourceId, targetId, ...(priceChoice ? { priceChoice } : {}) },
      });
      closePreview();
      setFlash({
        text: `Đã gộp “${sourceTitle}” vào “${targetTitle}”: chuyển ${r.movedImages} ảnh, bỏ qua ${r.skippedDuplicateImages} ảnh trùng, chuyển ${r.movedPriceHistory} dòng lịch sử giá. Giá giữ lại: ${fmtVnd(r.priceKept)}.`,
        undoLogId: r.logId,
      });
      await load();
    } catch (e) {
      setPreviewErr(e instanceof Error ? e.message : "Gộp không thành công.");
    } finally {
      setBusy(null);
    }
  };

  const keepApart = async (p: PairView) => {
    setBusy(p.key);
    setFlash(null);
    setErr(null);
    try {
      await api("/api/knowledge/duplicates/keep-separate", {
        method: "POST",
        json: { a: p.a.id, b: p.b.id },
      });
      setFlash({ text: `Đã ghi quyết định giữ riêng “${p.a.title}” và “${p.b.title}”. Cặp này sẽ không hiện lại trừ khi định danh thay đổi.` });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không ghi được quyết định giữ riêng.");
    } finally {
      setBusy(null);
    }
  };

  const doUndo = async (logId: number) => {
    setBusy(`undo:${logId}`);
    setErr(null);
    try {
      const r = await api<UndoResult>("/api/knowledge/merge/undo", { method: "POST", json: { logId } });
      setFlash({ text: `Đã hoàn tác lần gộp #${logId}: khôi phục ${r.restoredImages} ảnh và ${r.restoredPriceHistory} dòng lịch sử giá.` });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Hoàn tác không thành công.");
    } finally {
      setBusy(null);
    }
  };

  const counts = data?.counts;
  const pairs = data?.pairs ?? [];
  // preview.ok=false khi có xung đột giá; lúc đó chỉ cho gộp sau khi người dùng chọn giá.
  const canMerge = !!preview && (preview.ok || (preview.code === "PRICE_REVIEW_REQUIRED" && priceChoice !== ""));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="flex items-center gap-2 text-xl font-bold text-white">
            <CopyCheck className="h-5 w-5 text-cyan-300" /> Rà soát trùng
          </h1>
          <p className="text-xs text-[#a9bad2]">
            Gộp sản phẩm trùng mà không mất dữ liệu. Gộp không xoá sản phẩm — hoàn tác được trong 24 giờ.
            {cameraId ? ` Đang lọc theo camera #${cameraId}.` : ""}
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading} className="btn btn-ghost text-xs" aria-label="Tải lại danh sách cặp trùng">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Tải lại
        </button>
      </div>

      {counts && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <Badge color="emerald">{counts.exact} trùng chắc chắn</Badge>
          <Badge color="amber">{counts.review} cần xem lại</Badge>
          <span className="text-[#a9bad2]">
            Đã ẩn: {counts.variantsHidden} cặp khác biến thể · {counts.decidedHidden} cặp đã quyết định giữ riêng
          </span>
        </div>
      )}

      {!canManage && (
        <NoPermissionState what="gộp hoặc giữ riêng sản phẩm (chỉ chủ hệ thống và vận hành)" />
      )}

      {flash && (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-100" role="status">
          <GitMerge className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
          <div className="flex-1">{flash.text}</div>
          {flash.undoLogId !== undefined && (
            <button
              onClick={() => void doUndo(flash.undoLogId as number)}
              disabled={busy === `undo:${flash.undoLogId}`}
              className="btn btn-ghost shrink-0 text-xs"
            >
              {busy === `undo:${flash.undoLogId}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />} Hoàn tác
            </button>
          )}
          <button onClick={() => setFlash(null)} className="shrink-0 rounded-lg p-1 text-emerald-200/70 hover:text-white" aria-label="Đóng thông báo">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {err && <ErrorState message={err} onRetry={() => void load()} />}
      {loading && !data && <LoadingState label="Đang rà soát cặp trùng…" />}

      {!loading && !err && pairs.length === 0 && (
        <EmptyState
          title="Không còn cặp trùng cần rà soát"
          hint="Mọi cặp trùng đã được gộp hoặc đánh dấu giữ riêng. Cặp mới sẽ xuất hiện khi có sản phẩm trùng được thêm vào."
        />
      )}

      <div className="space-y-3">
        {pairs.map((p) => {
          const meta = CLASS_META[p.class] ?? CLASS_META.REVIEW_REQUIRED;
          const rowBusy = busy === p.key;
          return (
            <Card key={p.key} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge color={meta.color}>{meta.label}</Badge>
                <span className="text-[#a9bad2]">Giống tiêu đề {Math.round(p.similarity * 100)}%</span>
                {p.priceConflict && <Badge color="rose">Khác giá</Badge>}
                <span className="ml-auto font-mono text-[10px] text-slate-500">cặp {p.key}</span>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {[p.a, p.b].map((side, i) => (
                  <div key={side.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-2.5">
                    <div className="flex items-center gap-2 text-[10px] text-[#a9bad2]">
                      <span className="font-semibold text-slate-300">{i === 0 ? "A" : "B"}</span>
                      <span>#{side.id}</span>
                      <span>· {side.images} ảnh</span>
                    </div>
                    <div className="truncate text-sm font-medium text-white" title={side.title}>{side.title}</div>
                    <div className="text-xs text-slate-300">{fmtVnd(side.priceVnd)}</div>
                    {identitySummary(side.identity) && (
                      <div className="mt-1 line-clamp-2 text-[11px] text-[#a9bad2]">{identitySummary(side.identity)}</div>
                    )}
                  </div>
                ))}
              </div>

              {p.reasons.length > 0 && (
                <div className="flex flex-wrap gap-1 text-[10px] text-slate-400">
                  {p.reasons.slice(0, 4).map((r) => (
                    <span key={r} className="rounded bg-white/5 px-1.5 py-0.5 font-mono">{r}</span>
                  ))}
                </div>
              )}

              {canManage && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button onClick={() => openPreview(p)} disabled={rowBusy} className="btn btn-primary text-xs">
                    <Eye className="h-3.5 w-3.5" /> Xem trước &amp; gộp
                  </button>
                  <button onClick={() => void keepApart(p)} disabled={rowBusy} className="btn btn-ghost text-xs">
                    {rowBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />} Giữ riêng
                  </button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* Hộp thoại xem trước và xác nhận gộp */}
      <Modal open={selected !== null} onClose={closePreview} title="Xem trước khi gộp">
        {selected && (
          <div className="space-y-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="text-xs text-[#a9bad2]">Giữ lại sản phẩm nào? Sản phẩm còn lại sẽ được gộp vào.</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(["a", "b"] as const).map((sideKey) => {
                  const side = sideKey === "a" ? selected.a : selected.b;
                  const active = keep === sideKey;
                  return (
                    <button
                      key={sideKey}
                      type="button"
                      onClick={() => changeKeep(sideKey)}
                      aria-pressed={active}
                      className={`rounded-xl border p-2 text-left text-sm transition ${active ? "border-cyan-400/60 bg-cyan-500/10 text-white" : "border-white/10 text-slate-300 hover:bg-white/5"}`}
                    >
                      <div className="text-[10px] text-[#a9bad2]">Giữ {sideKey.toUpperCase()} · #{side.id}</div>
                      <div className="truncate font-medium">{side.title}</div>
                      <div className="text-xs">{fmtVnd(side.priceVnd)}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {previewLoading && <LoadingState label="Đang kiểm tra dữ liệu gộp…" />}

            {previewErr && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 p-2.5 text-xs text-rose-100" role="alert">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                <span>{previewErr}</span>
              </div>
            )}

            {preview && !previewLoading && (
              <>
                {preview.ok ? (
                  <div className="rounded-xl border border-emerald-400/25 bg-emerald-500/5 p-3 text-xs text-emerald-100">
                    Sẵn sàng gộp: chuyển {preview.counts.images} ảnh (bỏ qua {preview.counts.duplicateImages} ảnh trùng),{" "}
                    {preview.counts.priceHistory} dòng lịch sử giá.
                  </div>
                ) : preview.code === "PRICE_REVIEW_REQUIRED" ? (
                  <div className="space-y-2 rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-100">
                    <div className="font-semibold">Hai mục có giá hiện hành khác nhau — chọn giá giữ lại (không tự chọn).</div>
                    <div className="flex flex-col gap-1.5">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="priceChoice"
                          value="target"
                          checked={priceChoice === "target"}
                          onChange={() => setPriceChoice("target")}
                        />
                        Giữ giá {keep === "a" ? "A" : "B"}: {fmtVnd(preview.prices?.target)}
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="priceChoice"
                          value="source"
                          checked={priceChoice === "source"}
                          onChange={() => setPriceChoice("source")}
                        />
                        Giữ giá {keep === "a" ? "B" : "A"}: {fmtVnd(preview.prices?.source)}
                      </label>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-xs text-rose-100" role="alert">
                    {preview.message ?? "Không thể gộp hai mục này."}
                  </div>
                )}

                {preview.identity.differs.length > 0 && (
                  <div className="text-xs text-amber-200">
                    Trường định danh khác nhau: {preview.identity.differs.map((f) => IDENTITY_LABEL[f] ?? f).join(", ")}. Trường trống ở mục giữ lại sẽ được điền từ mục bị gộp; giá trị đã có không bị ghi đè.
                  </div>
                )}
              </>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <button type="button" onClick={closePreview} className="btn btn-ghost text-xs">Huỷ</button>
              <button
                type="button"
                onClick={() => void doMerge()}
                disabled={busy === selected.key || previewLoading || !canMerge}
                className="btn btn-primary text-xs"
              >
                {busy === selected.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitMerge className="h-3.5 w-3.5" />} Gộp
              </button>
            </div>
            <p className="text-[10px] text-slate-500">Sau khi gộp, dùng nút “Hoàn tác” trong 24 giờ nếu cần khôi phục.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
