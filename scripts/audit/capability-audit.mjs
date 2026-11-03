#!/usr/bin/env node
/**
 * H-00 — Capability audit v2 (không thêm dependency; dùng typescript có sẵn).
 * Xuất artifacts/audit/{graph.json,findings.json,report.md}.
 *
 * Nguyên tắc:
 *  - Không kết luận chức năng chết chỉ vì không thấy TSX caller (worker/server action/external).
 *  - URL tính lúc chạy ⇒ DYNAMIC_UNRESOLVED.
 *  - "Tenant-scoped" chỉ coi là ĐÃ CHỨNG MINH khi thấy predicate `eq(<table>.tenantId, ...)`,
 *    không phải chỉ vì có authorize().
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const TESTS = path.join(ROOT, "tests");
const OUT = path.join(ROOT, "artifacts", "audit");
const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const WRITE_OPS = new Set(["insert", "update", "delete"]);

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const isCode = (f) => /\.(ts|tsx)$/.test(f) && !/\.d\.ts$/.test(f);
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function parseFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const info = {
    file, text, imports: [], apiRefs: [], tablesRead: new Set(), tablesWrite: new Set(),
    env: [], methods: [], withTenant: false, authorize: false, tenantPredicates: 0,
  };
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const apiRef = (raw, node) => {
    if (!raw.startsWith("/api/")) return;
    info.apiRefs.push({
      raw, dynamic: raw.includes("${"),
      norm: raw.replace(/\$\{[^}]*\}/g, "__X__").replace(/[?#].*$/, "").replace(/\/$/, ""),
      line: line(node),
    });
  };
  const tableArg = (n) => (n && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) ? n.getText(sf) : null);

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const r = resolveImport(file, node.moduleSpecifier.text);
      if (r) info.imports.push(r);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const r = resolveImport(file, node.moduleSpecifier.text);
      if (r) info.imports.push(r);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (API_METHODS.has(node.name.text)) info.methods.push(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrowFunction(node.initializer)) {
      if (API_METHODS.has(node.name.text)) info.methods.push(node.name.text);
    }
    if (ts.isStringLiteral(node)) apiRef(node.text, node);
    if (ts.isNoSubstitutionTemplateLiteral(node)) apiRef(node.text, node);
    if (ts.isTemplateExpression(node)) {
      let raw = node.head.text;
      for (const sp of node.templateSpans) raw += "${" + sp.expression.getText(sf) + "}" + sp.literal.text;
      apiRef(raw, node);
    }
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === "process.env" && ts.isIdentifier(node.name)) info.env.push(node.name.text);
    if (ts.isElementAccessExpression(node) && node.expression.getText(sf) === "process.env" && node.argumentExpression) {
      const a = node.argumentExpression;
      info.env.push(ts.isStringLiteral(a) ? a.text : `DYNAMIC:${a.getText(sf)}`);
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
      if (["eq", "ne", "inArray", "and", "or"].includes(callee) && node.arguments.some((a) => /\.tenantId\b/.test(a.getText(sf)))) {
        info.tenantPredicates += 1;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const op = node.expression.name.text;
      const recv = node.expression.expression.getText(sf);
      const isDb = /(^|\.)db$|(^|\.)tx$|^client$/.test(recv);
      if (isDb && (WRITE_OPS.has(op) || op === "select" || op === "from")) {
        const t = tableArg(node.arguments[0]);
        if (t) (WRITE_OPS.has(op) ? info.tablesWrite : info.tablesRead).add(t);
      }
      // db.select(...).from(table) — receiver là CallExpression
      if (op === "from" && /(^|\.)db\.|(^|\.)tx\.|^db$|^tx$/.test(recv)) {
        const t = tableArg(node.arguments[0]);
        if (t) info.tablesRead.add(t);
      }
    }
    if (ts.isIdentifier(node) && node.text === "withTenant") info.withTenant = true;
    if (ts.isIdentifier(node) && node.text === "authorize") info.authorize = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return info;
}

// ---------- load ----------
const codeFiles = walk(SRC).filter(isCode);
const parsed = new Map(codeFiles.map((f) => [f, parseFile(f)]));

// schema: bảng có tenant_id
const schemaText = fs.existsSync(path.join(SRC, "db", "schema.ts")) ? fs.readFileSync(path.join(SRC, "db", "schema.ts"), "utf8") : "";
const tenantTables = new Set();
for (const m of schemaText.matchAll(/export const (\w+) = pgTable\(\s*"([^"]+)"/g)) {
  const start = m.index;
  const end = schemaText.indexOf("});", start);
  const block = schemaText.slice(start, end === -1 ? start + 2000 : end);
  if (/tenantId|tenant_id/.test(block)) { tenantTables.add(m[1]); tenantTables.add(m[2]); }
}

// ---------- module-level tenant risk ----------
const modules = [];
for (const [file, info] of parsed) {
  const r = rel(file);
  if (!r.startsWith("src/lib/") && !r.startsWith("src/app/api/")) continue;
  const read = [...info.tablesRead].filter((t) => tenantTables.has(t));
  const write = [...info.tablesWrite].filter((t) => tenantTables.has(t));
  if (!read.length && !write.length) continue;
  modules.push({
    file: r, reads: read, writes: write,
    tenantPredicates: info.tenantPredicates,
    risk: info.tenantPredicates === 0 ? (write.length ? "HIGH" : "MEDIUM") : "OK",
  });
}
const riskOrder = { HIGH: 0, MEDIUM: 1, OK: 2 };
modules.sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || b.reads.length + b.writes.length - (a.reads.length + a.writes.length));

// ---------- routes ----------
const routes = [];
for (const [file, info] of parsed) {
  const r = rel(file);
  if (!/^src\/app\/api\/.*route\.ts$/.test(r)) continue;
  routes.push({
    route: "/api/" + r.replace(/^src\/app\/api\//, "").replace(/\/route\.ts$/, ""),
    file: r, methods: info.methods.length ? info.methods : ["?"], info,
  });
}
const routeRe = routes.map((r) => ({
  route: r.route,
  re: new RegExp("^/" + r.route.split("/").filter(Boolean).map((s) => (s.startsWith("[") ? "([^/]+)" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "$"),
}));
const matchRoute = (u) => routeRe.find((m) => m.re.test(u.replace(/__X__/g, "x")))?.route || null;

// ---------- pages + reachability ----------
const pageFiles = [...parsed.keys()].filter((f) => /^src\/app\/.*page\.tsx$/.test(rel(f)));
const pageReach = new Map();
for (const page of pageFiles) {
  const seen = new Set([page]);
  const stack = [page];
  while (stack.length) {
    const f = stack.pop();
    for (const i of parsed.get(f)?.imports || []) if (!seen.has(i)) { seen.add(i); stack.push(i); }
  }
  pageReach.set(rel(page), new Set([...seen].map(rel)));
}
const pagesFor = (fileRel) => [...pageReach].filter(([, files]) => files.has(fileRel)).map(([p]) => p);

// ---------- callers ----------
const callers = new Map();
for (const [file, info] of parsed) {
  if (/route\.ts$/.test(file)) continue;
  for (const ref of info.apiRefs) {
    const r = matchRoute(ref.norm);
    if (!r) continue;
    if (!callers.has(r)) callers.set(r, []);
    callers.get(r).push({ file: rel(file), pages: pagesFor(rel(file)), dynamic: ref.dynamic, line: ref.line });
  }
}

// ---------- tests ----------
const testText = new Map(walk(TESTS).filter((f) => /\.(ts|tsx|mjs)$/.test(f)).map((f) => [rel(f), fs.readFileSync(f, "utf8")]));
const testsFor = (route, fileRel) => {
  const mod = fileRel.replace(/^src\//, "@/").replace(/\/route\.ts$/, "").replace(/\.ts$/, "");
  return [...testText].filter(([, t]) => t.includes(route) || t.includes(mod) || t.includes(fileRel)).map(([f]) => f);
};

// ---------- closure (route + module nó gọi) ----------
function closureOf(info) {
  const seen = new Set();
  const stack = [...info.imports];
  const acc = {
    files: new Set(),
    reads: new Set(info.tablesRead),
    writes: new Set(info.tablesWrite),
    withTenant: info.withTenant,
    authorize: info.authorize,
    tenantPredicates: info.tenantPredicates,
  };
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !parsed.has(f)) continue;
    seen.add(f);
    const p = parsed.get(f);
    acc.files.add(rel(f));
    for (const t of p.tablesRead) acc.reads.add(t);
    for (const t of p.tablesWrite) acc.writes.add(t);
    acc.withTenant ||= p.withTenant;
    acc.authorize ||= p.authorize;
    acc.tenantPredicates += p.tenantPredicates;
    stack.push(...p.imports);
  }
  return acc;
}

// ---------- matrix ----------
const matrix = routes.map((r) => {
  const cs = callers.get(r.route) || [];
  const pages = [...new Set(cs.flatMap((c) => c.pages))];
  const cl = closureOf(r.info);
  const read = [...cl.reads].filter((t) => tenantTables.has(t));
  const write = [...cl.writes].filter((t) => tenantTables.has(t));
  const internal = /^\/api\/(internal|health)|auth\/google\/callback/.test(r.route);
  const status = !cs.length ? (internal ? "INTERNAL" : "MISSING_CONSUMER") : "IMPLEMENTED_UNVERIFIED";
  return {
    capability: r.route.split("/")[2] || "root",
    route: r.route, methods: r.methods, file: r.file,
    pages, callers: cs.map((c) => `${c.file}:${c.line}${c.dynamic ? " (dynamic)" : ""}`),
    reads: read, writes: write,
    guard: { withTenant: cl.withTenant, authorize: cl.authorize, tenantPredicates: cl.tenantPredicates },
    tenantProven: cl.tenantPredicates > 0,
    touchesTenantTable: read.length + write.length > 0,
    tests: testsFor(r.route, r.file),
    status,
  };
});

// ---------- findings ----------
const findings = { orphanRoutes: [], tenantRiskModules: [], duplicateCandidates: [], disabledControls: [], dynamicUrls: [] };
for (const m of matrix) {
  if (m.status === "MISSING_CONSUMER") findings.orphanRoutes.push({ route: m.route, methods: m.methods, file: m.file, reads: m.reads });
  for (const c of m.callers) if (c.includes("(dynamic)")) findings.dynamicUrls.push({ route: m.route, caller: c });
}
findings.tenantRiskModules = modules.filter((m) => m.risk !== "OK");

const sig = new Map();
for (const m of matrix) {
  const tables = [...new Set([...m.reads, ...m.writes])].sort();
  if (!tables.length) continue;
  const key = m.methods.slice().sort().join(",") + "|" + tables.join(",");
  if (!sig.has(key)) sig.set(key, []);
  sig.get(key).push(m.route);
}
for (const [k, list] of sig) if (list.length > 1) findings.duplicateCandidates.push({ signature: k, routes: list });

for (const [file, info] of parsed) {
  if (!file.endsWith(".tsx")) continue;
  info.text.split("\n").forEach((lineText, i) => {
    if (/\bdisabled=\{/.test(lineText) && !/disabled\?:/.test(lineText)) findings.disabledControls.push({ file: rel(file), line: i + 1, code: lineText.trim().slice(0, 110) });
  });
}

// ---------- write ----------
fs.mkdirSync(OUT, { recursive: true });
const totals = {
  routes: routes.length,
  codeFiles: codeFiles.length,
  pages: pageFiles.length,
  routesWithCaller: matrix.filter((m) => m.callers.length).length,
  routesWithoutCaller: matrix.filter((m) => !m.callers.length).length,
  routesTenantProven: matrix.filter((m) => m.tenantProven).length,
  modulesTouchingTenantTables: modules.length,
  modulesTenantRisk: findings.tenantRiskModules.length,
};
fs.writeFileSync(path.join(OUT, "graph.json"), JSON.stringify({ generatedAt: new Date().toISOString(), totals, pages: [...pageReach.keys()], routes: matrix, modules }, null, 2));
fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 2));

const md = ["# Capability audit — Camera D-AI", "", `Sinh bởi \`scripts/audit/capability-audit.mjs\` · ${new Date().toISOString()}`, "", "## Tổng quan", "", "| Hạng mục | Số |", "|---|---|"];
for (const [k, v] of Object.entries(totals)) md.push(`| ${k} | ${v} |`);
md.push("", "## Ma trận", "", "| Capability | Route | Method | Page | Đọc | Ghi | Tenant predicate | Test | Status |", "|---|---|---|---|---|---|---|---|---|");
for (const m of matrix) {
  md.push(`| ${m.capability} | \`${m.route}\` | ${m.methods.join(",")} | ${m.pages.map((p) => p.replace("src/app/", "").replace("/page.tsx", "")).join(", ") || "—"} | ${m.reads.join(", ") || "—"} | ${m.writes.join(", ") || "—"} | ${m.guard.tenantPredicates} | ${m.tests.length} | ${m.status} |`);
}
md.push("", "## Module chạm bảng tenant mà KHÔNG có predicate tenantId", "", "| File | Đọc | Ghi | Risk |", "|---|---|---|---|");
for (const m of findings.tenantRiskModules) md.push(`| ${m.file} | ${m.reads.join(", ") || "—"} | ${m.writes.join(", ") || "—"} | ${m.risk} |`);
md.push("", `## Route không có consumer (${findings.orphanRoutes.length})`, "");
for (const f of findings.orphanRoutes) md.push(`- \`${f.route}\` (${f.methods.join(",")}) — ${f.file}`);
md.push("", `## Nghi vấn trùng chức năng (${findings.duplicateCandidates.length}) — CHỈ ỨNG VIÊN`, "");
for (const d of findings.duplicateCandidates) md.push(`- \`${d.signature}\` → ${d.routes.map((r) => `\`${r}\``).join(", ")}`);
md.push("", `## URL động (${findings.dynamicUrls.length})`, "");
for (const d of findings.dynamicUrls.slice(0, 50)) md.push(`- \`${d.route}\` ← ${d.caller}`);
md.push("", "> DUPLICATE_CONFIRMED cần Playwright trace + so input/output/side-effect/quyền. Không xoá gì từ file này.");
fs.writeFileSync(path.join(OUT, "report.md"), md.join("\n"));
console.log(JSON.stringify({ ok: true, totals, findings: { orphan: findings.orphanRoutes.length, tenantRisk: findings.tenantRiskModules.length, duplicates: findings.duplicateCandidates.length, dynamic: findings.dynamicUrls.length, disabled: findings.disabledControls.length } }, null, 2));
