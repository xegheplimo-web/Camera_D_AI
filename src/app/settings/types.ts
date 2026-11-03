export type Cam = { id: number; code: string; name: string; location: string; sourceType: string; status: string; thumbnail: string | null; enabled: boolean; retentionDays: number | null; sourceHost: string | null };
export type Admin = {
  logs: { id: number; actor: string | null; actorRole: string | null; action: string; targetType: string | null; targetId: string | null; device: string | null; detail: string | null; createdAt: string }[];
  demoEvents: number;
  liveEvents: number;
  demo: { events: number; extractions: number; assets: number };
  storageBytes: number;
  demoSeedEnabled: boolean;
  visionCloud: boolean;
  sessions: { id: string; user: string | null; role: string | null; device: string; createdAt: string; lastSeenAt: string; revokedAt: string | null }[];
  me: { name: string; role: string };
};
export type Settings = { demoMode: boolean; retentionDays: number; remotePlayback: boolean; requireVerifiedForAnswers: boolean; detectEnabled: boolean };
export type RecStorage = { freeBytes: number | null; totalBytes: number; cameras: { key: string; segments: number; bytes: number }[] };
