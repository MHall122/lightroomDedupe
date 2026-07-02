import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { getCatalog, getRendition, LightroomAuthError } from "@/lib/lightroom";

const VALID = new Set(["thumbnail2x", "640", "1280", "2048"]);

export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/lightroom/assets/[id]/thumbnail">
) {
  const { id } = await ctx.params;
  const size = req.nextUrl.searchParams.get("size") ?? "640";
  if (!VALID.has(size)) {
    return NextResponse.json({ error: "invalid_size" }, { status: 400 });
  }
  const session = await getSession();
  if (!session.adobe) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  try {
    const catalog = await getCatalog(session);
    const upstream = await getRendition(
      session,
      catalog.id,
      id,
      size as "thumbnail2x" | "640" | "1280" | "2048"
    );
    if (!upstream.ok) {
      return NextResponse.json(
        { error: "rendition_unavailable", status: upstream.status },
        { status: upstream.status }
      );
    }
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "image/jpeg",
        "Cache-Control": "private, max-age=3600",
      },
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
