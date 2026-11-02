import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

/**
 * Legacy route kept for old links: the console moved to /admin (owner-only).
 * Non-owners are sent home; the owner keeps ?job= deep links working.
 */
export default async function OrchestrationRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (session?.role !== "owner") redirect("/");
  const job = (await searchParams).job;
  redirect(typeof job === "string" && job ? `/admin?job=${encodeURIComponent(job)}` : "/admin");
}
