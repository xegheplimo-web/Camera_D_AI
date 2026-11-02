import { api } from "@/lib/client";
import { TERMINAL, type JobView } from "./types";

export type JobEnvelope<E = unknown, M = unknown> = { job: JobView; extraction: E | null; assistant: M | null };
export async function waitForJob<E = unknown, M = unknown>(id: string, onUpdate: (job: JobView) => void, signal: AbortSignal, timeoutMs = 120000): Promise<JobEnvelope<E, M>> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    signal.throwIfAborted();
    const envelope = await api<JobEnvelope<E, M>>(`/api/jobs/${encodeURIComponent(id)}`, { signal });
    onUpdate(envelope.job);
    if (TERMINAL.includes(envelope.job.state)) return envelope;
    await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 1000);
      signal.addEventListener("abort", stop, { once: true });
    });
  }
  throw new Error("Tác vụ vẫn được lưu trên máy chủ. Tải lại trang để tiếp tục theo dõi.");
}
