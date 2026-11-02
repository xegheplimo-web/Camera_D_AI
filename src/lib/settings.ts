import { db } from "@/db";
import { appSettings } from "@/db/schema";

export type Settings = {
  demoMode: boolean;
  retentionDays: number;
  remotePlayback: boolean;
  requireVerifiedForAnswers: boolean;
  hermesEnabled: boolean;
  remoteProcessingAllowed: boolean;
  detectEnabled: boolean;
};
const DEFAULTS: Settings = {
  demoMode: false, retentionDays: 30, remotePlayback: false,
  requireVerifiedForAnswers: true, hermesEnabled: true, remoteProcessingAllowed: false,
  detectEnabled: false,
};

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(appSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => {
    const value = map.get(key);
    return [key, typeof fallback === "boolean" ? typeof value === "boolean" ? value : fallback : typeof value === "number" && Number.isFinite(value) ? value : fallback];
  })) as Settings;
}

export async function saveSetting(key: keyof Settings, value: unknown) {
  await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}
