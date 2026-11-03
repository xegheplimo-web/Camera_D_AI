import { currentSession } from "@/lib/auth-server";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

/** Role đọc phía server để SSR đúng tab Quản trị (owner/operator) mà không cần chờ hydrate. */
export default async function SettingsPage() {
  const session = await currentSession();
  return <SettingsClient initialRole={session?.role ?? "viewer"} />;
}
