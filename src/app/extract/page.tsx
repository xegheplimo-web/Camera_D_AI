import { Suspense } from "react";
import ExtractClient from "./ExtractClient";

export default function ExtractPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Đang tải…</div>}>
      <ExtractClient />
    </Suspense>
  );
}
