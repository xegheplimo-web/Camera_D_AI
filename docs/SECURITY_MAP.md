# SECURITY MAP — Camera D-AI (CAM-G1-001, branch `feat/g1-001-scope`)

> Object-level authorization contract. Mọi request đi qua 3 lớp:
> **(1)** `src/proxy.ts` — cookie `dai_session` bắt buộc cho route không public → 401.
> **(2)** `authorize(action)` trong `src/lib/auth-server.ts` — RBAC matrix `can(role, action)` → 403.
> **(3)** `authorizeResource(session, kind, id, mode)` trong `src/lib/scope.ts` — kiểm soát per-object → 404 đồng nhất (không lộ existence) + audit `scope.denied`.
>
> Resource classes: **shared** = telemetry gắn camera/workspace (cameras, events, alert_rules, settings); **user-bound** = object thuộc user (assets, extractions, messages, ai_jobs); **private** = identity/session/credential (không bao giờ trả qua resource API).
>
> Owner override: role `owner` đọc được toàn bộ object (admin model — giống queue `?scope=all` có sẵn) và được phép cleanup (DELETE là owner-only). `operator`/`viewer` chỉ thấy **own + shared**; ghi chỉ trên **own**.
> NULL `user_id` trên row legacy (không backfill được, không camera-bound, không demo) = owner-only — fail-closed.

## Scope predicates (src/lib/scope.ts)

| Helper | owner | operator/viewer |
|---|---|---|
| `assetReadScope` | all | `user_id = me OR camera_id NOT NULL OR origin='demo'` |
| `extractionScope` read | all | `user_id = me OR source='demo'` |
| `extractionScope` write | all | `user_id = me` |
| `authorizeResource("asset")` write | all | `user_id = me` |
| `authorizeResource("job")` | all | `user_id = me` |
| `authorizeResource("camera"/"event")` | shared — tồn tại là đủ | shared |

## Route map — 18 groups

| Method | Route | Role gate | Object-level permission | Resource | Audit event |
|---|---|---|---|---|---|
| GET | `/api/admin` | manage | n/a — workspace audit/session view | shared | — |
| POST | `/api/admin` | delete + role=owner + confirm phrase | n/a — destructive workspace op | shared | `data.clear_demo` / `data.reset_all` / `auth.revoke_other_sessions` |
| GET | `/api/alerts` | read | events+rules shared; `thumbMap` scoped assets | shared | — |
| POST | `/api/alerts` | read | ack on shared event rows (id list is filter, not ownership claim) | shared | `alert.ack` / `alert.ack_all` |
| PUT | `/api/alerts` | manage | alert_rule row exists → 404 | shared | `alert_rule.create/toggle/delete` |
| POST | `/api/assets` | capture | insert binds `userId = session.sub`; dedup scoped to own sha | user-bound | `asset.upload/capture/clip` |
| GET | `/api/assets/[id]` | read | `authorizeResource(asset,read)` → 404 out-of-scope | user-bound + shared(camera-bound/demo) | `scope.denied` |
| GET | `/api/auth/google` | public | n/a — OAuth redirect | — | — |
| GET | `/api/auth/google/callback` | public | `ensureGoogleSeed` → owner seed attong39 | private | `auth.login` |
| POST | `/api/auth/login` | public + rate-limit | credential verify, issue own session | private | `auth.login` / `auth.login_failed` |
| POST | `/api/auth/logout` | session | revokes caller's own session row | user-bound | `auth.logout` |
| GET | `/api/auth/me` | session | returns own session + `can()` matrix | user-bound | — |
| GET | `/api/cameras` | read | shared list, `publicCamera()` strips secrets | shared | — |
| POST | `/api/cameras` | manage | creates shared camera; RTSP creds AES-GCM | shared | `camera.create` |
| POST | `/api/cameras/discover` | manage | ONVIF probe, shared | shared | `camera.discover` |
| POST | `/api/cameras/[id]/connect` | manage | `authorizeResource(camera,write)` → 404 | shared | `camera.connect` / `scope.denied` |
| GET | `/api/cameras/[id]/stream` | read | `authorizeResource(camera,read)` + enabled+rtsp+connected → else 404 | shared | `scope.denied` |
| GET | `/api/chat` | read | `messages.userId = session.sub` | user-bound | — |
| POST | `/api/chat` | ask | own messages; `answerQuestion(q, session)` — every SQL fact scoped | user-bound + shared facts | `chat.fast` / `ai.job.queued` |
| DELETE | `/api/chat` | ask | `DELETE messages WHERE userId = session.sub` | user-bound | `chat.clear_own` |
| GET | `/api/dashboard` | read | events shared; asset/extraction counts scoped; `thumbMap` scoped | shared + user-bound | — |
| GET | `/api/events` | read | events shared; `thumbMap` scoped assets | shared | — |
| POST | `/api/events` | capture | camera must exist → 400; `authorizeResource(asset)` for attachment → 404 | shared | `event.manual/snapshot/clip` |
| PATCH | `/api/events/[id]` | verify | `authorizeResource(event,write)` → 404 | shared | `event.update` / `scope.denied` |
| DELETE | `/api/events/[id]` | delete + `?confirm=yes` | `authorizeResource(event,write)` → 404 | shared | `event.delete` / `scope.denied` |
| GET | `/api/extractions` | read | list filtered `extractionScope`; `thumbMap` scoped | user-bound + demo | — |
| POST | `/api/extractions` | capture | `authorizeResource(asset,read)` → 404; insert `userId = session.sub` | user-bound | `note.save` / `ai.job.queued` |
| PATCH | `/api/extractions/[id]` | verify | `authorizeResource(extraction,write)` → 404 | user-bound | `extraction.update` / `scope.denied` |
| DELETE | `/api/extractions/[id]` | delete + `?confirm=yes` | `authorizeResource(extraction,write)` → 404 | user-bound | `extraction.delete` / `scope.denied` |
| GET | `/api/health` | public | n/a | — | — |
| POST | `/api/internal/jobs/dispatch` | Bearer `DAI_DISPATCH_TOKEN` (timing-safe) | service token, no session; workers self-scope to job owner | internal | — |
| GET | `/api/jobs` | read | `aiJobs.userId = sub`; `?scope=all` only for owner | user-bound | — |
| GET | `/api/jobs/[id]` | read | `authorizeResource(job)` → 404; linked extraction scoped; assistant pinned `userId = job.userId` | user-bound | `scope.denied` |
| PATCH | `/api/jobs/[id]` | ask (+ viewer denied for extract) | `authorizeResource(job)` → 404 then cancel/retry | user-bound | `ai.job.cancel/retry` / `scope.denied` |
| GET | `/api/orchestration` | read | stats/messages counted for `session.sub` only | user-bound | — |
| POST | `/api/orchestration` | manage | service probe, no data object | shared | `ai.service.probe` |
| GET | `/api/report` | export | CSV = events only (shared telemetry); no user-bound column | shared | `data.export` |
| GET | `/api/settings` | read | shared settings | shared | — |
| PATCH | `/api/settings` | manage (+ owner for remoteProcessing/playback) | shared settings | shared | `settings.update` |
| GET | `/api/stats` | read | events aggregation only, shared | shared | — |
| POST | `/api/vision/frame` | capture | frame processed in-memory, `persisted:false`, throttled per user | transient (user-bound) | — |
| POST | `/api/voice/tts` | ask | audio streamed to requester only; `X-Output-Target: requester_device`; no device control | user-bound | — |
| POST | `/api/voice/transcriptions` | ask | multipart ≤6MB, requester-bound; `storedAudio:false` | user-bound | — |

## Background workers (no HTTP context)

| Path | Scope |
|---|---|
| `runJob` session recheck | `sessions` join `users` — revoked/expired/disabled → `SESSION_REVOKED` |
| `assetImage` / `imageWorker` | `assetReadScope(requester)` — extract jobs re-check media under requester scope |
| `evidenceWorker` | `thumbMap(requester)` — evidence thumbs scoped to job owner |
| `enqueueJob("extract")` | asset re-verified `assetReadScope(session)` inside enqueue tx; extraction insert binds `userId` |
| `dispatchJobs` | claims queued/expired-lease jobs; each worker still runs under its own requester scope |

## Cross-user contract (tested in `tests/scope-rbac.test.ts` — 25 cases)

- Unauthenticated → 401 on every non-public route.
- Wrong role → 403 **before** any object lookup (no existence oracle).
- Cross-user read/write of user-bound objects → uniform 404 + `scope.denied` audit.
- Owner override documented: read-all + delete-any; never silently — the queue `?scope=all` contract predates this change.
- Camera-bound assets/events stay shared: any authenticated role reads; write follows role matrix.
- Legacy rows with NULL `user_id` (no camera, not demo) are owner-only — fail closed.
