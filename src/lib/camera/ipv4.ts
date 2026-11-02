/**
 * IPv4 range rules shared giữa server (onvif/stream) và client (CameraDiscovery).
 * Pure TypeScript — không import node:* nên bundle được cả phía browser ("use client").
 * Một nguồn sự thật duy nhất: sửa luật ở đây áp dụng đồng thời cho validateCameraUrl
 * server-side và kiểm tra sớm phía client (tránh trôi như T-1302→T-1304).
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Octets IPv4 chặt tương đương net.isIP(): đúng 4 octet ≤255, không leading-zero. */
function octets(value: string): number[] | null {
  const m = IPV4_RE.exec(value);
  if (!m) return null;
  const raw = m.slice(1);
  if (raw.some((p) => p.length > 1 && p.startsWith("0"))) return null;
  const nums = raw.map(Number);
  return nums.every((n) => n <= 255) ? nums : null;
}

/** RFC 3927 IPv4 link-local/APIPA 169.254.0.0/16 — gồm cả cloud metadata 169.254.169.254. */
export function isLinkLocalIPv4(value: string): boolean {
  const n = octets(value);
  return !!n && n[0] === 169 && n[1] === 254;
}

/**
 * Host nguồn RTSP hợp lệ: chỉ IPv4 LAN riêng RFC 1918
 * (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16).
 * Chặn link-local (SSRF tới metadata service), CGNAT 100.64/10, loopback,
 * 0.0.0.0, public, IPv6 và mọi hostname không phải IPv4.
 */
export function isLanRtspHost(value: string): boolean {
  const n = octets(value);
  return !!n && (n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168));
}

/**
 * IPv4 "LAN riêng" theo nghĩa rộng = RFC 1918 + link-local.
 * CHỈ dùng cho ONVIF WS-Discovery (camera APIPA tự phát 169.254.x) — không dùng
 * để duyệt nguồn RTSP (dùng isLanRtspHost).
 */
export function isPrivateIPv4(value: string): boolean {
  return isLanRtspHost(value) || isLinkLocalIPv4(value);
}
