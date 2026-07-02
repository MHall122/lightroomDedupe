import { env } from "./env";
import { refreshAccessToken } from "./adobe-auth";
import type { SessionData } from "./session";

export const LR_HOST = "https://lr.adobe.io";
export const LR_BASE = "https://lr.adobe.io/v2";
export const ME = "00000000000000000000000000000000";

function toAdobeUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  if (pathOrUrl.startsWith("/v2/")) return `${LR_HOST}${pathOrUrl}`;
  if (pathOrUrl.startsWith("/")) return `${LR_BASE}${pathOrUrl}`;
  return `${LR_BASE}/${pathOrUrl}`;
}

export class LightroomAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type LrSession = Awaited<ReturnType<typeof import("./session").getSession>>;

async function ensureAccessToken(session: LrSession): Promise<string> {
  if (!session.adobe) throw new LightroomAuthError("not_authenticated", 401);
  const skew = 60 * 1000;
  if (session.adobe.expiresAt - skew > Date.now()) {
    return session.adobe.accessToken;
  }
  if (!session.adobe.refreshToken) {
    throw new LightroomAuthError("token_expired_no_refresh", 401);
  }
  const refreshed = await refreshAccessToken(session.adobe.refreshToken);
  session.adobe.accessToken = refreshed.access_token;
  if (refreshed.refresh_token) session.adobe.refreshToken = refreshed.refresh_token;
  session.adobe.expiresAt = Date.now() + refreshed.expires_in * 1000;
  await session.save();
  return session.adobe.accessToken;
}

async function lrFetch(
  session: LrSession,
  pathOrUrl: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = await ensureAccessToken(session);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-API-Key", env.adobeClientId());
  const url = toAdobeUrl(pathOrUrl);
  if (process.env.NODE_ENV !== "production") {
    console.log(`[lr] ${init.method ?? "GET"} ${url}`);
  }
  return fetch(url, { ...init, headers });
}

// Adobe wraps some JSON responses with a "while (1) {}" anti-hijacking prefix.
async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  const cleaned = text.startsWith("while (1) {}") ? text.slice(12) : text;
  return JSON.parse(cleaned) as T;
}

export type LrAccount = {
  id: string;
  type: "account";
  full_name?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
};

export async function getAccount(session: LrSession): Promise<LrAccount> {
  const res = await lrFetch(session, `/accounts/${ME}`);
  if (!res.ok) throw new LightroomAuthError(await res.text(), res.status);
  const body = await parseJson<{ id: string; type: "account"; payload?: LrAccount }>(res);
  return {
    id: body.id,
    type: "account",
    ...(body.payload ?? {}),
  };
}

export type LrCatalog = {
  id: string;
  type: "catalog";
  name?: string;
};

export async function getCatalog(session: LrSession): Promise<LrCatalog> {
  const res = await lrFetch(session, `/catalogs/${ME}`);
  if (!res.ok) throw new LightroomAuthError(await res.text(), res.status);
  const body = await parseJson<{ id: string; payload?: { name?: string } }>(res);
  return { id: body.id, type: "catalog", name: body.payload?.name };
}

export type LrAsset = {
  id: string;
  subtype?: string;
  captureDate?: string;
  fileName?: string;
  fileSize?: number;
  dimensions?: { width?: number; height?: number };
};

type RawAssetPayload = {
  captureDate?: string;
  importSource?: { fileName?: string; fileSize?: number };
  develop?: { croppedWidth?: number; croppedHeight?: number };
};

type RawAsset = {
  id: string;
  subtype?: string;
  type?: string;
  payload?: RawAssetPayload;
  asset?: { id: string; subtype?: string; payload?: RawAssetPayload };
};

export type LrAssetsPage = {
  assets: LrAsset[];
  nextPath: string | null;
};

export type ListAssetsOpts = {
  limit?: number;
  afterPath?: string;
  albumId?: string;
  capturedAfter?: string;
  capturedBefore?: string;
};

function unwrapAsset(r: RawAsset): LrAsset {
  const raw = r.asset ?? r;
  const payload = raw.payload;
  return {
    id: raw.id,
    subtype: raw.subtype,
    captureDate: payload?.captureDate,
    fileName: payload?.importSource?.fileName,
    fileSize: payload?.importSource?.fileSize,
    dimensions: payload?.develop
      ? {
          width: payload.develop.croppedWidth,
          height: payload.develop.croppedHeight,
        }
      : undefined,
  };
}

export async function listAssets(
  session: LrSession,
  catalogId: string,
  opts: ListAssetsOpts = {}
): Promise<LrAssetsPage> {
  let requestUrl: string;
  if (opts.afterPath) {
    requestUrl = toAdobeUrl(opts.afterPath);
  } else {
    const params = new URLSearchParams();
    params.set("subtype", "image");
    params.set("limit", String(opts.limit ?? 200));
    if (opts.albumId) {
      requestUrl = `${LR_BASE}/catalogs/${catalogId}/albums/${opts.albumId}/assets?${params.toString()}`;
    } else {
      params.set("exclude", "incomplete");
      if (opts.capturedAfter) params.set("captured_after", opts.capturedAfter);
      if (opts.capturedBefore) params.set("captured_before", opts.capturedBefore);
      requestUrl = `${LR_BASE}/catalogs/${catalogId}/assets?${params.toString()}`;
    }
  }
  const res = await lrFetch(session, requestUrl);
  if (!res.ok) throw new LightroomAuthError(await res.text(), res.status);
  const body = await parseJson<{
    resources: RawAsset[];
    links?: { next?: { href: string } };
  }>(res);
  const assets = (body.resources ?? []).map(unwrapAsset);
  const nextHref = body.links?.next?.href;
  const nextPath = nextHref ? new URL(nextHref, requestUrl).toString() : null;
  return { assets, nextPath };
}

export type LrAlbum = {
  id: string;
  name: string;
  subtype?: string;
  assetCount?: number;
};

type RawAlbum = {
  id: string;
  subtype?: string;
  payload?: {
    name?: string;
    assetSortOrder?: string;
  };
};

export async function listAlbums(
  session: LrSession,
  catalogId: string,
  opts: { subtype?: "collection" | "project" } = {}
): Promise<LrAlbum[]> {
  const subtype = opts.subtype ?? "collection";
  const albums: LrAlbum[] = [];
  let requestUrl: string | null = `${LR_BASE}/catalogs/${catalogId}/albums?subtype=${subtype}&limit=100`;
  while (requestUrl) {
    const res: Response = await lrFetch(session, requestUrl);
    if (!res.ok) throw new LightroomAuthError(await res.text(), res.status);
    const body = await parseJson<{
      resources: RawAlbum[];
      links?: { next?: { href: string } };
    }>(res);
    for (const r of body.resources ?? []) {
      albums.push({
        id: r.id,
        name: r.payload?.name ?? "Untitled",
        subtype: r.subtype,
      });
    }
    const nextHref = body.links?.next?.href;
    requestUrl = nextHref ? new URL(nextHref, requestUrl).toString() : null;
  }
  albums.sort((a, b) => a.name.localeCompare(b.name));
  return albums;
}

export async function getRendition(
  session: LrSession,
  catalogId: string,
  assetId: string,
  size: "thumbnail2x" | "640" | "1280" | "2048" = "640"
): Promise<Response> {
  return lrFetch(
    session,
    `/catalogs/${catalogId}/assets/${assetId}/renditions/${size}`
  );
}

export async function deleteAsset(
  session: LrSession,
  catalogId: string,
  assetId: string
): Promise<void> {
  const res = await lrFetch(
    session,
    `/catalogs/${catalogId}/assets/${assetId}`,
    { method: "DELETE" }
  );
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    if (process.env.NODE_ENV !== "production") {
      console.log(`[lr] DELETE ${assetId} → ${res.status}: ${body}`);
    }
    throw new LightroomAuthError(body, res.status);
  }
}

function newAdobeId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createProjectAlbum(
  session: LrSession,
  catalogId: string,
  name: string
): Promise<string> {
  const albumId = newAdobeId();
  const body = JSON.stringify({
    subtype: "project",
    serviceId: env.adobeClientId(),
    payload: { name },
  });
  const res = await lrFetch(
    session,
    `/catalogs/${catalogId}/albums/${albumId}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    }
  );
  if (!res.ok && res.status !== 201 && res.status !== 200 && res.status !== 204) {
    const text = await res.text();
    if (process.env.NODE_ENV !== "production") {
      console.log(`[lr] PUT album ${albumId} → ${res.status}: ${text}`);
    }
    throw new LightroomAuthError(text, res.status);
  }
  return albumId;
}

export type AddAssetsResult = {
  added: number;
  failed: { assetId: string; status?: number; detail?: string }[];
};

export async function listAlbumAssetIds(
  session: LrSession,
  catalogId: string,
  albumId: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  let page = await listAssets(session, catalogId, { albumId, limit: 500 });
  while (true) {
    for (const asset of page.assets) ids.add(asset.id);
    if (!page.nextPath) break;
    page = await listAssets(session, catalogId, { afterPath: page.nextPath });
  }
  return ids;
}

export async function addAssetsToAlbum(
  session: LrSession,
  catalogId: string,
  albumId: string,
  assetIds: string[]
): Promise<AddAssetsResult> {
  const result: AddAssetsResult = { added: 0, failed: [] };
  for (let i = 0; i < assetIds.length; i += 50) {
    const chunk = assetIds.slice(i, i + 50);
    const body = JSON.stringify({
      resources: chunk.map((assetId) => ({
        id: assetId,
        payload: {},
      })),
    });
    const res = await lrFetch(
      session,
      `/catalogs/${catalogId}/albums/${albumId}/assets`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      }
    );
    const text = await res.text();
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[lr] PUT album-assets ${albumId} [${chunk.length}] → ${res.status}: ${text.slice(0, 200)}`
      );
    }
    if (res.status === 201 || res.status === 200) {
      result.added += chunk.length;
    } else if (res.status === 403) {
      for (const assetId of chunk) {
        result.failed.push({ assetId, status: 403, detail: text.slice(0, 200) });
      }
    } else {
      for (const assetId of chunk) {
        result.failed.push({
          assetId,
          status: res.status,
          detail: text.slice(0, 200),
        });
      }
    }
  }
  return result;
}
