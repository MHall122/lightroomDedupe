import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getCatalog, listAlbums, LightroomAuthError } from "@/lib/lightroom";

export async function GET() {
  const session = await getSession();
  if (!session.adobe) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  try {
    const catalog = await getCatalog(session);
    const albums = await listAlbums(session, catalog.id);
    return NextResponse.json({ albums });
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
