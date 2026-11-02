import type { cameras } from "@/db/schema";
export function publicCamera(row: typeof cameras.$inferSelect) {
  // Never serialize sourceCiphertext or raw camera credentials to a browser.
  const { sourceCiphertext: _secret, ...safe } = row;
  void _secret;
  return safe;
}
