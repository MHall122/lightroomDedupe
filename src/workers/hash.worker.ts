/// <reference lib="webworker" />
import { computeDHash, type HashResolution } from "@/lib/dhash";

export type HashRequest = {
  id: string;
  blob: Blob;
  resolution: HashResolution;
};
export type HashResponse =
  | { id: string; ok: true; hash: string }
  | { id: string; ok: false; error: string };

self.addEventListener("message", async (e: MessageEvent<HashRequest>) => {
  const { id, blob, resolution } = e.data;
  try {
    const hash = await computeDHash(blob, resolution);
    (self as unknown as Worker).postMessage({
      id,
      ok: true,
      hash,
    } satisfies HashResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies HashResponse);
  }
});

export {};
