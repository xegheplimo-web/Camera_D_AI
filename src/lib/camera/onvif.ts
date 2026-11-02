/** ONVIF WS-Discovery UDP multicast. No credential guessing and no IP-range sweeps. */
import dgram from "node:dgram";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { isPrivateIPv4 } from "./ipv4";

export { isPrivateIPv4 };

export type DiscoveredCamera = {
  ip: string;
  endpoint: string;
  urn: string | null;
  name: string;
  scopes: string[];
};

/** Interface IPv4 LAN (RFC1918 + APIPA) sẽ gửi probe — một luật lọc cho cả quét và audit. */
function lanInterfaces(): os.NetworkInterfaceInfo[] {
  return Object.values(os.networkInterfaces()).flat()
    .filter((it): it is os.NetworkInterfaceInfo => !!it && it.family === "IPv4" && !it.internal && isPrivateIPv4(it.address));
}

/** Dải mạng (CIDR) mà lần quét ONVIF sẽ phát probe vào — chỉ để log audit, không chứa credential. */
export function lanProbeRanges(): string[] {
  const ranges = new Set<string>();
  for (const it of lanInterfaces()) {
    const a = it.address.split(".").map(Number);
    const m = (it.netmask || "255.255.255.255").split(".").map(Number);
    if (a.length !== 4 || m.length !== 4 || a.some((n) => n > 255) || m.some((n) => n > 255)) continue;
    const net = a.map((n, i) => n & m[i]);
    const bits = m.reduce((acc, n) => acc + n.toString(2).replace(/0/g, "").length, 0);
    ranges.add(`${net.join(".")}/${bits}`);
  }
  return [...ranges];
}

function tag(xml: string, local: string): string {
  return new RegExp(`<(?:(?:[A-Za-z][\\w.-]*):)?${local}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z][\\w.-]*):)?${local}\\s*>`, "i")
    .exec(xml)?.[1]?.trim() ?? "";
}

export function parseProbeMatch(xml: string, ip: string): DiscoveredCamera | null {
  if (!isPrivateIPv4(ip) || xml.length > 65_536 || !/<(?:\w+:)?ProbeMatch\b/i.test(xml)) return null;
  // Never fetch remote URLs during discovery. Only display device addresses matching sender IP.
  const raw = tag(xml, "XAddrs");
  const endpoints = raw.split(/\s+/).filter(Boolean);
  const endpoint = endpoints.find((item) => {
    try {
      const u = new URL(item.replace(/&amp;/g, "&"));
      return (u.protocol === "http:" || u.protocol === "https:") && u.hostname === ip && !u.username && !u.password;
    } catch { return false; }
  });
  if (!endpoint) return null;
  const scopeText = tag(xml, "Scopes");
  const scopes = scopeText.split(/\s+/).filter(Boolean).slice(0, 30);
  const nameScope = scopes.find((s) => /\/name\//i.test(s));
  let name = `Camera ${ip}`;
  if (nameScope) {
    try { name = decodeURIComponent(nameScope.split("/name/")[1] || name).slice(0, 80); } catch { /* invalid scope */ }
  }
  const urn = tag(tag(xml, "EndpointReference") || xml, "Address");
  return { ip, endpoint, urn: urn.slice(0, 120) || null, name, scopes };
}

export function makeProbe(id: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><s:Header><a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action><a:MessageID>urn:uuid:${id}</a:MessageID><a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo><a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header><s:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></s:Body></s:Envelope>`
    .replace('xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"', 'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"');
}

export async function discoverOnvif(timeoutMs = 3200): Promise<DiscoveredCamera[]> {
  const duration = Math.max(1000, Math.min(6000, timeoutMs));
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map<string, DiscoveredCamera>();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch { /* ignore socket cleanup */ }
      if (err) reject(err);
      else resolve([...found.values()].sort((a, b) => a.ip.localeCompare(b.ip)));
    };
    socket.on("message", (buf, rinfo) => {
      const row = parseProbeMatch(buf.toString("utf8"), rinfo.address);
      if (row && found.size < 128) found.set(`${row.ip}:${new URL(row.endpoint).port || "80"}`, row);
    });
    socket.on("error", (e) => finish(e));
    socket.bind(0, "0.0.0.0", () => {
      if (settled) return;
      try { socket.setMulticastTTL(1); } catch { /* OS-dependent */ }
      const probe = Buffer.from(makeProbe(randomUUID()));
      // Probe once on each active IPv4 interface, plus the OS default route.
      const send = (iface?: string) => {
        try {
          if (iface) socket.setMulticastInterface(iface);
          socket.send(probe, 3702, "239.255.255.250", () => { /* responses arrive asynchronously */ });
        } catch { /* interface unsupported; try other interfaces */ }
      };
      for (const network of lanInterfaces()) send(network.address);
      send();
      timer = setTimeout(() => finish(), duration);
    });
  });
}
