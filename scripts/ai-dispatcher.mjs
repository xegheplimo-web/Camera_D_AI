// Optional supervised worker process: no model weights on this host.
// Run with node scripts/ai-dispatcher.mjs [--once] from the project root.
import "dotenv/config";
const base = process.env.DAI_GATEWAY_URL;
const token = process.env.DAI_DISPATCH_TOKEN;
if (!base || !token || token.length < 32) throw new Error("Set DAI_GATEWAY_URL and DAI_DISPATCH_TOKEN (32+ chars).");
const target = new URL("/api/internal/jobs/dispatch", base);
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
do {
  try {
    const r = await fetch(target, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(65000), redirect: "error" });
    if (!r.ok) console.error(`Dispatcher HTTP ${r.status}`);
    else console.log("Dispatcher:", await r.json());
  } catch { console.error("Dispatcher unavailable; retrying without logging credentials."); }
  if (process.argv.includes("--once")) break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
} while (!stopped);
