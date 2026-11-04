# Camera D-AI — Thống kê hiện trạng + Hostile Review vòng 3 (GPT) + Phản biện (Hermes)

- Ngày: 2026-11-04
- Baseline: `main @ 6674da3` (PR #61 `e0bdc9e` + PR #62 `6674da3`)
- Phương pháp: **mọi số liệu trong §1–§2 đều từ lệnh chạy thật** trên máy local. §3 là phán quyết của GPT (đọc mã nguồn public repo + docs MediaMTX/PostgreSQL). §4 là phản biện của Hermes, mỗi claim đều kèm lệnh xác thực.

> Quy ước phân loại (theo yêu cầu nghiệm thu):
> - **[ĐÃ ĐO]** — chạy lệnh thật, có output.
> - **[GPT]** — kết luận của GPT, **chưa** được Hermes xác minh.
> - **[HÀNH ĐỘNG]** — việc cần làm.

---

## 1. Thống kê hiện trạng (đã đo)

### 1.1 Quy mô mã nguồn

| Chỉ số | Giá trị | Lệnh đo |
|---|---|---|
| File trong `src/` | 153 | `os.walk('src')` |
| LOC `src/` | 17,251 (`.ts` 10,570 + `.tsx` 6,681) | đếm dòng |
| File test | 51 | `os.walk('tests')` |
| LOC test | 8,802 | đếm dòng |
| Tỷ lệ test/code | 0.51 | 8.802 / 17.251 |
| Script `test:*` | 34 | `package.json` |
| Dependency runtime / dev | 11 / 11 | `package.json` |

### 1.2 Kích thước file (technical debt)

| Ngưỡng | Số file |
|---|---|
| > 300 LOC | 21 |
| > 500 LOC | 3 (`CameraSettingsDrawer.tsx`=906, `ExtractClient.tsx`=655, `CameraView.tsx`=534) |
| File test lớn nhất | 461 / 431 / 423 / 362 / 355 LOC |

`duplicated_lines_density` (Sonar) = **0.4%** ⇒ duplication **không** phải vấn đề.

### 1.3 SonarCloud (TRK, `xegheplimo-web_Camera_D_AI`)

```
GET https://sonarcloud.io/api/measures/component?component=xegheplimo-web_Camera_D_AI&metricKeys=security_rating,violations,ncloc,duplicated_lines_density
→ security_rating=3.0 (C) | violations=437 | ncloc=23645 | duplicated_lines_density=0.4
```

| Loại | Số lượng | | Mức độ | Số lượng |
|---|---|---|---|---|
| CODE_SMELL | 409 | | CRITICAL | 47 |
| VULNERABILITY | 16 | | MAJOR | 220 |
| BUG | 12 | | MINOR | 170 |
| | | | BLOCKER | 0 |

**16 VULNERABILITY nằm 100% trong `.github/workflows/`** (`ci.yml:137,142,145`, `e2e.yml:45,47,51`) — npx không pin version, không dùng full SHA, thiếu `--only-binary :all`. **Không có VULNERABILITY nào trong app code.**

**12 BUG (đã đọc code xác nhận):**

| File:line | Loại | Xác minh |
|---|---|---|
| `ExtractClient.tsx:464,465` | promise không await | đọc code |
| `AppState.tsx:36` | promise không await | đọc code |
| `CameraView.tsx:305` | promise không await | đọc code — có `.catch()` ngay sau |
| `Shell.tsx:85` | promise không await | đọc code |
| `MemoryClient.tsx:116` | regex không nhóm | đọc code — `/^tìm|bao nhiêu|.../i` parse thành `^tìm` **hoặc** `bao nhiêu` |
| `lib/qa.ts:176` | regex không nhóm | đọc code |
| `MemoryClient.tsx:154` | button thiếu `type` | đọc code |
| `ChatPanel.tsx:338`, `ui.tsx:100,101` | click handler thiếu keyboard | đọc code |
| `lib/seed.ts:132` | conditional vô nghĩa | đọc code — `i === 0 ? "demo" : "demo"` |

### 1.4 Database (`camdai-pg`, db `app_db`)

```
docker exec camdai-pg psql -U postgres -d app_db
```

| Bảng | Số dòng |
|---|---|
| cameras | 6 |
| events | 443 |
| assets | 463 |
| audit_log | 3,573 |
| sessions | 94 |
| knowledge_items | 6 |

**RLS: vắng mặt hoàn toàn.**
```
select schemaname,tablename,rowsecurity from pg_tables where schemaname='public'
→ rowsecurity = f cho TẤT CẢ 20+ bảng
select * from pg_policies where schemaname='public' → 0 rows
select current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user
→ postgres | t | t   (SUPERUSER + BYPASSRLS)
```
⇒ App chạy bằng superuser ⇒ kể cả có policy cũng không áp dụng. RLS hiện là **theatre**.

**Audit attribution (3.573 dòng):**

| action | total | có tenant_id | có actor |
|---|---|---|---|
| auth.login | 1.269 | **0** | 3 |
| ai.route | 854 | **0** | 0 |
| data.retention | 379 | **0** | 379 |
| recording.play_failed | 372 | **0** | 372 |
| camera.discover | 261 | 44 | 260 |
| scope.denied | 92 | 77 | 92 |
| auth.logout | 57 | **0** | 0 |
| ai.job.queued | 24 | 2 | 24 |
| settings.update | 18 | 12 | 18 |

⇒ **~2.600 dòng (73%) không có tenant attribution.** Kiểm tra mẫu 8 dòng `auth.login` mới nhất: `actor` NULL và `tenant_id` NULL **100%**.

### 1.5 MediaMTX — recording gateway (runtime, `F:/Camera-D-AI/runtime/mediamtx/mediamtx.yml`)

```
GET http://127.0.0.1:9997/v3/config/global/get
→ rtspAddress=:8554 | rtmpAddress=:1935 | hlsAddress=:8888 | authMethod=internal | apiAddress=127.0.0.1:9997
```

**User nội bộ (từ API, nguyên văn):**
```json
[{ "user":"any", "pass":"",
   "ips":["127.0.0.0/8","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],
   "permissions":[{"action":"publish","path":""},{"action":"read","path":""},
                  {"action":"playback","path":""},{"action":"api","path":""}] }]
```

**Path config hiệu lực:** `GET /v3/config/paths/list` → `path=cam, record=True, recordDeleteAfter=7d, maxReaders=0`.
**Config gốc:** `pathDefaults.record: yes`, `recordDeleteAfter: 168h`, `recordSegmentDuration: 5m`. `paths:` chỉ có `cam: {}` — **không có `all_others`**.

**Dung lượng:** `du -sh runtime/recordings` → **24 GB**, 315 file. Theo path: `dai_cam_441`=17 GB, `cam`=6.1 GB, `ezviz`=71 MB. Tăng trưởng 24h: **147 file, 11.53 GB**. Disk: 933 GB total, 765 GB free (19% used).

**Retention:** `find runtime/recordings -type f -mmin +10080 | wc -l` → **0** (không file nào >168h). File cũ nhất trên đĩa: **34.3 giờ**.

### 1.6 go2rtc (bridge camera → app)

`runtime/go2rtc/go2rtc.yaml`: `api.listen: 127.0.0.1:1984`, `rtsp.listen: 127.0.0.1:8554`. `netstat` xác nhận `:1984 LISTENING` trên `127.0.0.1`. ⇒ **loopback-only, đúng cách.**

### 1.7 Độ bền container

```
docker inspect camdai-pg → RestartPolicy.Name=no | OOMKilled=false | ExitCode=0 | RestartCount=0
docker logs --since 24h → 3 lần "database system was not properly shut down; automatic recovery in progress"
   (07:49, 09:43, 12:46 UTC)
docker inspect camdai-pg → labels com.docker.compose.* RỖNG
```
⇒ Container **không** thuộc compose project nào, được tạo thủ công bằng `docker run`. `docker-compose.test.yml` là file compose **duy nhất được git track** và file đó ghi rõ *"KHÔNG dùng trong production"* — nó **không** phải nơi sửa restart policy của `camdai-pg`.

### 1.8 Dependency & secret

- `npm audit --omit=dev --audit-level=high` → **found 0 vulnerabilities**
- `git ls-files | grep '^\.env'` → chỉ `.env.example`, `.env.local.example`. File `.env`/`.env.local` thật **không** được commit.
- Không tìm thấy credential hardcode trong `src/`.

### 1.9 Test & gate

- `34` script `test:*` → **34/34 PASS** trên `main` (run đầy đủ env, `SKIP_BUILD=1`).
- `npm run typecheck` → 0 error. `npm run lint` → 0 error / 33 warning.
- CI: 34 script `test:*`, CI tham chiếu 33 (thiếu duy nhất `test:seed`); `test:cam-ui-001` **có** chạy trong CI qua `./node_modules/.bin/tsx tests/cam-ui-fullscreen.smoke.ts`.
- CI PR #61 và #62: **xanh toàn bộ**, đã merge.

---

## 2. Phân tích của GPT (vòng 3, hostile review)

GPT nhận đủ 8.767 ký tự brief có số liệu đo được, yêu cầu phán quyết từng claim và **tự phản biện ranking của chính nó**.

### 2.1 Phán quyết từng claim

| Claim | Verdict | Lý do quyết định (theo GPT) |
|---|---|---|
| C1 — MediaMTX auth | **MODIFY** | Lộ quyền read/publish/playback cho LAN là P0, nhưng 11,53 GB/ngày là **tổng** ghi, không phải mỗi path; chưa chứng minh được publish vào path chưa đăng ký. |
| C2 — Superuser + RLS | **KEEP** | 0 policy + runtime superuser ⇒ RLS không bảo vệ được. Phải tách runtime credential khỏi migration credential trước khi triển khai RLS. |
| C3 — Sonar không ưu tiên | **MODIFY** | Không sửa 409 code smell hàng loạt, nhưng không được bỏ qua complexity ở code security-critical chỉ vì duplication thấp. Không chấp nhận "IGNORE toàn bộ 409 vĩnh viễn". |
| C4 — Audit attribution | **MODIFY** | Thiếu attribution là lỗi thật, nhưng **có lỗi nghiêm trọng hơn: audit có thể ghi sai danh tính** (cookie A đăng nhập B → ghi log dưới danh tính A). |
| C5 — PostgreSQL durability | **MODIFY** | 3 lần unclean shutdown + `restart=no` chứng minh vấn đề phục hồi, nhưng chưa chứng minh corruption/mất dữ liệu. Thêm `restart: unless-stopped` không giải quyết được Docker Desktop không chạy. |

### 2.2 Ba việc GPT xếp đầu

| # | Việc | Mức độ / chi phí | Nghiệm thu |
|---|---|---|---|
| **FIRST** | Khóa quyền MediaMTX (auth, publish/read/playback/API, `pathDefaults.record`) | P0 trực tiếp; ~1–3 h nếu không có dependency ẩn | LAN không credential không đọc/publish được; camera 796 vẫn hoạt động |
| **SECOND** | Khả năng tự phục hồi PostgreSQL trong **cấu hình Docker triển khai thật** + điều tra nguyên nhân shutdown | P0 availability; ~1–3 h | DB tự phục hồi ≤60s sau lỗi container trong môi trường test |
| **THIRD** | Tách `app_rw`/migrator, triển khai RLS + negative test tenant | P0 data isolation; 1–3 ngày (ước lượng, chưa đo) | `NOSUPERUSER, NOBYPASSRLS`; 0 cross-tenant success |

Sau 3 mục đó GPT xếp: audit identity contamination → backup/restore → recording quota → giới hạn consumer → soak 72h → 12 BUG + 16 workflow VULNERABILITY → refactor có chọn lọc.

### 2.3 GPT chỉ ra 2 lỗi lập luận của Hermes (chấp nhận)

> "0 file già hơn 168h khi file cũ nhất mới 34,3 giờ không chứng minh retention hoạt động."
> "11,53 GB ghi trong 24h trên toàn bộ recording không phải 11,53 GB/ngày cho mỗi path."

### 2.4 Failure mode GPT nêu (bằng chứng em chưa phủ)

| Khoảng trống | Vì sao nguy hiểm |
|---|---|
| **Deployment drift** | `runtime/mediamtx/mediamtx.yml` **không** được git track (chỉ `fixtures/mediamtx.yml` mới được track). PR xanh nhưng quyền live không đổi. |
| **Anonymous read thực tế** | Config cho phép, nhưng chưa thử từ máy LAN không credential. |
| **Path ngoài cấu hình** | `permissions.path=""` không chứng minh MediaMTX chấp nhận mọi path chưa đăng ký. |
| **Retention thật** | File cũ nhất 34,3h vs ngưỡng 168h ⇒ chưa chứng minh bộ dọn đã chạy. |
| **PostgreSQL bị dừng bởi host** | Restart policy không xử lý được mất Docker Desktop / mất nguồn máy / lỗi volume. |
| **RLS không bảo vệ dữ liệu phi SQL** | File video, redirect URL, stream, filesystem không nằm trong RLS. |
| **Audit identity contamination** | Cookie A đăng nhập B ⇒ sự kiện gắn sai tenant, tệ hơn NULL. |

### 2.5 Phản biện tự thân của GPT

> Điểm yếu nhất: tôi xếp MediaMTX lên đầu dựa trên **quyền truy cập được cấu hình**, chưa có bằng chứng HTTP/RTSP unauthenticated access thành công từ một thiết bị LAN độc lập. Trong khi đó superuser + RLS=0 đã được chứng minh trực tiếp.
> **Có thay đổi verdict không? Chưa** — vì MediaMTX có đường truy cập mạng trực tiếp, remediation nhỏ, đo độc lập với database. Điều kiện: nếu anonymous read thành công → giữ FIRST, xác nhận P0.

---

## 3. Phản biện của Hermes (đã xác thực bằng lệnh thật)

Em chạy **phép thử mà GPT đề xuất** trước khi chấp nhận bất kỳ phán quyết nào.

### 3.1 Xác thực claim C1 — GPT đúng một nửa, em đúng một nửa

| Phép thử | Kết quả | Kết luận |
|---|---|---|
| `ffprobe rtsp://192.168.1.243:8554/cam` (không credential, từ LAN) | **`h264,1280,720`** exit 0 | ✅ **Anonymous READ path `cam` thành công** ⇒ C1 là **P0 thật**, xác nhận điều kiện GPT đặt ra |
| `ffprobe rtsp://192.168.1.243:8554/anon_probe_test` (path chưa đăng ký) | **`400 Bad Request`** | ❌ GPT **đúng**: không có `all_others` ⇒ publish vào path lạ **bị chặn**. Em đã nói quá khi viết "publish vào mọi path" |
| `curl http://192.168.1.243:9997/v3/paths/list` (từ LAN) | **`http=000`** (bị chặn) | ✅ API chỉ loopback (`apiAddress: 127.0.0.1:9997`) ⇒ mối đe dọa API không có hiệu lực |

**Kết luận đã hiệu chỉnh C1:** rủi ro thật là **đọc trộm luồng camera** (anonymous read path đã cấu hình), **không** phải inject stream và **không** phải truy cập API. Mức độ vẫn P0 vì: (i) đọc trộm không cần vượt auth Next.js; (ii) remediation nhỏ; (iii) đo độc lập với DB.

**Lỗi của em (đã nhận):** em viết "11,53 GB/ngày **cho mỗi path**" — thực tế 11,53 GB là **tổng** của 147 file/24h trên toàn bộ path (`dai_cam_441` 17 GB chiếm phần lớn). Và em suy luận "retention đang chạy" từ "0 file >168h" khi file cũ nhất mới 34,3h — **không thể kết luận** (chưa file nào tới ngưỡng 168h để bị xóa).

### 3.2 Xác thực claim C2 — GPT đúng, em đúng, có bổ sung

| Phép thử | Kết quả |
|---|---|
| `select ... from pg_roles where rolname='app_rw'` | **role không tồn tại** (0 rows) ⇒ app_rw chưa được tạo |
| `drizzle.config.ts` | `dbCredentials: { url: process.env.DATABASE_URL }` — **cùng** biến với `src/db/index.ts` |
| `src/db/index.ts` | `new Pool({ connectionString: databaseUrl })` — không có credential tách riêng |

⇒ GPT đúng: đổi `DATABASE_URL` trực tiếp có thể làm gãy `drizzle-kit push`. Bắt buộc có `MIGRATION_DATABASE_URL` riêng. Đây là chi tiết quan trọng em đã bỏ sót.

### 3.3 Xác thực claim C4 — GPT phát hiện lỗi NGHIÊM TRỌNG HƠN em nghĩ

Em đọc code và xác nhận cơ chế:

```
src/lib/audit.ts:9      const s = await currentSession();        // ← lấy cookie HIỆN TẠI
src/lib/audit.ts:10     const tenantId = ... s ? await tenantIdOf(s) : null;
src/lib/audit.ts:13     actor: s?.name ?? null,

src/app/api/auth/login/route.ts:71   const token = await deps.issueSession(user, meta);
src/app/api/auth/login/route.ts:72   await deps.audit("auth.login", {...});   // ← audit TRƯỚC
src/app/api/auth/login/route.ts:74   res.headers.append("Set-Cookie", sessionCookie(token));  // ← cookie mới
```
⇒ `audit("auth.login")` đọc `currentSession()` **trước** khi `Set-Cookie` phiên mới ⇒ nếu browser đang giữ cookie tenant A mà đăng nhập tài khoản tenant B, audit ghi `actor`/`tenant` của **A** cho sự kiện của **B**. Đây là **sai attribution**, tệ hơn NULL vì nó đẩy sự kiện sang sai tenant.

Bằng chứng DB khớp: 8 dòng `auth.login` mới nhất đều `actor` NULL / `tenant_id` NULL (đăng nhập không cookie cũ) — 1.269 dòng `auth.login` chỉ có **3** dòng có actor ⇒ đúng dấu hiệu cookie-cũ-được-dùng-khi-có.

Em cũng xác nhận GPT **đúng khi nói chưa có bằng chứng admin API đọc xuyên tenant**: `/api/admin/route.ts:35-36` lọc bằng `auditLog.tenantId` — nên vấn đề là attribution sai/thiếu, chưa phải đọc xuyên tenant.

### 3.4 Xác thực claim C5 — GPT đúng, em thiếu một điều quan trọng

Em xác nhận `Restart=no | OOMKilled=false | ExitCode=0 | RestartCount=0` và 3 lần unclean shutdown.

**Bổ sung em tự phát hiện:** `docker inspect camdai-pg` cho `com.docker.compose.*` labels **RỖNG** ⇒ container được tạo bằng `docker run` thủ công, không thuộc compose nào. `docker-compose.test.yml` là file compose **duy nhất** được git track và ghi rõ *"KHÔNG dùng trong production"*. ⇒ Sửa `docker-compose.test.yml` rồi tuyên bố "đã bảo vệ production" là **sai** — đúng như GPT cảnh báo. Cần tạo một deployment config thật, được git track.

### 3.5 Xác thực claim C3 — em đúng một nửa

Em đọc code xác nhận 12 BUG có thật và đủ nhỏ để sửa. Nhưng em **đồng ý với GPT** ở điểm "không được IGNORE vĩnh viễn 409 code smell" — em đã diễn đạt quá tuyệt đối. Đề xuất sửa: chỉ xử lý code smell **liên quan security/media** và **code vừa thay đổi** (theo region), giữ nguyên phần còn lại.

### 3.6 Phán quyết cuối của Hermes sau khi xác thực

| Claim | Verdict cuối | Thay đổi so với brief |
|---|---|---|
| C1 | **KEEP (đã hiệu chỉnh)** | Rủi ro thật = **anonymous READ**, không phải publish/inject. Giữ FIRST. |
| C2 | **KEEP + bổ sung** | Thêm điều kiện bắt buộc: `MIGRATION_DATABASE_URL` tách riêng (GPT bổ sung, em thiếu). |
| C3 | **MODIFY (theo GPT)** | Không IGNORE vĩnh viễn; sửa 12 BUG + 16 workflow VULNERABILITY, code smell chỉ theo vùng liên quan. |
| C4 | **MODIFY (theo GPT)** | Xác thực được: audit lấy identity từ cookie cũ ⇒ **sai attribution**, ưu tiên cao hơn "NULL" mà em đề xuất. |
| C5 | **MODIFY (theo GPT)** | Thêm: phải sửa **deployment config thật** (container không thuộc compose nào), không sửa `docker-compose.test.yml` rồi tuyên bố an toàn. |

**Kết luận:** GPT đúng về **thứ tự** (MediaMTX → DB durability → DB isolation) và đã bắt được 2 suy luận vượt bằng chứng của em. Em giữ FIRST là MediaMTX vì điều kiện GPT đặt ra (anonymous read thành công) **đã được chứng minh bằng ffprobe thật**.

---

## 4. Hướng ưu tiên cuối cùng (M0 → M10), có gate định lượng

| # | Hạng mục | Vì sao ở vị trí này | Gate nghiệm thu (lệnh định lượng) |
|---|---|---|---|
| **M0** | **Khóa MediaMTX**: bỏ user `any`/pass rỗng, tách credential publish/read/playback/api, chỉ bật `record` cho path hợp lệ, đưa config về git track | Đã chứng minh anonymous read thành công; không cần vượt auth Next.js; remediation nhỏ | `ffprobe rtsp://192.168.1.243:8554/cam` **không credential** phải **thất bại**; `ffprobe .../anon_probe_test` vẫn 400; camera 796 vẫn stream (frame 200) |
| **M1** | **DB durability**: tạo deployment config thật được git track với `restart: unless-stopped` + `healthcheck pg_isready`; tìm nguyên nhân 3 lần kill | 3 lần unclean/24h ⇒ availability risk; là **prerequisite** để M2/M3 verify đáng tin | `docker kill --signal=KILL` trên container **test** → DB sống lại **≤60s**; `RestartCount ≥ 1` |
| **M2** | **app_rw least-privilege + `MIGRATION_DATABASE_URL`** | Prerequisite tuyệt đối của M3 (RLS vô hiệu với superuser); phải tách trước vì `drizzle.config.ts` dùng chung `DATABASE_URL` | `rolsuper=f, rolbypassrls=f` cho app role; `drizzle-kit push` vẫn chạy được bằng credential riêng |
| **M3** | **RLS + `SET LOCAL app.tenant_id`** + negative test | Sau M2 mới có hiệu lực; đây là hàng rào tenant thật | tenant A không đọc/ghi được dữ liệu B; thiếu context ⇒ 0 dòng trả về; 0 cross-tenant success |
| **M4** | ✅ **Camera vật lý EZVIZ (796)** | — | **DONE** — đã verify end-to-end |
| **M5** | **Audit identity contamination** (đã lên đầu sau M3) | Rẻ hơn M3, nhưng làm attribution sai ⇒ hỏng forensics | `audit("auth.login")` lấy identity từ **session vừa xác thực**, không từ cookie cũ; 100% login có đúng actor+tenant; test `tests/h01g-login-attribution.test.ts` |
| **M6** | **Recording quota** | 11,53 GB/24h; retention 7d đã có nhưng chưa có quota theo tenant | 72h soak: tăng trưởng ≤ ngân sách định nghĩa |
| **M7** | **Giới hạn consumer MJPEG** (`maxReaders=0` hiện tại) | Tránh 1 client hút hết băng thông | `maxReaders` hữu hạn + đo số consumer đồng thời |
| **M8** | **Backup/restore verify** | Chưa có bằng chứng restore thành công | restore vào DB sạch → checksum khớp |
| **M9** | **Soak 72h** | Chưa có bằng chứng vận hành dài hạn | 72h không restart, không mất frame, camera health 100% |
| **M10** | **Refactor theo vùng + Sonar new-code gate** | Rẻ nhất, để cuối | Sonar `security_rating` new code = **A**; 12 BUG = 0; 16 workflow VULNERABILITY = 0 |

### 4.1 Ba việc có thể làm NGAY (rẻ, đo được, không cần chờ hạng mục khác)

| Việc | Effort | Gate |
|---|---|---|
| Sửa 12 BUG Sonar (5 promise-await, 2 regex, 3 keyboard, 1 button type, 1 dead conditional) | ~2 h | `curl '.../types=BUG'` → 0 |
| Sửa 16 workflow VULNERABILITY (pin SHA + version, `--only-binary :all`, bỏ `npx`) | ~1 h | CI xanh + Sonar VULNERABILITY = 0 |
| Fix audit identity contamination | ~1 h | test attribution mới |

---

## 5. Trạng thái ưu tiên trước đợt này

| Hạng mục | Trạng thái |
|---|---|
| M4 — camera EZVIZ 796 | **DONE** (health 10/10, frame 290 KB, task proxy Running) |
| Fullscreen toggle | **DONE** — PR #62 merge `6674da3`, app `:3000` chạy main mới, smoke 18/18 |
| Camera health timeout | **DONE** — `GO2RTC_PROBE_TIMEOUT_MS=12000`, commit `5a1757d` |
| RLS probe (chứng minh superuser bypass) | **DONE** — tạo policy thử → superuser vẫn thấy 2/2 dòng ⇒ RLS vô hiệu |
| M0 MediaMTX | **CHƯA LÀM** — anonymous read đã chứng minh thành công |
| M1 DB durability | **CHƯA LÀM** |
| M2 app_rw | **CHƯA LÀM** — role không tồn tại |
| M3 RLS | **CHƯA LÀM** — 0 policy |
| M5–M10 | **CHƯA LÀM** |

---

## 6. Tài liệu liên quan

- `docs/discussions/GPT-REVIEW-PRIORITY-2026-11-04.md` — review vòng 1
- `docs/discussions/GPT_REVIEW_REBUTTAL_2026-11-04.md` — phản biện vòng 1
- `docs/discussions/PROJECT-STATUS-BRIEF-2026-11-04.md` — brief trạng thái
- `docs/discussions/GPT-HOSTILE-REVIEW-R3-2026-11-04.md` — reply GPT vòng 3 nguyên văn (11.582 ký tự)
