/**
 * HTTP surface hardening helpers (CAM-G1-002):
 *  - `clientIp` — trusted-proxy-aware client IP resolution; X-Forwarded-For is
 *    honored only when the socket peer matches `TRUSTED_PROXY_CIDR`
 *    (comma-separated IPv4/IPv6 CIDRs or bare IPs; unset = trust nothing).
 *  - `remoteAddrFrom` — best-effort socket peer extraction; route handlers on
 *    `next start` have no socket API, so this is a seam for custom servers.
 *  - `readJsonBody` — bounded JSON reader enforcing 415/413/400.
 *  - `createFixedWindowLimiter` — bounded per-key attempt limiter (LRU eviction
 *    + expiry sweep) so the attempt map can never grow without limit.
 * Fail-closed: when the client IP cannot be determined, callers get "unknown"
 * and `httpGuardMetrics.clientIpUnknown` is incremented (never a crash).
 */

export interface HeaderSource {
  get(name: string): string | null;
}

/** In-process observability counters for the fail-closed paths. */
export const httpGuardMetrics = {
  clientIpUnknown: 0,
  forwardedForRejected: 0,
};

let lastWarnAt = 0;
function warnThrottled(message: string) {
  const now = Date.now();
  if (now - lastWarnAt >= 60_000) {
    lastWarnAt = now;
    console.warn(message);
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  constructor(status: number, code: string, message: string, detail?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Same {title, detail, status} JSON shape the API routes already return. */
export function toProblem(err: unknown): Response {
  if (err instanceof HttpError)
    return Response.json({ title: err.message, detail: err.detail ?? err.code, status: err.status }, { status: err.status });
  return Response.json({ title: "Không đọc được nội dung yêu cầu", status: 400 }, { status: 400 });
}

/**
 * Streamed, size-capped JSON body reader. Rejects non-JSON content types (415),
 * oversize bodies (413, checked on both content-length and the stream) and
 * malformed JSON (400). Returns null for an absent/empty body.
 */
export async function readJsonBody(req: Request, limit = 8 * 1024): Promise<unknown> {
  if (!req.headers.get("content-type")?.includes("application/json"))
    throw new HttpError(415, "JSON_REQUIRED", "Yêu cầu phải có Content-Type: application/json.");
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new HttpError(413, "BODY_TOO_LARGE", "Nội dung yêu cầu vượt giới hạn.");
  const reader = req.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "BODY_TOO_LARGE", "Nội dung yêu cầu vượt giới hạn.");
    }
    parts.push(value);
  }
  if (!size) return null;
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "JSON không hợp lệ.");
  }
}

/** Parse an IPv4 or IPv6 literal into a bigint; null when the string is not an IP. */
export function parseIp(input: string): { value: bigint; bits: 32 | 128 } | null {
  const s = input.trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return null;
    return { value: BigInt((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]), bits: 32 };
  }
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":")) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.includes(".")) {
        if (i !== tokens.length - 1) return null;
        const embedded = parseIp(token);
        if (embedded?.bits !== 32) return null;
        groups.push(Number(embedded.value >> BigInt(16)), Number(embedded.value & BigInt(0xffff)));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
        groups.push(parseInt(token, 16));
      }
    }
    return groups;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length >= 8) return null;
  const groups = [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  let value = BigInt(0);
  for (const g of groups) value = (value << BigInt(16)) | BigInt(g);
  return { value, bits: 128 };
}

interface TrustedNet {
  bits: 32 | 128;
  base: bigint;
  mask: bigint;
}

function parseTrustedNets(raw: string | undefined): TrustedNet[] {
  const nets: TrustedNet[] = [];
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    const [ipPart, prefixPart] = entry.split("/");
    const ip = parseIp(ipPart ?? "");
    if (!ip) continue;
    const maxPrefix = ip.bits;
    const prefix = prefixPart === undefined ? maxPrefix : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) continue;
    const mask = ((BigInt(1) << BigInt(prefix)) - BigInt(1)) << BigInt(maxPrefix - prefix);
    nets.push({ bits: ip.bits, base: ip.value & mask, mask });
  }
  return nets;
}

let trustedCache: { raw: string | undefined; nets: TrustedNet[] } = { raw: undefined, nets: [] };
function trustedNets(): TrustedNet[] {
  const raw = process.env.TRUSTED_PROXY_CIDR;
  if (trustedCache.raw !== raw) trustedCache = { raw, nets: parseTrustedNets(raw) };
  return trustedCache.nets;
}

function normalizeRemoteAddr(raw: string | null | undefined): string | null {
  let s = raw?.trim() ?? "";
  if (!s) return null;
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  if (/^::ffff:/i.test(s)) {
    const tail = s.slice(7);
    if (parseIp(tail)?.bits === 32) s = tail;
  }
  return s;
}

/**
 * Best-effort socket peer. `next start` route handlers receive a web Request
 * with no socket access; platform-provided `req.ip` or a Node-style
 * `req.socket.remoteAddress` are picked up when a custom server exposes them.
 */
export function remoteAddrFrom(req: Request): string | null {
  const r = req as unknown as { ip?: unknown; socket?: { remoteAddress?: unknown } };
  if (typeof r.ip === "string" && r.ip) return r.ip;
  const remote = r.socket?.remoteAddress;
  return typeof remote === "string" && remote ? remote : null;
}

/**
 * Resolve the client IP. X-Forwarded-For's first hop is used only when the
 * direct peer is inside TRUSTED_PROXY_CIDR; otherwise the peer itself is used,
 * falling back to "unknown" when no peer address exists at all.
 */
export function clientIp(h: HeaderSource, remoteAddr?: string | null): string {
  const remote = normalizeRemoteAddr(remoteAddr);
  const remoteIp = remote ? parseIp(remote) : null;
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const trusted = remoteIp != null && trustedNets().some((n) => n.bits === remoteIp.bits && (remoteIp.value & n.mask) === n.base);
  if (trusted && forwarded && parseIp(forwarded)) return forwarded;
  if (forwarded) {
    httpGuardMetrics.forwardedForRejected++;
    warnThrottled("[http-guard] x-forwarded-for ignored: peer is not in TRUSTED_PROXY_CIDR");
  }
  if (remote) return remote;
  httpGuardMetrics.clientIpUnknown++;
  warnThrottled("[http-guard] client IP undetermined — rate-limit bucket falls back to 'unknown'");
  return "unknown";
}

export interface FixedWindowLimiter {
  /** Register one attempt; returns true once `maxAttempts` is exceeded in the window. */
  limited(key: string, now?: number): boolean;
  readonly size: number;
}

/**
 * Bounded fixed-window limiter. The map is hard-capped at `maxEntries`:
 * expired entries are swept first, then the least-recently-hit keys are evicted.
 */
export function createFixedWindowLimiter({ maxAttempts, windowMs, maxEntries }: { maxAttempts: number; windowMs: number; maxEntries: number }): FixedWindowLimiter {
  const hits = new Map<string, { count: number; reset: number }>();
  return {
    get size() {
      return hits.size;
    },
    limited(key: string, now = Date.now()): boolean {
      const rec = hits.get(key);
      if (rec && rec.reset > now) {
        rec.count++;
        hits.delete(key);
        hits.set(key, rec);
        return rec.count > maxAttempts;
      }
      hits.delete(key);
      if (hits.size >= maxEntries) {
        for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
        // LRU eviction: delete the least-recently-hit key (Map keeps insertion order).        
        while (hits.size >= maxEntries) hits.delete(hits.keys().next().value!);
      }
      hits.set(key, { count: 1, reset: now + windowMs });
      return false;
    },
  };
}
