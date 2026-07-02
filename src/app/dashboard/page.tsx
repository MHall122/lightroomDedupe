import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import Deduper from "@/components/Deduper";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session.adobe) redirect("/");
  return (
    <Deduper
      account={{
        email: session.adobe.email,
        name: session.adobe.name,
      }}
    />
  );
}
