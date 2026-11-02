import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isPrivateIPv4, parseProbeMatch, makeProbe } from "../src/lib/camera/onvif";
import { isLanRtspHost, isLinkLocalIPv4 } from "../src/lib/camera/ipv4";
import { validateCameraUrl, encryptSource, decryptSource, maskCameraUrl } from "../src/lib/camera/stream";
import { parseProductMeta } from "../src/lib/product";

test("private IPv4 allowlist prevents public addresses and DNS rebind", () => {
  assert.equal(isPrivateIPv4("192.168.1.12"), true);
  assert.equal(isPrivateIPv4("172.31.1.2"), true);
  assert.equal(isPrivateIPv4("169.254.10.20"), true); // APIPA vẫn là "LAN riêng" — chỉ cho ONVIF discovery
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  assert.equal(isPrivateIPv4("127.0.0.1"), false);
  assert.throws(() => validateCameraUrl("rtsp://public.example.com/stream"));
  assert.throws(() => validateCameraUrl("rtsp://8.8.8.8/live"));
  assert.throws(() => validateCameraUrl("http://192.168.1.12/live"));
});

// T-1304 — nguồn RTSP chỉ IPv4 RFC1918: link-local 169.254/16 (metadata service
// trên VM/cloud → SSRF qua proxy go2rtc), CGNAT 100.64/10, loopback, 0.0.0.0,
// IPv6 và hostname đều bị chặn.
test("isLanRtspHost chỉ cho phép IPv4 RFC1918, chặn link-local/CGNAT/loopback/IPv6/hostname", () => {
  for (const ok of ["10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.1", "192.168.1.238", "192.168.99.10"])
    assert.equal(isLanRtspHost(ok), true, ok);
  for (const bad of [
    "169.254.169.254", "169.254.0.1", "169.254.255.255",
    "100.64.0.1", "100.127.255.254", "127.0.0.1", "0.0.0.0",
    "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.167.1.1", "192.169.1.1",
    "::1", "fe80::1", "camera.lan", "localhost", "01.2.3.4",
  ]) assert.equal(isLanRtspHost(bad), false, bad);
  assert.equal(isLinkLocalIPv4("169.254.169.254"), true);
  assert.equal(isLinkLocalIPv4("169.254.0.0"), true);
  assert.equal(isLinkLocalIPv4("192.168.1.1"), false);
});

test("SSRF negative: IPv4 link-local (metadata 169.254.169.254) rejected with clear reason", () => {
  for (const u of [
    "rtsp://169.254.169.254/live", "rtsp://169.254.169.254:554/x",
    "rtsps://169.254.169.254/x", "rtsp://169.254.0.1/x", "rtsp://169.254.255.255/x",
    "rtsp://user:pass@169.254.169.254/x",
  ]) assert.throws(() => validateCameraUrl(u), /link-local/i, u);
  // CGNAT + loopback + 0.0.0.0 explicit theo card T-1304
  for (const u of ["rtsp://100.64.0.1/x", "rtsp://127.0.0.1/x", "rtsp://0.0.0.0/x"])
    assert.throws(() => validateCameraUrl(u), u);
});

// CAM-G2-001 — SSRF negative matrix: ngoài CIDR allowlist, IPv6, link-local,
// hostname LAN đều phải bị chặn. Fixture CIDR 192.168.99.0/24 vẫn được phép.
test("SSRF negative: public/outside-allowlist IPv4 is rejected", () => {
  for (const u of [
    "rtsp://8.8.8.8/live", "rtsp://1.1.1.1/live", "rtsp://203.0.113.5/live",
    "rtsp://11.0.0.1/live", "rtsp://172.32.0.1/live", "rtsp://172.15.0.1/live",
    "rtsp://192.167.1.1/live", "rtsp://192.169.1.1/live", "rtsp://100.64.0.1/live",
  ]) assert.throws(() => validateCameraUrl(u), u);
});

test("SSRF negative: loopback in every spelling is rejected", () => {
  for (const u of [
    "rtsp://127.0.0.1/live", "rtsp://127.1/live", "rtsp://127.0.1/live",
    "rtsp://0x7f000001/live", "rtsp://2130706433/live", "rtsp://0177.0.0.1/live",
    "rtsp://localhost/live", "rtsp://0/live",
  ]) assert.throws(() => validateCameraUrl(u), u);
});

test("SSRF negative: IPv6 (loopback, ULA, link-local, multicast, v4-mapped) is rejected", () => {
  for (const u of [
    "rtsp://[::1]/live", "rtsp://[fd00::1]/live", "rtsp://[fec0::1]/live",
    "rtsp://[fe80::1]/live", "rtsp://[fe80::1%25eth0]/live",
    "rtsp://[ff02::1]/live", "rtsp://[::ffff:192.168.1.1]/live",
  ]) assert.throws(() => validateCameraUrl(u), u);
});

test("SSRF negative: LAN and public hostnames are rejected (no DNS path)", () => {
  for (const u of [
    "rtsp://camera.lan/live", "rtsp://mycam.local/live", "rtsp://living-room-cam/live",
    "rtsp://cam-01.internal/live", "rtsp://public.example.com/live",
  ]) assert.throws(() => validateCameraUrl(u), u);
});

test("SSRF negative: non-RTSP schemes, fragments, bad ports, malformed input are rejected", () => {
  for (const u of [
    "http://192.168.99.10/live", "https://192.168.99.10/live", "ftp://192.168.99.10/live",
    "file://192.168.99.10/live", "rtspu://192.168.99.10/live",
    "rtsp://192.168.99.10/live#frag", "rtsp://192.168.99.10:0/live",
    "rtsp://192.168.99.10:70000/live", "rtsp://192.168.99.10:65536/live",
    "", "rtsp://", "notaurl", "rtsp://192.168.99.10/\nSet-Cookie: x",
  ]) assert.throws(() => validateCameraUrl(u), JSON.stringify(u));
});

test("SSRF positive: fixture CIDR 192.168.99.0/24 và LAN RFC1918 vẫn hợp lệ cho RTSP", () => {
  const fixture = validateCameraUrl("rtsp://192.168.99.10:8554/g2cam");
  assert.equal(fixture.hostname, "192.168.99.10");
  assert.equal(fixture.port, "8554");
  const lan = validateCameraUrl("rtsp://192.168.1.10:554/s1");
  assert.equal(lan.hostname, "192.168.1.10");
  assert.equal(lan.port, "554");
  // T-1304: 169.254.0.0/16 vẫn là "LAN riêng" cho ONVIF discovery (camera APIPA
  // tự phát) nhưng cấm làm nguồn RTSP — isPrivateIPv4 giữ true, validateCameraUrl chặn.
  assert.equal(isPrivateIPv4("169.254.169.254"), true);
  assert.throws(() => validateCameraUrl("rtsp://169.254.169.254/x"), /link-local/i);
});

test("ONVIF WS-Discovery parses matching local sender and rejects public / mismatch", () => {
  const xml = `<s:Envelope><s:Body><d:ProbeMatch><d:EndpointReference><a:Address>urn:uuid:abc</a:Address></d:EndpointReference><d:XAddrs>http://192.168.1.21/onvif/device_service</d:XAddrs><d:Scopes>onvif://www.onvif.org/name/FrontDoor</d:Scopes></d:ProbeMatch></s:Body></s:Envelope>`;
  const device = parseProbeMatch(xml,"192.168.1.21");
  assert.equal(device?.ip,"192.168.1.21");
  assert.equal(device?.name,"FrontDoor");
  assert.equal(parseProbeMatch(xml,"192.168.1.22"),null);
  assert.equal(parseProbeMatch(xml,"1.1.1.1"),null);
  // T-1304: ONVIF discovery giữ nguyên hỗ trợ sender link-local (camera APIPA).
  const apipa = xml.replaceAll("192.168.1.21", "169.254.11.22");
  assert.equal(parseProbeMatch(apipa, "169.254.11.22")?.ip, "169.254.11.22");
  assert.ok(makeProbe("abc").includes("NetworkVideoTransmitter"));
});

test("RTSP camera profile is AES-GCM encrypted and does not expose a password", () => {
  const previous = process.env.CAMERA_CREDENTIAL_KEY;
  process.env.CAMERA_CREDENTIAL_KEY = randomBytes(32).toString("hex");
  try {
    const url = "rtsp://user:secret@192.168.1.70:554/Streaming/Channels/101";
    const ct = encryptSource(url);
    assert.ok(!ct.includes("secret"));
    assert.equal(decryptSource(ct), url);
    assert.ok(!maskCameraUrl(url).includes("secret"));
    assert.throws(() => decryptSource(ct.slice(0,-3)+"xyz"));
  } finally { if (previous === undefined) delete process.env.CAMERA_CREDENTIAL_KEY; else process.env.CAMERA_CREDENTIAL_KEY=previous; }
});

test("product metadata remains user supplied and validated", () => {
  assert.deepEqual(parseProductMeta({ productName: " Áo thun ", sku: "TS-01", priceVnd: "150000", quantity: "20" }),
    { productName: "Áo thun", sku: "TS-01", priceVnd: 150000, quantity: 20 });
  assert.equal(parseProductMeta({ priceVnd:"" }).priceVnd,null);
  assert.throws(() => parseProductMeta({ priceVnd:"150000.5" }));
  assert.throws(() => parseProductMeta({ quantity:-1 }));
});
