import Link from "next/link";
import { notFound } from "next/navigation";
import { Palette } from "lucide-react";
import { currentSession } from "@/lib/auth-server";
import OrchestrationConsole from "./OrchestrationConsole";

export const dynamic = "force-dynamic";

/** Engineering console (§G3): platform internals are visible to the owner only. */
export default async function AdminPage() {
  const session = await currentSession();
  if (session?.role !== "owner") notFound();
  return (
    <div className="space-y-4">
      <div className="glass mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 p-4">
        <div className="flex-1">
          <div className="font-semibold">Engineering Console · chỉ chủ hệ thống</div>
          <p className="text-xs text-[#a9bad2]">Hạ tầng nền tảng: điều phối AI, worker, design freeze. Không hiển thị trong điều hướng khách hàng.</p>
        </div>
        <Link href="/design" className="btn btn-ghost text-xs"><Palette className="h-3.5 w-3.5" /> Design Freeze →</Link>
      </div>
      <OrchestrationConsole />
    </div>
  );
}
