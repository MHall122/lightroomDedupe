import { hammingDistanceHex, type HashResolution } from "./dhash";

export type NameTolerance = "off" | "exact" | "similar";
export type SizeTolerance = "off" | "exact" | "within_1pct" | "within_10pct";
export type TimeTolerance =
  | "off"
  | "exact"
  | "within_10s"
  | "within_60s"
  | "within_1h";
export type VisualTolerance = "off" | "strict" | "loose";

export type MatchConfig = {
  visual: VisualTolerance;
  visualResolution: HashResolution;
  name: NameTolerance;
  size: SizeTolerance;
  captureTime: TimeTolerance;
  logic: "and" | "or";
};

export const DEFAULT_CONFIG: MatchConfig = {
  visual: "strict",
  visualResolution: 16,
  name: "off",
  size: "off",
  captureTime: "off",
  logic: "and",
};

export const NAME_OPTIONS: { value: NameTolerance; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "exact", label: "Exact" },
  { value: "similar", label: "Similar (ignore -1, -copy, etc.)" },
];

export const SIZE_OPTIONS: { value: SizeTolerance; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "exact", label: "Exact bytes" },
  { value: "within_1pct", label: "Within 1%" },
  { value: "within_10pct", label: "Within 10%" },
];

export const TIME_OPTIONS: { value: TimeTolerance; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "exact", label: "Exact timestamp" },
  { value: "within_10s", label: "Within 10 seconds" },
  { value: "within_60s", label: "Within 60 seconds" },
  { value: "within_1h", label: "Within 1 hour" },
];

export const VISUAL_OPTIONS: { value: VisualTolerance; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "strict", label: "Strict (near-identical)" },
  { value: "loose", label: "Loose (similar scene)" },
];

export type HashedItem = {
  id: string;
  hash?: string;
  fileName?: string;
  captureDate?: string;
  fileSize?: number;
  dimensions?: { width?: number; height?: number };
};

export type DuplicateGroup = {
  key: string;
  items: HashedItem[];
};

export function needsThumbnails(config: MatchConfig): boolean {
  return config.visual !== "off";
}

export function hasAnyCriterion(config: MatchConfig): boolean {
  return (
    config.visual !== "off" ||
    config.name !== "off" ||
    config.size !== "off" ||
    config.captureTime !== "off"
  );
}

// null means the criterion is inapplicable to this pair (missing data on one
// side). We silently drop null results — they neither help nor hurt the match.
function matchVisual(
  a: HashedItem,
  b: HashedItem,
  mode: VisualTolerance
): boolean | null {
  if (mode === "off") return null;
  if (!a.hash || !b.hash) return null;
  if (a.hash.length !== b.hash.length) return null;
  const totalBits = a.hash.length * 4;
  const pct = mode === "strict" ? 0.1 : 0.2;
  const threshold = Math.max(1, Math.round(totalBits * pct));
  return hammingDistanceHex(a.hash, b.hash) <= threshold;
}

function stripNameSuffixes(s: string): string {
  return s
    .replace(/\.[^.]+$/i, "")
    .replace(/[-_\s]?(copy|edited|edit|final|\d+)$/i, "")
    .trim();
}

function matchName(
  a: HashedItem,
  b: HashedItem,
  mode: NameTolerance
): boolean | null {
  if (mode === "off") return null;
  if (!a.fileName || !b.fileName) return null;
  const an = a.fileName.toLowerCase();
  const bn = b.fileName.toLowerCase();
  if (mode === "exact") return an === bn;
  return stripNameSuffixes(an) === stripNameSuffixes(bn);
}

function matchSize(
  a: HashedItem,
  b: HashedItem,
  mode: SizeTolerance
): boolean | null {
  if (mode === "off") return null;
  if (a.fileSize == null || b.fileSize == null) return null;
  if (mode === "exact") return a.fileSize === b.fileSize;
  const larger = Math.max(a.fileSize, b.fileSize);
  const smaller = Math.min(a.fileSize, b.fileSize);
  if (larger === 0) return smaller === 0;
  const pct = (larger - smaller) / larger;
  const bound = mode === "within_1pct" ? 0.01 : 0.1;
  return pct <= bound;
}

function matchTime(
  a: HashedItem,
  b: HashedItem,
  mode: TimeTolerance
): boolean | null {
  if (mode === "off") return null;
  if (!a.captureDate || !b.captureDate) return null;
  if (mode === "exact") return a.captureDate === b.captureDate;
  const ta = new Date(a.captureDate).getTime();
  const tb = new Date(b.captureDate).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  const deltaMs = Math.abs(ta - tb);
  const boundMs =
    mode === "within_10s"
      ? 10_000
      : mode === "within_60s"
      ? 60_000
      : 3_600_000;
  return deltaMs <= boundMs;
}

function pairMatches(
  a: HashedItem,
  b: HashedItem,
  config: MatchConfig
): boolean {
  const results: boolean[] = [];
  const push = (r: boolean | null) => {
    if (r !== null) results.push(r);
  };
  push(matchVisual(a, b, config.visual));
  push(matchName(a, b, config.name));
  push(matchSize(a, b, config.size));
  push(matchTime(a, b, config.captureTime));
  if (results.length === 0) return false;
  return config.logic === "and"
    ? results.every(Boolean)
    : results.some(Boolean);
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function scoreForKeeping(item: HashedItem): number {
  const pixels = (item.dimensions?.width ?? 0) * (item.dimensions?.height ?? 0);
  return pixels * 10 + (item.fileSize ?? 0);
}

export function groupByConfig(
  items: HashedItem[],
  config: MatchConfig
): DuplicateGroup[] {
  if (!hasAnyCriterion(config)) return [];
  const n = items.length;
  const uf = new UnionFind(n);

  // Bucket by visual-hash prefix when visual is enabled, so we only pair
  // items likely to visually match — big speedup on large libraries.
  if (config.visual !== "off" && config.logic === "or") {
    const byPrefix = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const h = items[i].hash;
      if (!h) continue;
      const p = h.slice(0, 4);
      let bucket = byPrefix.get(p);
      if (!bucket) {
        bucket = [];
        byPrefix.set(p, bucket);
      }
      bucket.push(i);
    }
    for (const bucket of byPrefix.values()) {
      for (let x = 0; x < bucket.length; x++) {
        for (let y = x + 1; y < bucket.length; y++) {
          const i = bucket[x];
          const j = bucket[y];
          if (pairMatches(items[i], items[j], config)) uf.union(i, j);
        }
      }
    }
    // Also check non-visual criteria across the full N² since OR means any
    // criterion suffices.
    if (
      config.name !== "off" ||
      config.size !== "off" ||
      config.captureTime !== "off"
    ) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (uf.find(i) === uf.find(j)) continue;
          if (pairMatches(items[i], items[j], config)) uf.union(i, j);
        }
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (pairMatches(items[i], items[j], config)) uf.union(i, j);
      }
    }
  }

  const groupsMap = new Map<number, HashedItem[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    let arr = groupsMap.get(root);
    if (!arr) {
      arr = [];
      groupsMap.set(root, arr);
    }
    arr.push(items[i]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [root, arr] of groupsMap.entries()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => scoreForKeeping(b) - scoreForKeeping(a));
    groups.push({ key: `g${root}`, items: arr });
  }
  groups.sort((a, b) => b.items.length - a.items.length);
  return groups;
}
