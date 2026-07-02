export const HASH_RESOLUTIONS = [8, 16, 32, 64] as const;
export type HashResolution = (typeof HASH_RESOLUTIONS)[number];

export async function computeDHash(
  blob: Blob,
  resolution: HashResolution = 8
): Promise<string> {
  const w = resolution + 1;
  const h = resolution;
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: "medium",
  });
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    const totalBits = (w - 1) * h;
    const bits = new Uint8Array(totalBits);
    let bitIdx = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        const left = gray[y * w + x];
        const right = gray[y * w + x + 1];
        bits[bitIdx++] = left < right ? 1 : 0;
      }
    }
    let hex = "";
    for (let i = 0; i < totalBits; i += 4) {
      const nibble =
        (bits[i] << 3) |
        ((bits[i + 1] ?? 0) << 2) |
        ((bits[i + 2] ?? 0) << 1) |
        (bits[i + 3] ?? 0);
      hex += nibble.toString(16);
    }
    return hex;
  } finally {
    bitmap.close();
  }
}

export function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export function hashBitLength(hex: string): number {
  return hex.length * 4;
}
