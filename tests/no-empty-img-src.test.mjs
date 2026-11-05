// Regression guard: không được render <img> với src rỗng.
// Lý do: camera RTSP có thumbnail = null; `src={thumbnail ?? ""}` làm React/Next
// báo "An empty string was passed to the src attribute" và tải lại chính trang.
// Chạy: node --test tests/no-empty-img-src.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SCAN_DIRS = ["src/app", "src/components"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
const EMPTY_SRC = /<img\b[^>]*\bsrc=\{\s*[^}]*\?\?\s*""\s*\}|<img\b[^>]*\bsrc=""/g;

test("no <img> is rendered with an empty src", () => {
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(EMPTY_SRC)) {
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`${relative(ROOT, file)}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], `empty img src found:\n${offenders.join("\n")}`);
});
