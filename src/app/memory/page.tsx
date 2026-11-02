import { Suspense } from "react";
import MemoryClient from "./MemoryClient";

export default function MemoryPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Đang tải…</div>}>
      <MemoryClient />
    </Suspense>
  );
}
