import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ---------------- Identity (G2 security foundation) ---------------- */

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    login: text("login").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"), // NULL = OAuth-only account, password login can never succeed
    role: text("role").notNull().default("viewer"), // owner | operator | viewer
    disabled: boolean("disabled").notNull().default(false),
    googleSub: text("google_sub"), // linked Google OIDC sub; unique, multiple NULLs allowed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_login_idx").on(t.login), uniqueIndex("users_google_sub_idx").on(t.googleSub)]
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // random sid, referenced by the signed cookie
    userId: integer("user_id").notNull(),
    device: text("device").notNull().default("web"),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)]
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------- Cameras, assets, events ---------------- */

export const cameras = pgTable("cameras", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  location: text("location").notNull(),
  sourceType: text("source_type").notNull().default("demo"), // webcam | demo | rtsp
  sourceCiphertext: text("source_ciphertext"), // AES-256-GCM encrypted RTSP source
  sourceHost: text("source_host"), // non-secret IP:port
  streamName: text("stream_name"), // go2rtc local identifier
  thumbnail: text("thumbnail"),
  enabled: boolean("enabled").notNull().default(true),
  retentionDays: integer("retention_days"), // NULL = theo app_settings.retentionDays; >0 = override số ngày giữ events của camera
  status: text("status").notNull().default("online"), // online | offline | degraded | demo
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assets = pgTable(
  "assets",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull().default("image"), // image | video
    mime: text("mime").notNull(),
    sha256: text("sha256").notNull(),
    data: text("data"),
    url: text("url"),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: integer("size_bytes"),
    origin: text("origin").notNull().default("upload"),
    cameraId: integer("camera_id"),
    uploadedBy: text("uploaded_by"), // session identity, never the raw client claim
    userId: integer("user_id").references(() => users.id), // object-scope owner; NULL only on legacy/demo rows
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("assets_sha_idx").on(t.sha256), index("assets_user_idx").on(t.userId)]
);

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    cameraId: integer("camera_id").notNull(),
    type: text("type").notNull(),
    objectClass: text("object_class"),
    label: text("label").notNull(),
    note: text("note"),
    trackId: text("track_id"),
    confidence: real("confidence"),
    priority: text("priority").notNull().default("normal"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    assetId: integer("asset_id"),
    idempotencyKey: text("idempotency_key"),
    source: text("source").notNull().default("live"), // live | manual | demo
    // Detection/count produced in the browser is untrusted evidence until reviewed.
    clientReported: boolean("client_reported").notNull().default(false),
    createdBy: text("created_by"),
    ackAt: timestamp("ack_at", { withTimezone: true }),
    ackBy: text("ack_by"),
    happenedAt: timestamp("happened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_cam_time_idx").on(t.cameraId, t.happenedAt),
    index("events_type_idx").on(t.type),
    index("events_idem_idx").on(t.idempotencyKey),
  ]
);

export type ExtractionResult = {
  summary: string;
  details: string[];
  objects: { label: string; count: number; confidence: number; boxes?: number[][]; edited?: boolean }[];
  ocrText: string;
  structured: { key: string; value: string; confidence: number; edited?: boolean }[];
  confidence: number;
  warnings: string[];
  engine: string[];
};

export const extractions = pgTable(
  "extractions",
  {
    id: serial("id").primaryKey(),
    assetId: integer("asset_id").notNull(),
    title: text("title").notNull().default("Trích xuất ảnh"),
    note: text("note").notNull(),
    productName: text("product_name"),
    sku: text("sku"),
    priceVnd: integer("price_vnd"),
    quantity: integer("quantity"),
    roi: jsonb("roi").$type<{ x: number; y: number; w: number; h: number } | null>(),
    taskType: text("task_type").notNull().default("freeform"),
    status: text("status").notNull().default("REVIEW_REQUIRED"),
    rawResult: jsonb("raw_result").$type<ExtractionResult>(),
    result: jsonb("result").$type<ExtractionResult>(),
    memoryType: text("memory_type").notNull().default("temporary"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    eventId: integer("event_id"),
    version: integer("version").notNull().default(1),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    source: text("source").notNull().default("live"),
    createdBy: text("created_by"),
    userId: integer("user_id").references(() => users.id), // object-scope owner; NULL only on legacy/demo rows
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("extractions_status_idx").on(t.status), index("extractions_user_idx").on(t.userId)]
);

export type AnswerPayload = {
  short: string;
  kind: "DETERMINISTIC_AGGREGATION" | "SEARCH" | "INSUFFICIENT_DATA" | "HELP" | "GROUNDED_REPORT";
  execution?: { path: "fast" | "hermes" | "worker" | "fallback"; jobId?: string; durationMs?: number; reason: string };
  value?: number | null;
  details: string[];
  calculation?: Record<string, unknown>;
  evidence: { eventId?: number; extractionId?: number; label: string; time: string; thumb: string | null }[];
  evidenceCount: number;
  nextActions: { label: string; href: string }[];
  chart?: { label: string; value: number }[];
  warnings: string[];
};

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  role: text("role").notNull(),
  text: text("text").notNull(),
  answer: jsonb("answer").$type<AnswerPayload>(),
  userId: integer("user_id"),
  device: text("device"),
  requestKey: text("request_key"),
  inputMode: text("input_mode").notNull().default("text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("messages_request_role_idx").on(t.userId, t.requestKey, t.role)]);

/* Durable Gateway jobs; inputs/results never contain credentials. */
export const aiJobs = pgTable("ai_jobs", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  sessionId: text("session_id").notNull(),
  requester: text("requester").notNull(),
  requesterDevice: text("requester_device").notNull(),
  kind: text("kind").$type<import("@/lib/ai/types").JobKind>().notNull(),
  state: text("state").$type<import("@/lib/ai/types").JobState>().notNull().default("queued"),
  route: text("route").$type<import("@/lib/ai/types").JobRoute>().notNull().default("hermes"),
  title: text("title").notNull(),
  input: jsonb("input").$type<import("@/lib/ai/types").JobInput>().notNull(),
  inputHash: text("input_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  progress: integer("progress").notNull().default(0),
  steps: jsonb("steps").$type<import("@/lib/ai/types").Step[]>().notNull().default([]),
  result: jsonb("result").$type<import("@/lib/ai/types").JobResult>(),
  attempts: integer("attempts").notNull().default(0),
  errorCode: text("error_code"),
  error: text("error"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  runToken: text("run_token"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("ai_jobs_user_idempotency_idx").on(t.userId, t.idempotencyKey),
  index("ai_jobs_dispatch_idx").on(t.state, t.leaseUntil),
  index("ai_jobs_user_created_idx").on(t.userId, t.createdAt),
]);

export const aiServices = pgTable("ai_services", {
  name: text("name").primaryKey(),
  state: text("state").notNull().default("unknown"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  latencyMs: integer("latency_ms"),
  lastError: text("last_error"),
});

/* ---------------- Alerts ---------------- */

export const alertRules = pgTable("alert_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull().default("alert"), // event type the rule applies to
  priority: text("priority").notNull().default("important"),
  cameraId: integer("camera_id"),
  minConfidence: real("min_confidence").notNull().default(0),
  cooldownSeconds: integer("cooldown_seconds").notNull().default(300),
  notifyPush: boolean("notify_push").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actor: text("actor"),
  actorRole: text("actor_role"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  device: text("device"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
