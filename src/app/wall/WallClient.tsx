"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, LayoutGrid, Plus, X } from "lucide-react";
import { api } from "@/lib/client";
import { Card } from "@/components/ui";
import { moveTile, WALL_MAX, type WallTile } from "@/lib/wall/layout";

type CamInfo = { id: number; name: string; location: string; enabled: boolean; sourceType: string };

const REFRESH_MS = 3_000;

/**
 * P3 — tường camera: lưới tile kéo-thả, mỗi tile poll ảnh tĩnh /snapshot mỗi
 * 3s thay vì mở MJPEG (endpoint stream giữ slot MAX_CONSUMERS suốt phiên —
 * 10 tile dùng nó sẽ 429 và bóp chết màn xem đơn). Layout lưu theo user qua
 * /api/wall/layout nên sống qua reload.
 */
export default function WallClient() {
  const [cams, setCams] = useState<CamInfo[]>([]);
  const [tiles, setTiles] = useState<WallTile[] | null>(null);
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addId, setAddId] = useState("");
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    Promise.all([api<CamInfo[]>("/api/cameras"), api<{ tiles: WallTile[] }>("/api/wall/layout")])
      .then(([cs, l]) => {
        setCams(cs);
        setTiles(l.tiles);
      })
      .catch((e) => {
        setTiles([]);
        setError(e instanceof Error ? e.message : "Không tải được tường camera");
      });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const persist = useCallback(async (next: WallTile[]) => {
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ tiles: WallTile[] }>("/api/wall/layout", { method: "PUT", json: { tiles: next } });
      setTiles(r.tiles); // đáp án đã chuẩn hoá của server là source of truth
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không lưu được bố cục");
    } finally {
      setSaving(false);
    }
  }, []);

  const applyLocal = useCallback(
    (next: WallTile[]) => {
      setTiles(next);
      void persist(next);
    },
    [persist],
  );

  const camById = useCallback((id: number) => cams.find((c) => c.id === id), [cams]);
  const onWall = new Set((tiles ?? []).map((t) => t.cameraId));
  const addable = cams.filter((c) => !onWall.has(c.id));

  const addTile = () => {
    const id = Number(addId);
    if (!tiles || !id || tiles.length >= WALL_MAX || onWall.has(id)) return;
    setAddId("");
    applyLocal([...tiles, { cameraId: id, order: tiles.length }]);
  };

  const removeTile = (index: number) => {
    if (!tiles) return;
    applyLocal(tiles.filter((_, i) => i !== index).map((t, i) => ({ ...t, order: i })));
  };

  const dropTo = (index: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    setDragOver(null);
    if (!tiles || from === null || from === index) return;
    applyLocal(moveTile(tiles, from, index));
  };

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h1 className="flex shrink-0 items-center gap-2 text-xl font-bold">
          <LayoutGrid className="h-5 w-5 text-cyan-300" /> Tường camera
        </h1>
        <div className="flex min-w-0 items-center gap-2">
          {saving && <span className="text-xs text-slate-400">Đang lưu…</span>}
          <select
            value={addId}
            onChange={(e) => setAddId(e.target.value)}
            className="input w-auto min-w-0 max-w-[55vw] truncate"
            aria-label="Chọn camera để thêm"
            disabled={!tiles || (tiles?.length ?? 0) >= WALL_MAX || !addable.length}
          >
            <option value="">{addable.length ? "Thêm camera…" : "Không còn camera"}</option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} – {c.location}
              </option>
            ))}
          </select>
          <button onClick={addTile} disabled={!addId || !tiles || (tiles?.length ?? 0) >= WALL_MAX} className="btn btn-primary" aria-label="Thêm vào tường">
            <Plus className="h-4 w-4" /> Thêm
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" role="alert">
          {error}
        </div>
      )}

      {tiles === null ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="aspect-video animate-pulse rounded-xl bg-slate-800/50" />
          ))}
        </div>
      ) : tiles.length === 0 ? (
        <Card>
          <div className="py-10 text-center">
            <LayoutGrid className="mx-auto mb-3 h-10 w-10 text-slate-500" />
            <p className="text-sm text-slate-300">Tường chưa có camera nào.</p>
            <p className="mt-1 text-xs text-slate-400">Chọn camera ở ô phía trên để bắt đầu theo dõi nhiều camera cùng lúc.</p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4" role="list" aria-label="Lưới tường camera">
          {tiles.map((tile, i) => {
            const cam = camById(tile.cameraId);
            const bad = failed[tile.cameraId] === true;
            return (
              <div
                key={tile.cameraId}
                role="listitem"
                draggable
                onDragStart={(e) => {
                  dragFrom.current = i;
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOver !== i) setDragOver(i);
                }}
                onDragLeave={() => {
                  if (dragOver === i) setDragOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropTo(i);
                }}
                onDragEnd={() => {
                  dragFrom.current = null;
                  setDragOver(null);
                }}
                className={`group relative aspect-video cursor-grab overflow-hidden rounded-xl border bg-slate-900 active:cursor-grabbing ${
                  dragOver === i ? "border-cyan-400/70 ring-2 ring-cyan-400/40" : "border-white/10"
                }`}
                aria-label={`Ô camera ${cam?.name ?? tile.cameraId}`}
              >
                {!cam ? (
                  <div className="grid h-full w-full place-items-center bg-slate-800/60 text-xs text-slate-400">Camera không còn</div>
                ) : (
                  <>
                    {/* img luôn mounted để cứ poll mỗi tick — camera hồi lại thì tự
                        hiện lại; khi fail chỉ giấu hiển thị, không unmount. */}
                    {bad && <div className="absolute inset-0 z-10 grid place-items-center bg-slate-800/60 text-xs text-slate-400">Chưa có khung hình</div>}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/cameras/${tile.cameraId}/snapshot?t=${tick}`}
                      alt={cam.name}
                      className={`h-full w-full object-cover ${bad ? "invisible" : ""}`}
                      draggable={false}
                      onError={() => setFailed((f) => ({ ...f, [tile.cameraId]: true }))}
                      onLoad={() => setFailed((f) => (f[tile.cameraId] ? { ...f, [tile.cameraId]: false } : f))}
                    />
                  </>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1 pt-6">
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="truncate text-xs font-medium text-white">{cam?.name ?? `#${tile.cameraId}`}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-slate-400">#{i + 1}</span>
                </div>
                <button
                  onClick={() => removeTile(i)}
                  className="absolute right-1 top-1 rounded-lg bg-black/60 p-1 text-slate-300 opacity-0 transition hover:bg-rose-500/30 hover:text-rose-200 focus:opacity-100 group-hover:opacity-100"
                  aria-label={`Bỏ ${cam?.name ?? "camera"} khỏi tường`}
                  title="Bỏ khỏi tường"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {tiles !== null && tiles.length > 0 && (
        <p className="text-[11px] text-slate-500">Kéo-thả để sắp xếp · Ảnh tĩnh làm mới mỗi {REFRESH_MS / 1000}s · Tối đa {WALL_MAX} ô</p>
      )}
    </div>
  );
}
