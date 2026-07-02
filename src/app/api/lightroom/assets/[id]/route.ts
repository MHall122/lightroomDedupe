import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { deleteAsset, getCatalog, LightroomAuthError } from "@/lib/lightroom";

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<"/api/lightroom/assets/[id]">
) {
  const { id } = await ctx.params;
  const session = await getSession();
  if (!session.adobe) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  try {
    const catalog = await getCatalog(session);
    await deleteAsset(session, catalog.id, id);
    return NextResponse.json({ ok: true });
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
