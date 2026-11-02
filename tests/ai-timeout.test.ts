import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAiTimeout } from "../src/lib/ai/services";

// T-1315 — per-call AI timeout bounds: OCR/vision on large images needs > 20s,
// so the hard cap is 60000 ms (job-level waitForJob stays at 120 s).
test("AI timeout: default and clamped bounds", () => {
  assert.equal(resolveAiTimeout(undefined), 15000);
  assert.equal(resolveAiTimeout("45000"), 45000);
  assert.equal(resolveAiTimeout("999999"), 60000);
  assert.equal(resolveAiTimeout("0"), 15000);
  assert.equal(resolveAiTimeout("abc"), 15000);
  assert.equal(resolveAiTimeout("500"), 1000);
});
