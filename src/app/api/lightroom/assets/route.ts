import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getCatalog, listAssets, LightroomAuthError } from "@/lib/lightroom";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session.adobe) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  const params = req.nextUrl.searchParams;
  const after = params.get("after");
  const limit = Number(params.get("limit") ?? "200");
  const albumId = params.get("albumId");
  const capturedAfter = params.get("capturedAfter");
  const capturedBefore = params.get("capturedBefore");
  try {
    const catalog = await getCatalog(session);
    const page = await listAssets(session, catalog.id, {
      limit,
      afterPath: after ?? undefined,
      albumId: albumId ?? undefined,
      capturedAfter: capturedAfter ?? undefined,
      capturedBefore: capturedBefore ?? undefined,
    });
    return NextResponse.json({
      catalogId: catalog.id,
      assets: page.assets,
      nextAfter: page.nextPath,
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
