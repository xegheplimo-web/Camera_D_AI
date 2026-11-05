import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  bigserial,
  bigint,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  customType,
} from "drizzle-orm/pg-core";

/** bytea: vector float32 đóng gói thô (little-endian) — không phụ thuộc extension. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/* ---------------- Identity (G2 security foundation) ---------------- */

export const tenants = pgTable("tenants", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("tenants_slug_uniq").on(t.slug)]);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull().default(1), // T-1333
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
  tenantId: integer("tenant_id").notNull().default(1), // T-1333
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
    tenantId: integer("tenant_id").notNull().default(1), // T-1333
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
    tenantId: integer("tenant_id").notNull().default(1), // T-1333
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
    tenantId: integer("tenant_id").notNull().default(1), // T-1333
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
  /** Dữ liệu hỏi-đáp theo câu hỏi; chỉ gồm số liệu đã kiểm chứng từ DB. */
  context?: {
    question?: string;
    cameras?: { id: number; code: string; name: string; location: string; status: string; count: number; lastAt: string | null }[];
    eventTypes?: { type: string; objectClass: string | null; count: number }[];
    hourly?: { hour: number; count: number }[];
    latest?: { id: number; time: string; camera: string; type: string; label: string }[];
  };
  evidence: { eventId?: number; extractionId?: number; label: string; time: string; thumb: string | null }[];
  evidenceCount: number;
  nextActions: { label: string; href: string }[];
  chart?: { label: string; value: number }[];
  warnings: string[];
  /** Cờ lưu lúc trả lời: câu trả lời có dùng dữ liệu mẫu (demoMode bật hoặc nguồn toàn demo). */
  basedOnDemo?: boolean;
};

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1), // T-1333
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
  tenantId: integer("tenant_id").notNull().default(1), // T-1333
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
  tenantId: integer("tenant_id").notNull().default(1), // T-1333
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

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id"), // H-01g: nullable — log legacy/system không quy được tenant
    actor: text("actor"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    device: text("device"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_tenant_idx").on(t.tenantId, t.id.desc())]
);

/* ---------------- T-1335: camera settings + knowledge base ---------------- */

/** Một hàng/camera; `revision` là optimistic lock chống ghi đè lạc hậu (PATCH lệch revision → 409). */
export const cameraSettings = pgTable("camera_settings", {
  cameraId: integer("camera_id").primaryKey().references(() => cameras.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
  profile: text("profile").notNull().default("custom"), // family | shop | warehouse | parking | factory | custom
  features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
  recordEnabled: boolean("record_enabled").notNull().default(false),
  recordAudio: boolean("record_audio").notNull().default(false),
  retentionDays: integer("retention_days").notNull().default(7),
  detectFps: integer("detect_fps").notNull().default(5),
  zones: jsonb("zones").$type<Record<string, unknown>[]>().notNull().default([]),
  countLines: jsonb("count_lines").$type<Record<string, unknown>[]>().notNull().default([]),
  privacyMasks: jsonb("privacy_masks").$type<Record<string, unknown>[]>().notNull().default([]),
  notifyEnabled: boolean("notify_enabled").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Danh mục tri thức/sản phẩm — shared trong tenant, soft delete qua deleted_at. */
export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    scope: text("scope").notNull().default("camera"), // camera | location | workspace
    cameraId: integer("camera_id").references(() => cameras.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    sku: text("sku"),
    note: text("note"),
    priceVnd: integer("price_vnd"), // integer VND — không float, không để LLM tính
    currency: text("currency").notNull().default("VND"),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** T-1355: item bị gộp vào item khác (không xoá — còn hoàn tác được 24 h). */
    mergedIntoId: bigint("merged_into_id", { mode: "number" }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
  },
  (t) => [
    index("knowledge_items_tenant_deleted_idx").on(t.tenantId, t.deletedAt),
    index("knowledge_items_tenant_camera_idx").on(t.tenantId, t.cameraId),
    check("knowledge_items_scope_chk", sql`${t.scope} in ('camera','location','workspace')`),
  ]
);

/**
 * P2: gắn sản phẩm (knowledge_items) vào NHIỀU camera — chủ cửa hàng chủ động
 * thiết lập dùng chung. Link là dữ liệu của camera: xoá camera/item cascade,
 * tắt feature `product` TUYỆT ĐỐI không xoá hàng ở đây.
 */
export const cameraProducts = pgTable(
  "camera_products",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    cameraId: integer("camera_id").notNull().references(() => cameras.id, { onDelete: "cascade" }),
    itemId: bigint("item_id", { mode: "number" }).notNull().references(() => knowledgeItems.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("camera_products_cam_item_uniq").on(t.cameraId, t.itemId),
    index("camera_products_tenant_cam_idx").on(t.tenantId, t.cameraId),
  ]
);

/** Ảnh gắn vào mục — mỗi ảnh một ghi chú riêng; cùng asset ở nhiều item là hợp lệ (không dedup làm mất liên kết). */
export const knowledgeImages = pgTable(
  "knowledge_images",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    itemId: bigint("item_id", { mode: "number" }).notNull().references(() => knowledgeItems.id, { onDelete: "cascade" }),
    assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    /** T-1361: chỉ bật khi chủ cửa hàng đồng ý chia sẻ ảnh vào thư viện chung. */
    shareToLibrary: boolean("share_to_library").notNull().default(false),
    note: text("note"),
    position: integer("position").notNull().default(0),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("knowledge_images_item_asset_uniq").on(t.itemId, t.assetId),
    index("knowledge_images_item_idx").on(t.itemId),
    index("knowledge_images_asset_idx").on(t.assetId),
  ]
);

/** Lịch sử giá — ghi trong cùng transaction với update items.price_vnd. */
export const knowledgePriceHistory = pgTable(
  "knowledge_price_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    itemId: bigint("item_id", { mode: "number" }).notNull().references(() => knowledgeItems.id, { onDelete: "cascade" }),
    priceVnd: integer("price_vnd").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    /** T-1355: provenance — giá đến từ đâu và đã được duyệt chưa. */
    priceSource: text("price_source"), // manual | ocr | supplier | import
    approvalStatus: text("approval_status").notNull().default("approved"), // pending | approved | rejected
    storeId: integer("store_id"),
  },
  (t) => [
    index("knowledge_price_history_item_idx").on(t.itemId),
    check("knowledge_price_history_approval_chk", sql`${t.approvalStatus} in ('pending','approved','rejected')`),
  ]
);

/**
 * T-1355: nhật ký gộp để hoàn tác trong 24 h. `payload` giữ đủ dữ liệu phục hồi
 * (id ảnh/lịch sử giá đã chuyển, custom trước khi gộp) — undo không cần đoán.
 */
export const knowledgeMergeLog = pgTable(
  "knowledge_merge_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    sourceId: bigint("source_id", { mode: "number" }).notNull(),
    targetId: bigint("target_id", { mode: "number" }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
  },
  (t) => [
    index("knowledge_merge_log_tenant_idx").on(t.tenantId, t.createdAt),
    index("knowledge_merge_log_target_idx").on(t.targetId),
  ]
);

/**
 * T-1356: quyết định "giữ riêng" theo CẶP (không bắc cầu). `fingerprint` là
 * vân tay trường định danh của cả hai — định danh đổi thì quyết định hết hiệu lực.
 */
/** T-1361: registry model dùng cho embedding (license phải ghi rõ để đóng gói NOTICE). */
export const modelRegistry = pgTable("model_registry", {
  key: text("key").primaryKey(),
  version: text("version").notNull(),
  license: text("license").notNull(),
  sourceUrl: text("source_url"),
  dim: integer("dim").notNull(),
  sha256: text("sha256"),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** T-1361: vector ảnh sản phẩm, LƯU THEO TENANT — không trộn dữ liệu cửa hàng. */
export const productEmbeddings = pgTable(
  "product_embeddings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    itemId: bigint("item_id", { mode: "number" }).notNull(),
    /** 0 = embedding cấp item; > 0 = ảnh cụ thể (NOT NULL để unique index làm arbiter). */
    imageId: bigint("image_id", { mode: "number" }).notNull().default(0),
    model: text("model").notNull(),
    modelVersion: text("model_version").notNull(),
    dim: integer("dim").notNull(),
    vec: bytea("vec").notNull(),
    norm: real("norm").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("product_embeddings_uniq").on(t.tenantId, t.itemId, t.imageId, t.model, t.modelVersion),
    index("product_embeddings_tenant_model_idx").on(t.tenantId, t.model, t.modelVersion),
    index("product_embeddings_item_idx").on(t.itemId),
  ]
);

/** T-1365: lịch sử sửa nhận diện — append-only, không ghi đè. */
export const productCorrections = pgTable(
  "product_corrections",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    itemId: bigint("item_id", { mode: "number" }).notNull(),
    predictedItemId: bigint("predicted_item_id", { mode: "number" }),
    imageId: bigint("image_id", { mode: "number" }),
    assetId: integer("asset_id"),
    score: real("score"),
    scoreSecond: real("score_second"),
    margin: real("margin"),
    source: text("source").notNull().default("user"),
    note: text("note"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("product_corrections_tenant_idx").on(t.tenantId, t.createdAt),
    index("product_corrections_item_idx").on(t.tenantId, t.itemId),
  ]
);

export const knowledgePairDecisions = pgTable(
  "knowledge_pair_decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: integer("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    minItemId: bigint("min_item_id", { mode: "number" }).notNull(),
    maxItemId: bigint("max_item_id", { mode: "number" }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("knowledge_pair_decisions_uniq").on(t.tenantId, t.minItemId, t.maxItemId)]
);
