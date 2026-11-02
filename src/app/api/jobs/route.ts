import { authorize } from "@/lib/auth-server";
import { jobView, listJobs } from "@/lib/ai/jobs";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  const all = new URL(req.url).searchParams.get("scope") === "all";
  const rows = await listJobs(auth.session, all);
  return Response.json({ items: rows.map(jobView), scope: all && auth.session.role === "owner" ? "all" : "mine" });
}
