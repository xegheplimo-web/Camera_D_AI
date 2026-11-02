import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isPrivateIPv4, parseProbeMatch, makeProbe } from "../src/lib/camera/onvif";
import { validateCameraUrl, encryptSource, decryptSource, maskCameraUrl } from "../src/lib/camera/stream";
import { parseProductMeta } from "../src/lib/product";

test("private IPv4 allowlist prevents public addresses and DNS rebind", () => {
  assert.equal(isPrivateIPv4("192.168.1.12"), true);
  assert.equal(isPrivateIPv4("172.31.1.2"), true);
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  assert.equal(isPrivateIPv4("127.0.0.1"), false);
  assert.throws(() => validateCameraUrl("rtsp://public.example.com/stream"));
  assert.throws(() => validateCameraUrl("rtsp://8.8.8.8/live"));
  assert.throws(() => validateCameraUrl("http://192.168.1.12/live"));
});

test("ONVIF WS-Discovery parses matching local sender and rejects public / mismatch", () => {
  const xml = `<s:Envelope><s:Body><d:ProbeMatch><d:EndpointReference><a:Address>urn:uuid:abc</a:Address></d:EndpointReference><d:XAddrs>http://192.168.1.21/onvif/device_service</d:XAddrs><d:Scopes>onvif://www.onvif.org/name/FrontDoor</d:Scopes></d:ProbeMatch></s:Body></s:Envelope>`;
  const device = parseProbeMatch(xml,"192.168.1.21");
  assert.equal(device?.ip,"192.168.1.21");
  assert.equal(device?.name,"FrontDoor");
  assert.equal(parseProbeMatch(xml,"192.168.1.22"),null);
  assert.equal(parseProbeMatch(xml,"1.1.1.1"),null);
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
