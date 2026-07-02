import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import {
  addAssetsToAlbum,
  createProjectAlbum,
  getCatalog,
  LightroomAuthError,
  listAlbumAssetIds,
  listAlbums,
} from "@/lib/lightroom";

const DEFAULT_ALBUM_NAME = "🗑 Duplicates to review";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.adobe) {
    return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  }
  let body: { assetIds?: string[]; albumId?: string; albumName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const assetIds = Array.isArray(body.assetIds) ? body.assetIds : [];
  const suppliedAlbumId = typeof body.albumId === "string" ? body.albumId : "";
  if (assetIds.length === 0) {
    return NextResponse.json({ error: "no_assets" }, { status: 400 });
  }

  try {
    const catalog = await getCatalog(session);
    let targetAlbumId: string;
    let albumName: string;
    let created = false;

    if (suppliedAlbumId) {
      // User picked one of their own collection albums.
      targetAlbumId = suppliedAlbumId;
      const collections = await listAlbums(session, catalog.id, {
        subtype: "collection",
      });
      albumName =
        collections.find((a) => a.id === suppliedAlbumId)?.name ?? suppliedAlbumId;
    } else {
      // Fallback: create a partner project album (only works if we're an
      // Adobe-recognized partner; kept for future use).
      const projects = await listAlbums(session, catalog.id, {
        subtype: "project",
      });
      const name = body.albumName || DEFAULT_ALBUM_NAME;
      const existing = projects.find((a) => a.name === name);
      if (existing) {
        targetAlbumId = existing.id;
      } else {
        targetAlbumId = await createProjectAlbum(session, catalog.id, name);
        created = true;
      }
      albumName = name;
    }

    let toAdd = assetIds;
    let skipped = 0;
    if (!created) {
      const existing = await listAlbumAssetIds(session, catalog.id, targetAlbumId);
      toAdd = assetIds.filter((id) => !existing.has(id));
      skipped = assetIds.length - toAdd.length;
    }

    const result =
      toAdd.length > 0
        ? await addAssetsToAlbum(session, catalog.id, targetAlbumId, toAdd)
        : { added: 0, failed: [] };

    return NextResponse.json({
      albumId: targetAlbumId,
      albumName,
      created,
      added: result.added,
      skipped,
      failed: result.failed.length,
      firstFailure: result.failed[0] ?? null,
    });
  } catch (e) {
    if (e instanceof LightroomAuthError) {
      return NextResponse.json(
        {
          error: "album_write_failed",
          status: e.status,
          detail: e.message.slice(0, 400),
        },
        { status: e.status }
      );
    }
    throw e;
  }
}
