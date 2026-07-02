import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getAccount, getCatalog, LightroomAuthError } from "@/lib/lightroom";

export async function GET() {
  const session = await getSession();
  if (!session.adobe) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  try {
    const [account, catalog] = await Promise.all([
      getAccount(session),
      getCatalog(session),
    ]);
    return NextResponse.json({
      account: {
        id: account.id,
        email: account.email ?? session.adobe.email,
        name: account.full_name ?? session.adobe.name,
      },
      catalog: { id: catalog.id, name: catalog.name },
    });
  } catch (e) {
    if (e instanceof LightroomAuthError) {
      return NextResponse.json(
        { error: "lightroom_error", detail: e.message },
        { status: e.status }
      );
    }
    throw e;
  }
}
