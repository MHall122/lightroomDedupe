"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LrAlbum, LrAsset } from "@/lib/lightroom";
import {
  DEFAULT_CONFIG,
  groupByConfig,
  hasAnyCriterion,
  NAME_OPTIONS,
  needsThumbnails,
  SIZE_OPTIONS,
  TIME_OPTIONS,
  VISUAL_OPTIONS,
  type DuplicateGroup,
  type HashedItem,
  type MatchConfig,
  type NameTolerance,
  type SizeTolerance,
  type TimeTolerance,
  type VisualTolerance,
} from "@/lib/dedupe-groups";

type Mode = "idle" | "scanning" | "reviewing" | "deleting" | "done";

type Scope =
  | { kind: "all" }
  | { kind: "album"; albumId: string }
  | { kind: "date"; year: number; month?: number; day?: number };

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function dateScopeRange(scope: {
  year: number;
  month?: number;
  day?: number;
}): { from: string; to: string } {
  const y = scope.year;
  const m = scope.month;
  const d = scope.day;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (m && d) {
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    return { from: iso, to: iso };
  }
  if (m) {
    const last = daysInMonth(y, m);
    return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
  }
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

type ScanStats = {
  discovered: number;
  hashed: number;
  failed: number;
};

type Account = {
  email?: string;
  name?: string;
};

type Props = {
  account: Account;
};

const FETCH_CONCURRENCY = 4;

function useWorkerHash() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<string, { resolve: (h: string) => void; reject: (e: Error) => void }>());

  useEffect(() => {
    const w = new Worker(new URL("../workers/hash.worker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e: MessageEvent) => {
      const { id, ok, hash, error } = e.data;
      const pending = pendingRef.current.get(id);
      if (!pending) return;
      pendingRef.current.delete(id);
      if (ok) pending.resolve(hash as string);
      else pending.reject(new Error(error as string));
    };
    workerRef.current = w;
    return () => {
      w.terminate();
      workerRef.current = null;
    };
  }, []);

  return useCallback(function hash(
    id: string,
    blob: Blob,
    resolution: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const w = workerRef.current;
      if (!w) return reject(new Error("worker_not_ready"));
      pendingRef.current.set(id, { resolve, reject });
      w.postMessage({ id, blob, resolution });
    });
  }, []);
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

function buildInitialAssetsUrl(scope: Scope): string {
  const params = new URLSearchParams();
  if (scope.kind === "album") {
    params.set("albumId", scope.albumId);
  } else if (scope.kind === "date") {
    const { from } = dateScopeRange(scope);
    params.set("capturedAfter", `${from}T00:00:00.000Z`);
  }
  const qs = params.toString();
  return `/api/lightroom/assets${qs ? `?${qs}` : ""}`;
}

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function pageIsPastRange(assets: LrAsset[], scope: Scope): boolean {
  if (scope.kind !== "date" || assets.length === 0) return false;
  const { to } = dateScopeRange(scope);
  const toTs = new Date(`${to}T23:59:59.999Z`).getTime();
  for (const a of assets) {
    if (!a.captureDate) continue;
    const t = new Date(a.captureDate).getTime();
    if (!Number.isNaN(t) && t <= toTs) return false;
  }
  return true;
}

function passesClientDateFilter(asset: LrAsset, scope: Scope): boolean {
  if (scope.kind !== "date" || !asset.captureDate) return true;
  const t = new Date(asset.captureDate).getTime();
  if (Number.isNaN(t)) return true;
  const { from, to } = dateScopeRange(scope);
  if (t < new Date(`${from}T00:00:00.000Z`).getTime()) return false;
  if (t > new Date(`${to}T23:59:59.999Z`).getTime()) return false;
  return true;
}

export default function Deduper({ account }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [stats, setStats] = useState<ScanStats>({ discovered: 0, hashed: 0, failed: 0 });
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [deleteProgress, setDeleteProgress] = useState({ done: 0, failed: 0, total: 0 });
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [config, setConfig] = useState<MatchConfig>(DEFAULT_CONFIG);
  const [destinationAlbumId, setDestinationAlbumIdState] = useState<string>("");

  const setDestinationAlbumId = useCallback((id: string) => {
    setDestinationAlbumIdState(id);
    if (typeof window !== "undefined") {
      if (id) window.localStorage.setItem("lr-dedupe-default-album", id);
      else window.localStorage.removeItem("lr-dedupe-default-album");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem("lr-dedupe-default-album");
    if (saved) setDestinationAlbumIdState(saved);
  }, []);
  const [albums, setAlbums] = useState<LrAlbum[]>([]);
  const [albumsLoading, setAlbumsLoading] = useState(false);
  const [albumsError, setAlbumsError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    assets: LrAsset[];
    hasMore: boolean;
  } | null>(null);
  const [existingAlbumIds, setExistingAlbumIds] = useState<Set<string>>(new Set());
  const [albumResult, setAlbumResult] = useState<{
    albumId: string;
    albumName: string;
    created: boolean;
    added: number;
    skipped: number;
    failed: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const hashInWorker = useWorkerHash();

  const runPreview = useCallback(async () => {
    setPreviewError(null);
    setPreviewLoading(true);
    setPreview(null);
    try {
      const url = buildInitialAssetsUrl(scope);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`preview_${res.status}: ${await res.text()}`);
      }
      const page: { assets: LrAsset[]; nextAfter: string | null } = await res.json();
      const filtered = page.assets.filter((a) => passesClientDateFilter(a, scope));
      setPreview({
        assets: filtered.slice(0, 60),
        hasMore: filtered.length > 60 || !!page.nextAfter,
      });
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
  }, [scope]);

  useEffect(() => {
    let cancelled = false;
    setAlbumsLoading(true);
    setAlbumsError(null);
    fetch("/api/lightroom/albums")
      .then(async (r) => {
        if (!r.ok) throw new Error(`albums_${r.status}`);
        return r.json();
      })
      .then((d: { albums: LrAlbum[] }) => {
        if (!cancelled) setAlbums(d.albums ?? []);
      })
      .catch((e) => {
        if (!cancelled) setAlbumsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setAlbumsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startScan = useCallback(async () => {
    setError(null);
    setStats({ discovered: 0, hashed: 0, failed: 0 });
    setGroups([]);
    setSelected(new Set());
    setMode("scanning");
    cancelRef.current = false;

    let existingIds = new Set<string>();
    if (destinationAlbumId) {
      try {
        let nextUrl: string | null = `/api/lightroom/assets?albumId=${destinationAlbumId}`;
        while (nextUrl && !cancelRef.current) {
          const r: Response = await fetch(nextUrl);
          if (!r.ok) break;
          const p: { assets: LrAsset[]; nextAfter: string | null } = await r.json();
          for (const a of p.assets) existingIds.add(a.id);
          nextUrl = p.nextAfter
            ? `/api/lightroom/assets?after=${encodeURIComponent(p.nextAfter)}`
            : null;
        }
      } catch {
        existingIds = new Set();
      }
    }
    setExistingAlbumIds(existingIds);

    const items: HashedItem[] = [];
    let nextUrl: string | null = buildInitialAssetsUrl(scope);
    const needThumbs = needsThumbnails(config);

    try {
      while (!cancelRef.current && nextUrl) {
        const res: Response = await fetch(nextUrl);
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Failed to list assets (${res.status}): ${body}`);
        }
        const page: { assets: LrAsset[]; nextAfter: string | null } = await res.json();
        const filtered = page.assets.filter((a) => passesClientDateFilter(a, scope));
        setStats((s) => ({ ...s, discovered: s.discovered + filtered.length }));

        if (needThumbs) {
          await pool(filtered, FETCH_CONCURRENCY, async (asset) => {
            if (cancelRef.current) return;
            try {
              const r = await fetch(`/api/lightroom/assets/${asset.id}/thumbnail?size=640`);
              if (!r.ok) throw new Error(`thumb_${r.status}`);
              const blob = await r.blob();
              const hash = await hashInWorker(
              asset.id,
              blob,
              config.visualResolution
            );
              items.push({
                id: asset.id,
                hash,
                fileName: asset.fileName,
                captureDate: asset.captureDate,
                fileSize: asset.fileSize,
                dimensions: asset.dimensions,
              });
              setStats((s) => ({ ...s, hashed: s.hashed + 1 }));
            } catch {
              setStats((s) => ({ ...s, failed: s.failed + 1 }));
            }
          });
        } else {
          for (const asset of filtered) {
            items.push({
              id: asset.id,
              fileName: asset.fileName,
              captureDate: asset.captureDate,
              fileSize: asset.fileSize,
              dimensions: asset.dimensions,
            });
          }
          setStats((s) => ({ ...s, hashed: s.hashed + filtered.length }));
        }

        if (pageIsPastRange(page.assets, scope)) {
          nextUrl = null;
        } else {
          nextUrl = page.nextAfter
            ? `/api/lightroom/assets?after=${encodeURIComponent(page.nextAfter)}`
            : null;
        }
      }

      const found = groupByConfig(items, config);
      const initial = new Set<string>();
      for (const g of found) {
        for (let i = 1; i < g.items.length; i++) {
          if (!existingIds.has(g.items[i].id)) initial.add(g.items[i].id);
        }
      }
      setGroups(found);
      setSelected(initial);
      setMode("reviewing");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode("idle");
    }
  }, [hashInWorker, scope, config, destinationAlbumId]);

  const cancelScan = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const totalToDelete = selected.size;
  const totalDuplicates = useMemo(
    () => groups.reduce((acc, g) => acc + g.items.length - 1, 0),
    [groups]
  );

  const downloadCsv = useCallback(() => {
    const rows: string[][] = [
      ["Action", "Group", "Filename", "CaptureDate", "Width", "Height", "SizeBytes", "AssetId"],
    ];
    groups.forEach((g, gi) => {
      const groupLabel = String(gi + 1);
      g.items.forEach((item, ii) => {
        const action = selected.has(item.id)
          ? "DELETE"
          : ii === 0
          ? "KEEP"
          : "review";
        rows.push([
          action,
          groupLabel,
          item.fileName ?? "",
          item.captureDate ?? "",
          item.dimensions?.width != null ? String(item.dimensions.width) : "",
          item.dimensions?.height != null ? String(item.dimensions.height) : "",
          item.fileSize != null ? String(item.fileSize) : "",
          item.id,
        ]);
      });
    });
    const csv = rows
      .map((r) => r.map(csvCell).join(","))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `lightroom-duplicates-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [groups, selected]);

  const doAddToAlbum = useCallback(async () => {
    if (totalToDelete === 0) return;
    const assetIds = Array.from(selected);
    setMode("deleting");
    setDeleteProgress({ done: 0, failed: 0, total: assetIds.length });
    setAlbumResult(null);
    setError(null);
    try {
      const res = await fetch("/api/lightroom/duplicates-album", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetIds,
          albumId: destinationAlbumId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          `Couldn't write to Lightroom: ${data.detail ?? data.error ?? res.status}`
        );
        setDeleteProgress({
          done: 0,
          failed: assetIds.length,
          total: assetIds.length,
        });
        setMode("done");
        return;
      }
      setDeleteProgress({
        done: data.added,
        failed: data.failed,
        total: assetIds.length,
      });
      setAlbumResult({
        albumId: data.albumId,
        albumName: data.albumName,
        created: data.created,
        added: data.added,
        skipped: data.skipped ?? 0,
        failed: data.failed,
      });
      if (data.firstFailure) {
        setError(
          `Some adds failed. First: ${data.firstFailure.status}: ${data.firstFailure.detail}`
        );
      }
      setMode("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMode("done");
    }
  }, [selected, totalToDelete, destinationAlbumId]);

  const reset = useCallback(() => {
    setMode("idle");
    setGroups([]);
    setSelected(new Set());
    setStats({ discovered: 0, hashed: 0, failed: 0 });
    setDeleteProgress({ done: 0, failed: 0, total: 0 });
    setError(null);
  }, []);

  return (
    <div className="mx-auto max-w-5xl w-full px-6 py-8 flex flex-col gap-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Lightroom Dedupe</h1>
          <p className="text-sm text-zinc-700 mt-1">
            Signed in as <span className="font-medium">{account.email ?? account.name ?? "Adobe user"}</span>
          </p>
        </div>
        <form action="/api/auth/logout" method="post">
          <button
            type="submit"
            className="text-sm text-zinc-700 hover:text-zinc-900 underline underline-offset-2"
          >
            Sign out
          </button>
        </form>
      </header>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 text-red-800 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {mode === "idle" && (
        <IdlePanel
          onStart={startScan}
          scope={scope}
          setScope={setScope}
          config={config}
          setConfig={setConfig}
          destinationAlbumId={destinationAlbumId}
          setDestinationAlbumId={setDestinationAlbumId}
          albums={albums}
          albumsLoading={albumsLoading}
          albumsError={albumsError}
          preview={preview}
          previewLoading={previewLoading}
          previewError={previewError}
          onPreview={runPreview}
        />
      )}

      {mode === "scanning" && (
        <ScanningPanel stats={stats} onCancel={cancelScan} />
      )}

      {mode === "reviewing" && (
        <ReviewingPanel
          groups={groups}
          selected={selected}
          existingAlbumIds={existingAlbumIds}
          onToggle={toggleSelected}
          totalDuplicates={totalDuplicates}
          totalToDelete={totalToDelete}
          onSubmit={doAddToAlbum}
          onExportCsv={downloadCsv}
          onCancel={reset}
        />
      )}

      {mode === "deleting" && <SubmittingPanel total={deleteProgress.total} />}

      {mode === "done" && (
        <DonePanel
          result={albumResult}
          onReset={reset}
          onExportCsv={downloadCsv}
        />
      )}
    </div>
  );
}

function IdlePanel({
  onStart,
  scope,
  setScope,
  config,
  setConfig,
  destinationAlbumId,
  setDestinationAlbumId,
  albums,
  albumsLoading,
  albumsError,
  preview,
  previewLoading,
  previewError,
  onPreview,
}: {
  onStart: () => void;
  scope: Scope;
  setScope: (s: Scope) => void;
  config: MatchConfig;
  setConfig: (c: MatchConfig) => void;
  destinationAlbumId: string;
  setDestinationAlbumId: (id: string) => void;
  albums: LrAlbum[];
  albumsLoading: boolean;
  albumsError: string | null;
  preview: { assets: LrAsset[]; hasMore: boolean } | null;
  previewLoading: boolean;
  previewError: string | null;
  onPreview: () => void;
}) {
  const scopeOk =
    scope.kind !== "album" || (scope.kind === "album" && scope.albumId !== "");
  const canStart = scopeOk && hasAnyCriterion(config);
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-8 flex flex-col items-start gap-6 text-zinc-900">
      <div>
        <h2 className="text-lg font-semibold">Ready to scan your library</h2>
        <p className="text-sm text-zinc-700 max-w-lg mt-1">
          Narrow the scan to a specific album or date range for a faster first
          pass. Thumbnails are downloaded to your browser, hashed locally, and
          compared. Nothing else leaves your machine.
        </p>
      </div>

      <fieldset className="flex flex-col gap-3 w-full max-w-md">
        <legend className="text-sm font-semibold text-zinc-900">What to scan</legend>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="scope"
            className="mt-1"
            checked={scope.kind === "all"}
            onChange={() => setScope({ kind: "all" })}
          />
          <div>
            <div className="text-sm font-medium text-zinc-900">Entire library</div>
            <div className="text-sm text-zinc-700">Every synced photo. Can take a while.</div>
          </div>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="scope"
            className="mt-1"
            checked={scope.kind === "album"}
            onChange={() =>
              setScope({ kind: "album", albumId: albums[0]?.id ?? "" })
            }
          />
          <div className="flex-1">
            <div className="text-sm font-medium text-zinc-900">A specific album</div>
            {scope.kind === "album" && (
              <div className="mt-2">
                {albumsLoading && (
                  <div className="text-sm text-zinc-700">Loading albums…</div>
                )}
                {albumsError && (
                  <div className="text-xs text-red-600">
                    Couldn&apos;t load albums: {albumsError}
                  </div>
                )}
                {!albumsLoading && !albumsError && albums.length === 0 && (
                  <div className="text-sm text-zinc-700">
                    No albums found in your library.
                  </div>
                )}
                {albums.length > 0 && (
                  <select
                    className="w-full rounded border border-zinc-400 px-2 py-1.5 text-sm bg-white text-zinc-900"
                    value={scope.albumId}
                    onChange={(e) =>
                      setScope({ kind: "album", albumId: e.target.value })
                    }
                  >
                    {albums.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="scope"
            className="mt-1"
            checked={scope.kind === "date"}
            onChange={() =>
              setScope({ kind: "date", year: new Date().getFullYear() })
            }
          />
          <div className="flex-1">
            <div className="text-sm font-medium text-zinc-900">By date</div>
            <div className="text-sm text-zinc-700">
              Pick a year; optionally narrow to a month or a specific day.
            </div>
            {scope.kind === "date" && (
              <DatePicker scope={scope} setScope={setScope} />
            )}
          </div>
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-3 w-full max-w-md">
        <legend className="text-sm font-semibold text-zinc-900">How to match</legend>
        <p className="text-sm text-zinc-700">
          Turn on any combination. When multiple are on, choose whether ALL
          must match (AND) or ANY can match (OR).
        </p>

        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={config.visual !== "off"}
            aria-label="Enable Visual similarity"
            onChange={(e) =>
              setConfig({
                ...config,
                visual: e.target.checked ? "strict" : "off",
              })
            }
          />
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-zinc-900">Visual similarity</span>
              {config.visual !== "off" && (
                <>
                  <select
                    aria-label="Visual tolerance"
                    className="rounded border border-zinc-400 px-2 py-0.5 text-xs bg-white text-zinc-900"
                    value={config.visual}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        visual: e.target.value as VisualTolerance,
                      })
                    }
                  >
                    {VISUAL_OPTIONS.filter((o) => o.value !== "off").map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Visual resolution"
                    className="rounded border border-zinc-400 px-2 py-0.5 text-xs bg-white text-zinc-900"
                    value={config.visualResolution}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        visualResolution: Number(e.target.value) as
                          | 8
                          | 16
                          | 32
                          | 64,
                      })
                    }
                  >
                    <option value={8}>Fast (8×8, 64 bits)</option>
                    <option value={16}>Standard (16×16, 256 bits)</option>
                    <option value={32}>Precise (32×32, 1024 bits)</option>
                    <option value={64}>Extreme (64×64, 4096 bits)</option>
                  </select>
                </>
              )}
            </div>
            <div className="text-sm text-zinc-700">
              Perceptual hash on thumbnails. Higher resolution = more
              discriminating (fewer false positives, may miss loose matches).
            </div>
          </div>
        </div>
        <CriterionRow
          label="Filename"
          hint="Exact match or ignore trailing -1, -copy, -edited, etc."
          value={config.name}
          options={NAME_OPTIONS}
          onChange={(v) => setConfig({ ...config, name: v as NameTolerance })}
        />
        <CriterionRow
          label="File size"
          hint="Byte size. Within 1% catches re-encodes; 10% catches heavier edits."
          value={config.size}
          options={SIZE_OPTIONS}
          onChange={(v) => setConfig({ ...config, size: v as SizeTolerance })}
        />
        <CriterionRow
          label="Capture time"
          hint="Timestamp from EXIF. Within 10s catches burst mode."
          value={config.captureTime}
          options={TIME_OPTIONS}
          onChange={(v) => setConfig({ ...config, captureTime: v as TimeTolerance })}
        />

        <div className="flex gap-4 pt-2 border-t border-zinc-100">
          <label className="flex items-center gap-2 text-sm font-medium text-zinc-900 cursor-pointer">
            <input
              type="radio"
              name="logic"
              checked={config.logic === "and"}
              onChange={() => setConfig({ ...config, logic: "and" })}
            />
            AND (all must match)
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-zinc-900 cursor-pointer">
            <input
              type="radio"
              name="logic"
              checked={config.logic === "or"}
              onChange={() => setConfig({ ...config, logic: "or" })}
            />
            OR (any match)
          </label>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2 w-full max-w-md">
        <legend className="text-sm font-semibold text-zinc-900">
          Destination album
        </legend>
        <p className="text-sm text-zinc-700">
          Duplicates get added to this album — open it in Lightroom afterward
          to bulk-delete. Create an empty album in Lightroom first if you
          don&apos;t have one. Your choice is remembered next time.
        </p>
        {albumsLoading && (
          <div className="text-sm text-zinc-700">Loading albums…</div>
        )}
        {albumsError && (
          <div className="text-xs text-red-600">
            Couldn&apos;t load albums: {albumsError}
          </div>
        )}
        {!albumsLoading && !albumsError && albums.length === 0 && (
          <div className="text-sm text-zinc-700">
            No albums found — go to Lightroom, create an empty album, then
            reload this page.
          </div>
        )}
        {albums.length > 0 && (
          <select
            aria-label="Destination album"
            className="rounded border border-zinc-400 px-2 py-1.5 text-sm bg-white text-zinc-900"
            value={destinationAlbumId}
            onChange={(e) => setDestinationAlbumId(e.target.value)}
          >
            <option value="">— Pick an album —</option>
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onPreview}
          disabled={!canStart || previewLoading}
          className="rounded-full border border-zinc-400 px-5 py-2.5 text-sm font-medium bg-white text-zinc-900 hover:bg-zinc-50 disabled:opacity-60"
        >
          {previewLoading ? "Loading preview…" : "Preview matches"}
        </button>
        <button
          onClick={onStart}
          disabled={!canStart}
          className="rounded-full bg-black text-white px-5 py-2.5 text-sm font-medium hover:bg-zinc-800 disabled:opacity-60"
        >
          Start scan
        </button>
      </div>

      {previewError && (
        <div className="w-full max-w-2xl rounded-md bg-red-50 border border-red-200 text-red-800 px-3 py-2 text-xs">
          {previewError}
        </div>
      )}

      {preview && (
        <div className="w-full flex flex-col gap-3">
          <p className="text-sm text-zinc-700">
            Showing {preview.assets.length} photo{preview.assets.length === 1 ? "" : "s"}
            {preview.hasMore ? " (more match — this is just the first batch)" : ""}.
          </p>
          {preview.assets.length === 0 ? (
            <p className="text-sm text-zinc-700">No photos matched this scope.</p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
              {preview.assets.map((a) => (
                <div
                  key={a.id}
                  className="aspect-square rounded overflow-hidden bg-zinc-100 border border-zinc-200"
                  title={a.fileName ?? a.id}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/lightroom/assets/${a.id}/thumbnail?size=640`}
                    alt={a.fileName ?? a.id}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function DatePicker({
  scope,
  setScope,
}: {
  scope: { kind: "date"; year: number; month?: number; day?: number };
  setScope: (s: Scope) => void;
}) {
  const currentYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = currentYear; y >= 2005; y--) years.push(y);
  const maxDay = scope.month ? daysInMonth(scope.year, scope.month) : 31;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <label className="flex flex-col gap-1 text-sm text-zinc-700">
        Year
        <select
          className="rounded border border-zinc-400 px-2 py-1.5 text-sm bg-white text-zinc-900 min-w-24"
          value={scope.year}
          onChange={(e) =>
            setScope({
              kind: "date",
              year: Number(e.target.value),
              month: scope.month,
              day: scope.day,
            })
          }
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm text-zinc-700">
        Month
        <select
          className="rounded border border-zinc-400 px-2 py-1.5 text-sm bg-white text-zinc-900 min-w-32"
          value={scope.month ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? undefined : Number(e.target.value);
            setScope({
              kind: "date",
              year: scope.year,
              month: v,
              day: v === undefined ? undefined : scope.day,
            });
          }}
        >
          <option value="">All months</option>
          {MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm text-zinc-700">
        Day
        <select
          className="rounded border border-zinc-400 px-2 py-1.5 text-sm bg-white text-zinc-900 min-w-24 disabled:opacity-60"
          value={scope.day ?? ""}
          disabled={!scope.month}
          onChange={(e) =>
            setScope({
              kind: "date",
              year: scope.year,
              month: scope.month,
              day: e.target.value === "" ? undefined : Number(e.target.value),
            })
          }
        >
          <option value="">All days</option>
          {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ScanningPanel({
  stats,
  onCancel,
}: {
  stats: ScanStats;
  onCancel: () => void;
}) {
  const pct = stats.discovered > 0
    ? Math.round(((stats.hashed + stats.failed) / stats.discovered) * 100)
    : 0;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-8 flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Scanning…</h2>
      <div className="w-full bg-zinc-100 rounded-full h-2 overflow-hidden">
        <div
          className="bg-black h-2 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-sm text-zinc-700 tabular-nums">
        {stats.hashed} hashed · {stats.failed} skipped · {stats.discovered} discovered
      </p>
      <button
        onClick={onCancel}
        className="self-start rounded-full border border-zinc-400 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
      >
        Cancel
      </button>
    </section>
  );
}

function ReviewingPanel({
  groups,
  selected,
  existingAlbumIds,
  onToggle,
  totalDuplicates,
  totalToDelete,
  onSubmit,
  onExportCsv,
  onCancel,
}: {
  groups: DuplicateGroup[];
  selected: Set<string>;
  existingAlbumIds: Set<string>;
  onToggle: (id: string) => void;
  totalDuplicates: number;
  totalToDelete: number;
  onSubmit: () => void;
  onExportCsv: () => void;
  onCancel: () => void;
}) {
  if (groups.length === 0) {
    return (
      <section className="rounded-lg border border-zinc-200 bg-white p-8 flex flex-col gap-4">
        <h2 className="text-lg font-semibold">No duplicates found</h2>
        <p className="text-sm text-zinc-700">Your library looks clean.</p>
        <button
          onClick={onCancel}
          className="self-start rounded-full border border-zinc-400 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
        >
          Start over
        </button>
      </section>
    );
  }
  return (
    <>
      <section className="sticky top-0 z-10 -mx-6 px-6 py-3 bg-zinc-50/90 backdrop-blur border-b border-zinc-200 flex items-center justify-between">
        <p className="text-sm text-zinc-700">
          <span className="font-semibold">{groups.length}</span> duplicate group{groups.length === 1 ? "" : "s"} ·{" "}
          <span className="font-semibold">{totalDuplicates}</span> extra photo{totalDuplicates === 1 ? "" : "s"} ·{" "}
          <span className="font-semibold">{totalToDelete}</span> selected for removal
        </p>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="rounded-full border border-zinc-400 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={onExportCsv}
            className="rounded-full bg-black text-white px-4 py-2 text-sm font-medium hover:bg-zinc-800"
          >
            Download CSV
          </button>
          <button
            onClick={onSubmit}
            disabled={totalToDelete === 0}
            title="Adobe hides partner albums from non-recognized apps, so this may not appear in Lightroom."
            className="rounded-full border border-zinc-400 bg-white text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-60"
          >
            Try Lightroom album
          </button>
        </div>
      </section>

      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <GroupCard
            key={g.key}
            group={g}
            selected={selected}
            existingAlbumIds={existingAlbumIds}
            onToggle={onToggle}
          />
        ))}
      </div>
    </>
  );
}

function GroupCard({
  group,
  selected,
  existingAlbumIds,
  onToggle,
}: {
  group: DuplicateGroup;
  selected: Set<string>;
  existingAlbumIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-medium text-zinc-700 mb-3">
        {group.items.length} similar photos
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {group.items.map((item, idx) => {
          const isSelected = selected.has(item.id);
          const isBest = idx === 0;
          const isInAlbum = existingAlbumIds.has(item.id);
          return (
            <label
              key={item.id}
              className={`relative flex flex-col rounded-md border overflow-hidden cursor-pointer transition-colors ${
                isSelected
                  ? "border-red-500 ring-2 ring-red-200"
                  : isInAlbum
                  ? "border-sky-400 ring-2 ring-sky-100"
                  : "border-zinc-200"
              }`}
            >
              <div className="aspect-square bg-zinc-100 relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/lightroom/assets/${item.id}/thumbnail?size=640`}
                  alt={item.fileName ?? item.id}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                {isInAlbum && !isSelected && (
                  <span className="absolute top-1 left-1 rounded-full bg-sky-600 text-white text-[10px] font-medium px-2 py-0.5">
                    In album
                  </span>
                )}
                {!isInAlbum && isBest && !isSelected && (
                  <span className="absolute top-1 left-1 rounded-full bg-emerald-500 text-white text-[10px] font-medium px-2 py-0.5">
                    Keep
                  </span>
                )}
                {isSelected && (
                  <span className="absolute top-1 left-1 rounded-full bg-red-600 text-white text-[10px] font-medium px-2 py-0.5">
                    Trash
                  </span>
                )}
                <input
                  type="checkbox"
                  className="absolute top-2 right-2 h-4 w-4"
                  checked={isSelected}
                  onChange={() => onToggle(item.id)}
                />
              </div>
              <div className="px-2 py-2 text-[11px] leading-tight text-zinc-600">
                <div className="truncate" title={item.fileName ?? item.id}>
                  {item.fileName ?? item.id}
                </div>
                <div className="text-zinc-500">
                  {formatDimensions(item.dimensions)} · {formatSize(item.fileSize)}
                </div>
                {item.captureDate && (
                  <div className="text-zinc-500">{formatDate(item.captureDate)}</div>
                )}
              </div>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function SubmittingPanel({ total }: { total: number }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-8 flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Writing to Lightroom…</h2>
      <p className="text-sm text-zinc-700">
        Creating (or finding) the album and adding {total} photo
        {total === 1 ? "" : "s"}. This may take a moment.
      </p>
    </section>
  );
}

function DonePanel({
  result,
  onReset,
  onExportCsv,
}: {
  result: {
    albumId: string;
    albumName: string;
    created: boolean;
    added: number;
    skipped: number;
    failed: number;
  } | null;
  onReset: () => void;
  onExportCsv: () => void;
}) {
  const directUrl = result
    ? `https://lightroom.adobe.com/albums/${result.albumId}`
    : null;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-8 flex flex-col gap-4 items-start">
      <h2 className="text-lg font-semibold">Done</h2>
      {result ? (
        <div className="text-sm text-zinc-700 space-y-2">
          <p>
            Added <span className="font-semibold">{result.added}</span> new photo
            {result.added === 1 ? "" : "s"} to your Lightroom album{" "}
            <span className="font-semibold">&ldquo;{result.albumName}&rdquo;</span>.
            {result.skipped > 0 &&
              ` ${result.skipped} were already in the album.`}
            {result.failed > 0 && ` ${result.failed} failed.`}
          </p>
          <p className="text-zinc-600">
            Open the album in Lightroom, hit <kbd>Ctrl+A</kbd> (or{" "}
            <kbd>⌘+A</kbd>) to select all, then delete. That&apos;s the actual
            trash step — Adobe&apos;s API doesn&apos;t let us do it directly.
          </p>
        </div>
      ) : (
        <div className="text-sm text-zinc-700 space-y-2">
          <p>Scan complete. Download the CSV below to review + delete manually.</p>
          <p className="text-zinc-600">
            The CSV lists every group and marks which photo in each group is
            the &ldquo;best&rdquo; (highest resolution) plus which ones you
            selected for deletion.
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {directUrl && (
          <a
            href={directUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-black text-white px-5 py-2.5 text-sm font-medium hover:bg-zinc-800"
          >
            Open album in Lightroom ↗
          </a>
        )}
        <button
          onClick={onExportCsv}
          className={`rounded-full px-5 py-2.5 text-sm font-medium ${
            directUrl
              ? "border border-zinc-400 bg-white hover:bg-zinc-50"
              : "bg-black text-white hover:bg-zinc-800"
          }`}
        >
          Download CSV
        </button>
        <button
          onClick={onReset}
          className="rounded-full border border-zinc-400 bg-white text-zinc-900 px-5 py-2.5 text-sm font-medium hover:bg-zinc-50"
        >
          Scan again
        </button>
      </div>
    </section>
  );
}

function CriterionRow({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const enabled = value !== "off";
  return (
    <div className="flex items-start gap-2">
      <input
        type="checkbox"
        className="mt-1"
        checked={enabled}
        aria-label={`Enable ${label}`}
        onChange={(e) =>
          onChange(
            e.target.checked
              ? options.find((o) => o.value !== "off")?.value ?? "off"
              : "off"
          )
        }
      />
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-zinc-900">{label}</span>
          {enabled && (
            <select
              aria-label={`${label} tolerance`}
              className="rounded border border-zinc-400 px-2 py-0.5 text-xs bg-white text-zinc-900"
              value={value}
              onChange={(e) => onChange(e.target.value)}
            >
              {options
                .filter((o) => o.value !== "off")
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </select>
          )}
        </div>
        <div className="text-sm text-zinc-700">{hint}</div>
      </div>
    </div>
  );
}

function formatDimensions(d?: { width?: number; height?: number }): string {
  if (!d?.width || !d?.height) return "?";
  return `${d.width}×${d.height}`;
}

function formatSize(bytes?: number): string {
  if (!bytes) return "?";
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}
