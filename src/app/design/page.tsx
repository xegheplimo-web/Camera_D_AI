import { notFound } from "next/navigation";
import { currentSession } from "@/lib/auth-server";
import DesignClient from "./DesignClient";

export const dynamic = "force-dynamic";

/** Design Freeze is an engineering artifact (§G3): owner-only, no nav entry. */
export default async function DesignPage() {
  const session = await currentSession();
  if (session?.role !== "owner") notFound();
  return <DesignClient />;
}
