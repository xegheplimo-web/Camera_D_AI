import test from "node:test";
import assert from "node:assert/strict";
import {
  gtinChecksumOk,
  identityFingerprint,
  identityKey,
  mergeIdentity,
  normalizeGtin,
  parsePack,
  parseQuantity,
  toIdentity,
} from "../src/lib/knowledge/normalize";

test("parseQuantity: quy đổi lít/ki-lô-gam về ml/g", () => {
  assert.deepEqual(parseQuantity("0,5 l"), { value: 500, unit: "ml" });
  assert.deepEqual(parseQuantity("500ml"), { value: 500, unit: "ml" });
  assert.deepEqual(parseQuantity("1.5 L"), { value: 1500, unit: "ml" });
  assert.deepEqual(parseQuantity("250 g"), { value: 250, unit: "g" });
  assert.deepEqual(parseQuantity("1,2kg"), { value: 1200, unit: "g" });
});

test("parseQuantity: từ chối giá trị không phải dung tích/khối lượng", () => {
  assert.equal(parseQuantity("6 chai"), null);
  assert.equal(parseQuantity(""), null);
  assert.equal(parseQuantity("0 ml"), null);
  assert.equal(parseQuantity(500 as unknown as string), null);
});

test("parsePack: lốc 6 chai ≠ 1 chai", () => {
  assert.deepEqual(parsePack("lốc 6 chai"), { packCount: 6, sellingUnit: "lốc" });
  assert.deepEqual(parsePack("thùng 24 lon"), { packCount: 24, sellingUnit: "thùng" });
  const single = parsePack("chai");
  assert.equal(single.packCount, null);
  assert.equal(single.sellingUnit, "chai");
});

test("normalizeGtin: chỉ nhận GTIN hợp lệ, chuẩn hoá về 14 số", () => {
  // 8938505974194 là EAN-13 hợp lệ (checksum 4)
  assert.equal(normalizeGtin("8938505974194"), "08938505974194");
  assert.equal(normalizeGtin("8938 505 974 194"), "08938505974194");
  // sai checksum
  assert.equal(normalizeGtin("8938505974195"), null);
  // QR/URL không phải GTIN
  assert.equal(normalizeGtin("https://example.com/p/1"), null);
  assert.equal(normalizeGtin("123"), null);
});

test("gtinChecksumOk: đúng/sai", () => {
  assert.equal(gtinChecksumOk("8938505974194"), true);
  assert.equal(gtinChecksumOk("8938505974195"), false);
  assert.equal(gtinChecksumOk("abc"), false);
});

test("identityKey: GTIN thắng; không GTIN thì cần brand", () => {
  const withGtin = toIdentity({ gtin: "8938505974194", brand: "TH", netQuantity: "180 ml" });
  assert.equal(identityKey(withGtin), "gtin:08938505974194");

  const noBrand = toIdentity({ netQuantity: "180 ml", flavor: "ít đường" });
  assert.equal(identityKey(noBrand), null, "thiếu brand/GTIN thì không đủ tin để tạo khoá");

  const full = toIdentity({ brand: "TH", flavor: "ít đường", netQuantity: "180 ml", sellingUnit: "hộp" });
  // thứ tự: brand|productLine|flavor|netQuantity|netUnit|packCount|sellingUnit
  assert.equal(identityKey(full), "th||ít đường|180|ml||hộp");
});

test("identityKey: khác vị và khác dung tích cho khoá khác nhau", () => {
  const a = toIdentity({ brand: "Nam Ngư", flavor: "cá cơm", netQuantity: "500 ml" });
  const b = toIdentity({ brand: "Nam Ngư", flavor: "cá hồi", netQuantity: "500 ml" });
  const c = toIdentity({ brand: "Coca-Cola", netQuantity: "330 ml" });
  const d = toIdentity({ brand: "Coca-Cola", netQuantity: "320 ml" });
  assert.notEqual(identityKey(a), identityKey(b));
  assert.notEqual(identityKey(c), identityKey(d));
});

test("identityFingerprint: đổi trường định danh thì đổi, đổi ảnh/ghi chú thì không", () => {
  const base = toIdentity({ brand: "TH", flavor: "ít đường", netQuantity: "180 ml" });
  const same = toIdentity({ brand: "TH", flavor: "ít đường", netQuantity: "0,18 l" });
  assert.equal(identityFingerprint(base), identityFingerprint(same), "0,18 l = 180 ml");

  const changedFlavor = toIdentity({ brand: "TH", flavor: "không đường", netQuantity: "180 ml" });
  assert.notEqual(identityFingerprint(base), identityFingerprint(changedFlavor));
});

test("mergeIdentity: chỉ tăng revision khi vân tay định danh đổi", () => {
  const r1 = mergeIdentity({}, { brand: "TH", netQuantity: "180 ml" });
  assert.equal(r1.changed, true);
  assert.equal(r1.custom.identityRevision, 1);

  const r2 = mergeIdentity(r1.custom, { note: "kệ số 3" });
  assert.equal(r2.changed, false);
  assert.equal(r2.custom.identityRevision, 1, "ghi chú không làm tăng revision");

  const r3 = mergeIdentity(r2.custom, { netQuantity: "1 l" });
  assert.equal(r3.changed, true);
  assert.equal(r3.custom.identityRevision, 2);
});

test("mergeIdentity: null xoá trường, không ghi undefined", () => {
  const r = mergeIdentity({ brand: "TH", flavor: "ít đường" }, { flavor: null });
  assert.equal(r.identity.flavor, null);
  assert.equal(r.changed, true);
  assert.equal(r.custom.identityRevision, 1);
});
