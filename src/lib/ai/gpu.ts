/**
 * Shared GPU semaphore for local inference on the single 3090 — vision, embed
 * and detector must never run concurrently and OOM the card. One slot for now;
 * PR2 wires vision/embed/detector calls through this gate.
 */
const MAX_GPU_SLOTS = 1;
let active = 0;
const waiters: (() => void)[] = [];

export function gpuSlots(): { max: number; active: number; waiting: number } {
  return { max: MAX_GPU_SLOTS, active, waiting: waiters.length };
}

export async function withGpuSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_GPU_SLOTS) await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}
