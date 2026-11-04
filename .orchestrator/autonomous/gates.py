#!/usr/bin/env python3
"""Deterministic gate suite for the Camera D-AI autonomous loop (v2).

Usage:  python gates.py <MILESTONE_ID>

Exit codes (contract with loop.py):
  0 = gate PASSED      (real commands were run and every assertion held)
  1 = gate FAILED      (a command ran and the result contradicts the gate)
  3 = UNVERIFIABLE     (no gate implemented / required credential or service absent)

Rules:
  - Never print secrets. Credentials are read from the secret env file and only
    exit codes / HTTP statuses are printed.
  - "Unverifiable != pass" (loop.py R5): missing tools, missing secrets or an
    unreachable service return 3, never 0.
  - A gate must include a positive control, so "service down" cannot masquerade
    as "anonymous access denied".
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("LOOP_ROOT") or Path(__file__).resolve().parent)
REPO = ROOT.parent.parent  # .orchestrator/autonomous -> repo root

MEDIAMTX_RTSP = os.environ.get("MEDIAMTX_RTSP", "rtsp://192.168.1.243:8554/cam")
MEDIAMTX_API = os.environ.get("MEDIAMTX_API", "http://127.0.0.1:9997")
GO2RTC_API = os.environ.get("GO2RTC_API", "http://127.0.0.1:1984")
SECRET_ENV = Path(os.environ.get("MEDIAMTX_ENV", str(Path.home() / ".camdai" / "mediamtx.env")))


class Fail(Exception):
    """Gate assertion failed (exit 1)."""


class Unverifiable(Exception):
    """Cannot verify right now (exit 3)."""


def log(msg: str) -> None:
    print(msg, flush=True)


def read_secret(key: str) -> str:
    if not SECRET_ENV.exists():
        raise Unverifiable(f"missing secret file {SECRET_ENV}")
    for line in SECRET_ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() == key:
            return v.strip()
    raise Unverifiable(f"missing {key} in {SECRET_ENV}")


def which(tool: str) -> str:
    p = shutil.which(tool)
    if p:
        return p
    raise Unverifiable(f"{tool} not found on PATH")


def run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Unverifiable(f"command timed out after {timeout}s: {cmd[0]}")


def _resolve(exe: str) -> str:
    """Windows subprocess does not apply PATHEXT; npm/npx are .CMD shims."""
    found = shutil.which(exe)
    return found or exe


def sh(cmd: list[str], timeout: int = 40) -> tuple[int, str]:
    """Run a command, never raise. Returns (exit_code, combined output).

    Always runs from the repo root: a gate must produce the same verdict no
    matter which directory loop.py happened to invoke it from.
    """
    cmd = [_resolve(cmd[0]), *cmd[1:]]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           cwd=str(REPO))
        return p.returncode, ((p.stdout or "") + (p.stderr or "")).strip()
    except FileNotFoundError:
        return 127, f"command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, "timeout"


def sql(query: str, db: str = "app_db") -> tuple[int, str]:
    """Run a read-only SQL query against the app database container."""
    return sh(["docker", "exec", "camdai-pg", "psql", "-U", "postgres",
               "-d", db, "-tAc", query], timeout=40)


def http_status(url: str, timeout: int = 15) -> tuple[int, int]:
    """Return (status, bytes_read). 0 status when the request itself failed."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, len(r.read(4096))
    except urllib.error.HTTPError as e:
        return e.code, 0
    except Exception:
        return 0, 0


def redact(text: str) -> str:
    """Never let a credential-bearing URL reach the log."""
    return re.sub(r"//[^/@\s]+@", "//[REDACTED]@", text)


# ---------------------------------------------------------------------------
# M0 — MediaMTX locked down: no anonymous read, unknown publish path rejected,
#      physical camera 796 still streams, config tracked without secrets.
# ---------------------------------------------------------------------------
def gate_m0() -> None:
    ffprobe = which("ffprobe")
    ffmpeg = which("ffmpeg")

    # --- structural: tracked config must not carry the old open user ---
    cfg_path = REPO / "infra" / "mediamtx" / "mediamtx.yml"
    if not cfg_path.exists():
        raise Fail(f"tracked config missing: {cfg_path}")
    cfg = cfg_path.read_text(encoding="utf-8")
    if not re.search(r"^authInternalUsers:\s*\[\]\s*$", cfg, re.M):
        raise Fail("tracked config must declare 'authInternalUsers: []' (env-injected users)")
    if re.search(r"^\s*-\s*user:\s*any\s*$", cfg, re.M):
        raise Fail("tracked config still declares an 'any' user")
    if not re.search(r"^pathDefaults:\s*$[\s\S]*?^\s+record:\s*no\s*$", cfg, re.M):
        raise Fail("pathDefaults.record must be 'no' (only registered paths record)")
    if re.search(r"pass\s*:\s*\S+", cfg):
        raise Fail("tracked config appears to contain a password")
    log("PASS structural: tracked config has env-injected users, record defaults off, no secret")

    # --- runtime: API must show 4 split users, none of them anonymous+read ---
    st, _ = http_status(f"{MEDIAMTX_API}/v3/config/global/get")
    if st == 0:
        raise Unverifiable(f"MediaMTX API unreachable at {MEDIAMTX_API}")
    if st != 200:
        raise Fail(f"MediaMTX API returned {st} for a loopback caller (app would break)")
    with urllib.request.urlopen(f"{MEDIAMTX_API}/v3/config/global/get", timeout=15) as r:
        conf = json.load(r)
    users = conf.get("authInternalUsers") or []
    names = [u.get("user") for u in users]
    if len(users) != 4:
        raise Fail(f"expected 4 role users, API reports {len(users)}: {names}")
    for u in users:
        actions = {p.get("action") for p in u.get("permissions", [])}
        if u.get("user") == "any" and actions & {"publish", "read", "playback"}:
            raise Fail("anonymous 'any' user still holds publish/read/playback")
        if u.get("user") != "any" and not u.get("pass"):
            raise Fail(f"user {u.get('user')} has an empty password")
    if "publisher" not in names or "reader" not in names:
        raise Fail("publisher/reader users missing from runtime config")
    log(f"PASS runtime: {len(users)} split users, no anonymous publish/read/playback")

    # --- Layer A1: anonymous read must FAIL, and the failure must be auth (401) ---
    anon = run([ffprobe, "-v", "error", "-rtsp_transport", "tcp",
                "-select_streams", "v:0", "-show_entries", "stream=codec_name",
                "-of", "csv=p=0", MEDIAMTX_RTSP], 25)
    blob = (anon.stdout or "") + (anon.stderr or "")
    if anon.returncode == 0:
        raise Fail(f"anonymous ffprobe SUCCEEDED against {MEDIAMTX_RTSP}: {(anon.stdout or '').strip()[:120]}")
    if "401" not in blob and "Unauthorized" not in blob:
        raise Unverifiable("anonymous read failed without an auth error: "
                           + redact(blob.strip())[-200:])
    log("PASS A1: anonymous ffprobe rejected with 401")

    # --- positive control: credentialed read must SUCCEED (proves path is alive) ---
    read_pass = read_secret("MEDIAMTX_READ_PASS")
    read_user = read_secret("MEDIAMTX_READ_USER")
    authed_url = re.sub(r"^rtsp://", f"rtsp://{read_user}:{read_pass}@", MEDIAMTX_RTSP)
    ok = run([ffprobe, "-v", "error", "-rtsp_transport", "tcp",
              "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height",
              "-of", "csv=p=0", authed_url], 25)
    if ok.returncode != 0:
        raise Fail("credentialed read failed — stream is dead, so A1 proves nothing: "
                   + redact((ok.stderr or "").strip())[-200:])
    log(f"PASS control: credentialed read ok ({ok.stdout.strip()})")

    # --- Layer A2: publish to an unregistered path must be rejected with 400 ---
    pub_pass = read_secret("MEDIAMTX_PUBLISH_PASS")
    pub_user = read_secret("MEDIAMTX_PUBLISH_USER")
    base = re.sub(r"^rtsp://", "", MEDIAMTX_RTSP).rsplit("/", 1)[0]
    pub_url = f"rtsp://{pub_user}:{pub_pass}@{base}/khong_dang_ky_gate"
    pub = run([ffmpeg, "-hide_banner", "-loglevel", "error", "-re",
               "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=5", "-t", "2",
               "-f", "rtsp", "-rtsp_transport", "tcp", pub_url], 40)
    pblob = (pub.stdout or "") + (pub.stderr or "")
    if pub.returncode == 0:
        raise Fail("publish to an unregistered path SUCCEEDED")
    if "400" not in pblob:
        raise Fail("unregistered publish was rejected but not with 400: "
                   + redact(pblob.strip())[-200:])
    log("PASS A2: publish to unregistered path rejected with 400")

    # --- Layer A3: physical camera 796 still streams (frame HTTP 200) ---
    fst, fsize = http_status(f"{GO2RTC_API}/api/frame.jpeg?src=dai_cam_796", timeout=30)
    if fst != 200:
        raise Fail(f"camera 796 frame returned HTTP {fst}")
    if fsize < 1000:
        raise Fail(f"camera 796 frame returned only {fsize} bytes")
    log(f"PASS A3: camera 796 frame HTTP 200 ({fsize} bytes read)")

    # --- Layer B: recording restricted to registered paths ---
    st, _ = http_status(f"{MEDIAMTX_API}/v3/config/pathdefaults/get")
    if st != 200:
        raise Fail(f"pathDefaults API returned {st}")
    with urllib.request.urlopen(f"{MEDIAMTX_API}/v3/config/pathdefaults/get", timeout=15) as r:
        defaults = json.load(r)
    if defaults.get("record") is not False:
        raise Fail(f"pathDefaults.record is {defaults.get('record')!r}, expected false")
    st, _ = http_status(f"{MEDIAMTX_API}/v3/config/paths/get/cam")
    if st != 200:
        raise Unverifiable("registered path 'cam' not present in runtime config")
    with urllib.request.urlopen(f"{MEDIAMTX_API}/v3/config/paths/get/cam", timeout=15) as r:
        cam = json.load(r)
    if cam.get("record") is not True:
        raise Fail("registered path 'cam' is not recording")
    log("PASS B: record defaults off, registered path 'cam' records")


# ---------------------------------------------------------------------------
# Q2 — GitHub workflow supply-chain hygiene (local only, no token needed)
# ---------------------------------------------------------------------------
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def gate_q2() -> None:
    wf = REPO / ".github" / "workflows"
    if not wf.is_dir():
        raise Fail("no .github/workflows directory in the repo")
    files = sorted(list(wf.glob("*.yml")) + list(wf.glob("*.yaml")))
    if not files:
        raise Fail("no workflow files found")

    problems: list[str] = []
    for f in files:
        for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            s = line.strip()
            if s.startswith("uses:"):
                ref = s.split("uses:", 1)[1].split("#")[0].strip()
                if "@" not in ref:
                    problems.append(f"{f.name}:{i} uses without ref ({ref})")
                elif not SHA_RE.match(ref.rsplit("@", 1)[1]):
                    problems.append(f"{f.name}:{i} action not pinned to a 40-char SHA ({ref})")
            if re.search(r"\bnpx\b", s):
                problems.append(f"{f.name}:{i} invokes npx ({s[:60]})")
            if "pip install" in s and not re.search(r"==|--only-binary|--require-hashes", s):
                problems.append(f"{f.name}:{i} unpinned pip install ({s[:60]})")

    if problems:
        raise Fail(f"{len(problems)} workflow issue(s): " + "; ".join(problems[:8]))
    log(f"PASS Q2: {len(files)} workflows pinned to SHAs, no npx, no unpinned installs")


# ---------------------------------------------------------------------------
# Q1 — Sonar bug count must be zero
# ---------------------------------------------------------------------------
def _sonar_metric(metric: str) -> float:
    token = os.environ.get("SONAR_TOKEN") or os.environ.get("SONARQUBE_TOKEN")
    if not token:
        raise Unverifiable("SONAR_TOKEN not set — cannot query Sonar")
    key = os.environ.get("SONAR_PROJECT_KEY")
    if not key:
        raise Unverifiable("SONAR_PROJECT_KEY not set")
    host = os.environ.get("SONAR_HOST_URL", "https://sonarcloud.io").rstrip("/")
    url = f"{host}/api/measures/component?component={urllib.parse.quote(key)}&metricKeys={metric}&token={urllib.parse.quote(token)}"
    try:
        with urllib.request.urlopen(url, timeout=25) as r:
            data = json.load(r)
    except Exception as e:  # noqa: BLE001 - report, never crash the loop
        raise Unverifiable(f"Sonar API unreachable: {type(e).__name__}") from e
    for m in data.get("component", {}).get("measures", []):
        if m.get("metric") == metric:
            return float(m.get("value", 0))
    return 0.0


def gate_q1() -> None:
    bugs = _sonar_metric("bugs")
    if bugs > 0:
        raise Fail(f"{int(bugs)} Sonar BUG issue(s) remain")
    log("PASS Q1: Sonar bug count is 0")


# ---------------------------------------------------------------------------
# M1 — DB durability: restart policy, healthcheck, tracked deployment config
# ---------------------------------------------------------------------------
def gate_m1() -> None:
    code, out = sh(["docker", "inspect", "camdai-pg", "--format",
                    "{{.HostConfig.RestartPolicy.Name}}|{{if .Config.Healthcheck}}yes{{else}}no{{end}}"])
    if code != 0:
        raise Unverifiable("container camdai-pg not inspectable: " + out[:120])
    policy, hc = (out.split("|") + ["", ""])[:2]
    if policy not in ("unless-stopped", "always"):
        raise Fail(f"restart policy is '{policy or 'none'}', needs unless-stopped/always")
    if hc != "yes":
        raise Fail("no healthcheck defined on camdai-pg")

    tracked = run(["git", "-C", str(REPO), "ls-files"], 30).stdout.splitlines()
    compose = [p for p in tracked if re.search(r"(^|/)(docker-)?compose\.ya?ml$", p)]
    if not compose:
        raise Fail("no production compose file is git-tracked (only a test compose exists)")
    log(f"PASS M1: restart={policy}, healthcheck present, tracked compose={compose}")


# ---------------------------------------------------------------------------
# M2 — least privilege app role + separate migration URL
# ---------------------------------------------------------------------------
def gate_m2() -> None:
    code, out = sql("select rolname, rolsuper, rolbypassrls from pg_roles "
                    "where rolname not like 'pg\\_%' and rolname <> 'postgres'")
    if code != 0:
        raise Unverifiable("cannot read pg_roles: " + out[:120])
    rows = [r for r in out.splitlines() if r.strip()]
    if not rows:
        raise Fail("no application role found in pg_roles")
    offenders = []
    for r in rows:
        parts = r.split("|")
        if len(parts) < 3:
            continue
        name, sup, bypass = parts[0], parts[1], parts[2]
        if sup == "t" or bypass == "t":
            offenders.append(f"{name}(super={sup},bypassrls={bypass})")
    if offenders:
        raise Fail("privileged app role(s): " + ", ".join(offenders))

    envf = REPO / ".env"
    if not envf.exists():
        raise Unverifiable("repo .env not present — cannot check MIGRATION_DATABASE_URL")
    if not re.search(r"^MIGRATION_DATABASE_URL=", envf.read_text(encoding="utf-8", errors="replace"), re.M):
        raise Fail("MIGRATION_DATABASE_URL not defined (app and migrations share one URL)")
    log(f"PASS M2: {len(rows)} non-superuser role(s), migration URL separated")


# ---------------------------------------------------------------------------
# M3 — RLS enabled with policies on every tenant-scoped table
# ---------------------------------------------------------------------------
def gate_m3() -> None:
    code, out = sql(
        "select c.relname, c.relrowsecurity, "
        "(select count(*) from pg_policy p where p.polrelid=c.oid) "
        "from pg_class c join pg_namespace n on n.oid=c.relnamespace "
        "where n.nspname='public' and c.relkind='r' "
        "and exists (select 1 from information_schema.columns col "
        "            where col.table_name=c.relname and col.column_name='tenant_id')")
    if code != 0:
        raise Unverifiable("cannot read pg_class: " + out[:120])
    rows = [r for r in out.splitlines() if r.strip()]
    if not rows:
        raise Fail("no tenant-scoped tables found — cannot prove RLS")
    missing = []
    for r in rows:
        parts = r.split("|")
        if len(parts) < 3:
            continue
        name, rls, pol = parts[0], parts[1], parts[2]
        if rls != "t" or pol == "0":
            missing.append(f"{name}(rls={rls},policies={pol})")
    if missing:
        raise Fail("tenant tables without RLS/policy: " + ", ".join(missing[:8]))
    log(f"PASS M3: {len(rows)} tenant tables have RLS + policies")


# ---------------------------------------------------------------------------
# M5 — audit identity must come from the authenticated session
# ---------------------------------------------------------------------------
def _find_audit_identity_test() -> Path | None:
    """The only proof that counts: a test that logs in as B while holding A's
    cookie and asserts the audit row names B."""
    tests = REPO / "tests"
    if not tests.is_dir():
        return None
    for p in tests.glob("*.test.ts"):
        try:
            t = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        has_login = "auth.login" in t or "handleLogin" in t
        has_cookie = "cookie" in t.lower()
        has_actor = "actor" in t
        if has_login and has_cookie and has_actor:
            return p
    return None


def gate_m5() -> None:
    src = REPO / "src"
    if not src.is_dir():
        raise Unverifiable("src/ not present")

    # 1. audit() must be able to take an explicit identity. Pre-session events
    #    (auth.login, auth.login_failed) happen BEFORE Set-Cookie, so a session
    #    lookup can only return the PREVIOUS request's cookie -> wrong actor.
    audit_impl = src / "lib" / "audit.ts"
    if not audit_impl.exists():
        raise Fail("src/lib/audit.ts not found")
    impl = audit_impl.read_text(encoding="utf-8", errors="replace")
    # the override must exist as an OPTIONAL field of the parameter type
    # (inline object or a named type such as AuditMeta) — `actor?:` is the marker;
    # a plain `actor: s?.name` assignment in the insert must not satisfy this.
    if not re.search(r"\bactor\?\s*:", impl) or not re.search(r"\bactorRole\?\s*:", impl):
        raise Fail("audit() has no optional actor/actorRole override in its parameter "
                   "type — login events can only use the stale cookie session")
    if not re.search(r"\bmeta\.actor\b", impl):
        raise Fail("audit() declares an actor field but never prefers it over the session")

    # 2. the login handler must pass the authenticated identity explicitly
    login_route = src / "app" / "api" / "auth" / "login" / "route.ts"
    if not login_route.exists():
        raise Fail("login route not found")
    route = login_route.read_text(encoding="utf-8", errors="replace")
    if not re.search(r'audit\(\s*["\']auth\.login["\'][\s\S]{0,400}?actor\s*:', route):
        raise Fail("login handler still audits without an explicit actor — "
                   "auth.login rows keep the previous session's identity")

    # 3. behavioural proof: the dedicated test must exist and pass.
    #    h01g asserts the OLD (buggy) semantics, so it can never satisfy this.
    test_file = REPO / "tests" / "h01h-audit-login-identity.test.ts"
    if not test_file.exists():
        raise Fail("tests/h01h-audit-login-identity.test.ts missing — no proof that "
                   "logging in as B while holding A's cookie records B")
    body = test_file.read_text(encoding="utf-8", errors="replace")
    for needle in ("auth.login", "cookie", "actor"):
        if needle not in body:
            raise Fail(f"h01h does not exercise '{needle}' — not the required proof")

    code, out = sh([sys.executable, "-c",
                    "import json;s=json.load(open('package.json',encoding='utf-8'))['scripts'];"
                    "print(json.dumps(s))"], timeout=30)
    if code != 0:
        raise Fail("cannot read package.json scripts: " + out[-120:])
    scripts = json.loads(out)
    script = "test:h01h"
    if script not in scripts or "h01h" not in str(scripts[script]):
        raise Fail(f"package.json has no '{script}' script wiring the new test")
    code, out = sh(["npm", "run", script, "--silent"], timeout=420)
    if code != 0:
        raise Fail(f"npm run {script} failed: " + out[-300:])

    # 4. no regression on the tenant audit suite — it MUST be wired and green.
    #    A suite that is not in package.json never runs in CI and rots silently,
    #    so a missing script is a failure, never a silent skip.
    if "test:h01g" not in scripts:
        raise Fail("h01g tenant-audit suite is not wired into package.json scripts "
                   "— it cannot rot silently")
    code, out = sh(["npm", "run", "test:h01g", "--silent"], timeout=420)
    if code != 0:
        raise Fail("h01g tenant-audit suite failed: " + out[-400:])

    log(f"PASS M5: audit() takes explicit actor, login passes it, "
        f"h01h proves B-while-holding-A, h01g still green")


# ---------------------------------------------------------------------------
# M6 — per-tenant recording quota configured AND currently enforced
# ---------------------------------------------------------------------------
def gate_m6() -> None:
    envf = REPO / ".env"
    if not envf.exists():
        raise Unverifiable("repo .env not present — cannot read the quota value")
    txt = envf.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^RECORDING_QUOTA_GB=([0-9.]+)", txt, re.M)
    if not m:
        raise Fail("RECORDING_QUOTA_GB not declared — no per-tenant quota exists")
    cap_gb = float(m.group(1))

    rec = Path(r"F:/Camera-D-AI/runtime/recordings")
    if not rec.exists():
        raise Unverifiable("recordings directory absent — cannot measure usage")
    total = 0
    for p in rec.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            continue
    gb = total / (1024 ** 3)
    if gb > cap_gb:
        raise Fail(f"recordings {gb:.2f} GB exceed quota {cap_gb} GB — not enforced")

    # Declaring a quota above today's usage proves nothing: the prune mechanism
    # itself must be exercised by a test that runs.
    impl = REPO / "src" / "lib" / "recordings" / "index.ts"
    if not impl.exists():
        raise Fail("src/lib/recordings/index.ts missing — no quota enforcement")
    src = impl.read_text(encoding="utf-8", errors="replace")
    if "enforceRecordingQuota" not in src:
        raise Fail("enforceRecordingQuota() is not implemented — quota is only a number")
    if "selectOldestToDelete" not in src:
        raise Fail("selectOldestToDelete() missing — prune order is unverifiable")

    code, out = sh([sys.executable, "-c",
                    "import json;s=json.load(open('package.json',encoding='utf-8'))['scripts'];"
                    "print(json.dumps(s))"], timeout=30)
    if code != 0:
        raise Fail("cannot read package.json scripts: " + out[-120:])
    scripts = json.loads(out)
    if "test:m6" not in scripts or "m6" not in str(scripts["test:m6"]):
        raise Fail("no 'test:m6' script — the prune logic is not proven by a test")
    code, out = sh(["npm", "run", "test:m6", "--silent"], timeout=420)
    if code != 0:
        raise Fail("npm run test:m6 failed: " + out[-400:])
    log(f"PASS M6: quota {cap_gb} GB, usage {gb:.2f} GB, enforcement proven by test:m6")


# ---------------------------------------------------------------------------
# M7 — MJPEG consumer limit bounded in MediaMTX AND in the app
# ---------------------------------------------------------------------------
def gate_m7() -> None:
    problems = []
    runtime_yml = Path(r"F:/Camera-D-AI/runtime/mediamtx/mediamtx.yml")
    tracked_yml = REPO / "infra" / "mediamtx" / "mediamtx.yml"
    for label, yml in (("runtime", runtime_yml), ("tracked", tracked_yml)):
        if not yml.exists():
            problems.append(f"{label} mediamtx.yml missing")
            continue
        t = yml.read_text(encoding="utf-8", errors="replace")
        # YAML nests the key under a path, so it is indented.
        mm = re.search(r"^\s*maxReaders:\s*(\d+)\s*$", t, re.M)
        if not mm:
            problems.append(f"{label}: maxReaders not declared")
        elif int(mm.group(1)) == 0:
            problems.append(f"{label}: maxReaders=0 (unlimited)")

    src = REPO / "src"
    app_hit = None
    if src.is_dir():
        for p in src.rglob("*.ts"):
            if "node_modules" in p.parts:
                continue
            try:
                t = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if re.search(r"maxConcurrent|MAX_CONSUMERS|consumerLimit", t):
                app_hit = str(p.relative_to(REPO))
                break
    if not app_hit:
        problems.append("no app-side consumer cap in src/")

    if problems:
        raise Fail("; ".join(problems))

    # A grep for a constant proves nothing: the cap must be exercised by a test.
    limiter = REPO / "src" / "lib" / "stream-limiter.ts"
    if not limiter.exists():
        raise Fail("src/lib/stream-limiter.ts missing — no reusable limiter")
    code, out = sh([sys.executable, "-c",
                    "import json;s=json.load(open('package.json',encoding='utf-8'))['scripts'];"
                    "print(json.dumps(s))"], timeout=30)
    if code != 0:
        raise Fail("cannot read package.json scripts: " + out[-120:])
    scripts = json.loads(out)
    if "test:m7" not in scripts or "m7" not in str(scripts["test:m7"]):
        raise Fail("no 'test:m7' script — the consumer cap is unproven")
    code, out = sh(["npm", "run", "test:m7", "--silent"], timeout=420)
    if code != 0:
        raise Fail("npm run test:m7 failed: " + out[-400:])

    # The live server must still be enforcing the M0 lockdown after the reload.
    code, out = sh([sys.executable, "-c",
                    "import urllib.request;"
                    "print(urllib.request.urlopen("
                    "'http://127.0.0.1:1984/api/frame.jpeg?src=dai_cam_796',timeout=12).status)"],
                   timeout=40)
    if out.strip() != "200":
        raise Fail(f"camera 796 frame endpoint returned {out.strip()!r} after the cap change")

    log(f"PASS M7: maxReaders bounded, app cap in {app_hit}, proven by test:m7, "
        f"camera 796 still streaming")


# ---------------------------------------------------------------------------
# M8 — backup exists and a restore has been verified
# ---------------------------------------------------------------------------
def gate_m8() -> None:
    candidates = [Path(r"F:/Camera-D-AI/runtime/backups"), REPO / "backups"]
    dump = None
    for d in candidates:
        if not d.exists():
            continue
        found = sorted([p for p in d.rglob("*.sql")] + [p for p in d.rglob("*.dump")],
                       key=lambda p: p.stat().st_mtime, reverse=True)
        if found:
            dump = found[0]
            break
    if dump is None:
        raise Fail("no database backup file found")

    head = dump.read_bytes()[:64]
    if not head.startswith(b"PGDMP") and b"--" not in head:
        raise Fail(f"backup {dump.name} does not look like a pg dump")

    marker = Path(r"F:/Camera-D-AI/runtime/backups/restore_verified.json")
    if not marker.exists():
        raise Fail("restore never verified (runtime/backups/restore_verified.json missing)")
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise Fail("restore_verified.json is corrupt") from e
    if not data.get("ok"):
        raise Fail("last restore verification reported failure")
    log(f"PASS M8: backup {dump.name} present, restore verified at {data.get('at', '?')}")


# ---------------------------------------------------------------------------
# M9 — 72h soak evidence with zero restarts
# ---------------------------------------------------------------------------
def gate_m9() -> None:
    soak = Path(r"F:/Camera-D-AI/runtime/soak.json")
    if not soak.exists():
        raise Fail("no soak evidence (runtime/soak.json missing) — 72h not observed")
    try:
        d = json.loads(soak.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise Fail("soak.json is corrupt") from e
    hours = float(d.get("hours", 0))
    restarts = int(d.get("restarts", 999))
    err = float(d.get("error_rate_pct", 100))
    limit = float(d.get("max_error_rate_pct", 1.0))
    if hours < 72:
        raise Fail(f"soak only {hours}h of the required 72h")
    if restarts > 0:
        raise Fail(f"{restarts} restart(s) during the soak window")
    if err > limit:
        raise Fail(f"error rate {err}% above the {limit}% threshold")
    log(f"PASS M9: soak {hours}h, restarts=0, error_rate={err}%")


# ---------------------------------------------------------------------------
# M10 — refactor + Sonar new-code gate
# ---------------------------------------------------------------------------
def gate_m10() -> None:
    newv = _sonar_metric("new_violations")
    if newv > 0:
        raise Fail(f"{int(newv)} new-code violation(s) remain")
    log("PASS M10: new-code gate clean")


# ---------------------------------------------------------------------------
# P-series — per-camera configurability (owner spec 2026-11-05)
# ---------------------------------------------------------------------------
def _scripts() -> dict:
    code, out = sh([sys.executable, "-c",
                    "import json;s=json.load(open('package.json',encoding='utf-8'))['scripts'];"
                    "print(json.dumps(s))"], timeout=30)
    if code != 0:
        raise Fail("cannot read package.json scripts: " + out[-120:])
    return json.loads(out)


def _run_proof(script: str, test_name: str, needles: tuple[str, ...] = ()) -> None:
    """A milestone is only proven by a named test that runs and passes."""
    f = REPO / "tests" / test_name
    if not f.exists():
        raise Fail(f"{test_name} missing — no behavioural proof")
    body = f.read_text(encoding="utf-8", errors="replace")
    for n in needles:
        if n not in body:
            raise Fail(f"{test_name} does not exercise '{n}' — wrong proof")
    scripts = _scripts()
    if script not in scripts or test_name.split(".")[0] not in str(scripts[script]):
        raise Fail(f"package.json has no '{script}' wiring {test_name}")
    code, out = sh(["npm", "run", script, "--silent"], timeout=420)
    if code != 0:
        raise Fail(f"npm run {script} failed: " + out[-400:])


def gate_p1() -> None:
    reg = REPO / "src" / "lib" / "camera" / "features.ts"
    if not reg.exists():
        raise Fail("src/lib/camera/features.ts missing — no per-camera feature registry")
    src = reg.read_text(encoding="utf-8", errors="replace")
    for sym in ("CAMERA_FEATURES", "normalizeFeatures"):
        if sym not in src:
            raise Fail(f"registry does not export {sym}")

    drawer = REPO / "src" / "components" / "CameraSettingsDrawer.tsx"
    if not drawer.exists():
        raise Unverifiable("CameraSettingsDrawer.tsx missing")
    d = drawer.read_text(encoding="utf-8", errors="replace")
    if "@/lib/camera/features" not in d:
        raise Fail("the settings drawer does not use the feature registry — "
                   "sections cannot be driven per camera")

    # the settings row must carry the per-camera map, not a shared default
    schema = (REPO / "src" / "db" / "schema.ts").read_text(encoding="utf-8", errors="replace")
    if "cameraSettings" not in schema or "features" not in schema:
        raise Fail("camera_settings.features is missing — flags are not per camera")

    _run_proof("test:p1", "p1-per-camera-features.test.ts", ("features", "asset", "camera"))
    log("PASS P1: per-camera feature registry drives the drawer, proven by test:p1")


def gate_p2() -> None:
    schema = (REPO / "src" / "db" / "schema.ts").read_text(encoding="utf-8", errors="replace")
    # this codebase writes table names on the following line, so allow whitespace
    if not re.search(r"pgTable\(\s*\"(product|camera_products)", schema):
        raise Fail("no products / camera_products table — products cannot be linked per camera")
    _run_proof("test:p2", "p2-camera-products.test.ts", ("product", "camera"))
    log("PASS P2: products linked per camera, proven by test:p2")


def gate_p3() -> None:
    app = REPO / "src" / "app"
    wall = [p for p in app.rglob("*") if p.is_dir() and p.name in ("wall", "camera-wall")]
    if not wall:
        raise Fail("no camera wall route (src/app/**/wall)")
    _run_proof("test:p3", "p3-camera-wall.test.ts", ("wall", "layout"))
    log("PASS P3: camera wall renders a persisted grid, proven by test:p3")


# ---------------------------------------------------------------------------
GATES = {
    "M0": gate_m0,
    "M1": gate_m1,
    "M2": gate_m2,
    "M3": gate_m3,
    "M5": gate_m5,
    "M6": gate_m6,
    "M7": gate_m7,
    "M8": gate_m8,
    "M9": gate_m9,
    "M10": gate_m10,
    "Q1": gate_q1,
    "Q2": gate_q2,
    "P1": gate_p1,
    "P2": gate_p2,
    "P3": gate_p3,
}


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__, file=sys.stderr)
        return 3
    mid = argv[0]
    fn = GATES.get(mid)
    if fn is None:
        log(f"UNVERIFIABLE {mid}: no gate implemented in gates.py")
        return 3
    try:
        fn()
    except Unverifiable as e:
        log(f"UNVERIFIABLE {mid}: {e}")
        return 3
    except Fail as e:
        log(f"FAIL {mid}: {e}")
        return 1
    log(f"GATE PASS {mid}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
