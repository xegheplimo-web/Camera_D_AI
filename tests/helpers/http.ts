/**
 * Harness dùng chung cho các test spawn `next start` (T-1335, T-1337, …).
 * Tách ra để SonarCloud không tính duplication trên new code (>3% là fail).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Port trống trên loopback — mở rồi đóng ngay để lấy số. */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const n = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return n;
}

export type CallResult = { status: number; data: any; headers: Headers };
export type Call = (
  path: string,
  method?: string,
  body?: unknown,
  cookie?: string,
  headers?: Record<string, string>,
) => Promise<CallResult>;

/**
 * Tạo hàm gọi HTTP tới server test.
 * @param base        trả về origin (đọc biến sau khi spawn xong)
 * @param fetchImpl   cho phép test đang mock `globalThis.fetch` vẫn gọi fetch thật
 */
export function makeCall(base: () => string, fetchImpl: () => typeof fetch = () => globalThis.fetch): Call {
  return async (path, method = "GET", body, cookie = "", headers = {}) => {
    const response = await fetchImpl()(base() + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const raw = await response.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 300) }; }
    return { status: response.status, data, headers: response.headers };
  };
}

/** Đăng nhập fixture user `<prefix>_<who>` và trả cookie phiên. */
export async function loginUser(call: Call, prefix: string, password: string, who: string): Promise<string> {
  const r = await call("/api/auth/login", "POST", { login: `${prefix}_${who}`, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cookie = r.headers.get("set-cookie");
  assert.ok(cookie, "login phải trả set-cookie");
  return cookie.split(";")[0];
}
