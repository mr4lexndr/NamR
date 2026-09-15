import type { Mesh } from './sweep';
import { meshBounds, translateMesh } from './sweep';

export interface Bed {
  width: number;
  depth: number;
  /** Keep-out margin from the bed edge, mm. */
  margin: number;
  /** Gap between neighbouring tags, mm. */
  spacing: number;
}

/** Bambu Lab P2S. */
export const DEFAULT_BED: Bed = { width: 256, depth: 256, margin: 5, spacing: 6 };

export interface Placement {
  index: number;
  x: number;
  y: number;
  rotated: boolean;
  w: number;
  h: number;
}

export interface Plate {
  placements: Placement[];
}

export interface PackItem {
  index: number;
  w: number;
  h: number;
}

export interface PackResult {
  plates: Plate[];
  /** Items that do not fit on an empty bed even rotated. */
  rejected: number[];
}

interface Rect { x: number; y: number; w: number; h: number }

const EPS = 1e-6;

const contains = (a: Rect, b: Rect): boolean =>
  b.x >= a.x - EPS && b.y >= a.y - EPS && b.x + b.w <= a.x + a.w + EPS && b.y + b.h <= a.y + a.h + EPS;

/**
 * The highest free spot a w x h item fits, then the leftmost, either way
 * round. Filling from the top-left keeps plates in tidy rows; a turned tag
 * reaches further down, so it only wins where lying flat does not fit at all.
 */
const bestFit = (free: Rect[], w: number, h: number): (Rect & { rotated: boolean }) | null => {
  let best: (Rect & { rotated: boolean; bottom: number }) | null = null;
  for (const r of free) {
    for (const [ww, hh, rotated] of [[w, h, false], [h, w, true]] as const) {
      if (ww > r.w + EPS || hh > r.h + EPS) continue;
      const bottom = r.y + hh;
      if (!best || bottom < best.bottom - EPS || (Math.abs(bottom - best.bottom) <= EPS && r.x < best.x - EPS)) {
        best = { x: r.x, y: r.y, w: ww, h: hh, rotated, bottom };
      }
    }
  }
  return best;
};

/** Cut `used` out of every free rectangle it overlaps, keeping only maximal leftovers. */
const occupy = (free: Rect[], used: Rect): Rect[] => {
  const out: Rect[] = [];
  for (const r of free) {
    const apart = used.x >= r.x + r.w || used.x + used.w <= r.x || used.y >= r.y + r.h || used.y + used.h <= r.y;
    if (apart) { out.push(r); continue; }
    if (used.x > r.x) out.push({ x: r.x, y: r.y, w: used.x - r.x, h: r.h });
    if (used.x + used.w < r.x + r.w) out.push({ x: used.x + used.w, y: r.y, w: r.x + r.w - used.x - used.w, h: r.h });
    if (used.y > r.y) out.push({ x: r.x, y: r.y, w: r.w, h: used.y - r.y });
    if (used.y + used.h < r.y + r.h) out.push({ x: r.x, y: used.y + used.h, w: r.w, h: r.y + r.h - used.y - used.h });
  }
  return out.filter((a, i) => !out.some((b, j) => j !== i && contains(b, a) && (!contains(a, b) || j < i)));
};

/**
 * Maximal-rectangles packing, longest tags first, each placed on the earliest
 * plate it fits.
 *
 * Rows of name tags leave a strip at the end of every row too narrow for a tag
 * lying along it, but deep enough across two rows for one turned a quarter.
 * Tracking every free rectangle rather than a shelf finds those, and turning
 * is safe: it is about Z, so the reading face stays on the glass. On random
 * guest lists this saves about one plate in seven over shelf packing.
 */
export const packBeds = (items: PackItem[], bed: Bed): PackResult => {
  // Every item carries its spacing on the far sides, and the plate grows by
  // one spacing so an item against the far edge needs none.
  const width = bed.width - bed.margin * 2 + bed.spacing;
  const depth = bed.depth - bed.margin * 2 + bed.spacing;
  const rejected: number[] = [];
  const open: { free: Rect[]; plate: Plate }[] = [];

  const queue = [...items].sort((a, b) =>
    Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);

  for (const it of queue) {
    const w = it.w + bed.spacing;
    const h = it.h + bed.spacing;
    let bin = open.find((b) => bestFit(b.free, w, h));
    if (!bin) {
      bin = { free: [{ x: 0, y: 0, w: width, h: depth }], plate: { placements: [] } };
      if (!bestFit(bin.free, w, h)) { rejected.push(it.index); continue; }
      open.push(bin);
    }
    const spot = bestFit(bin.free, w, h)!;
    bin.free = occupy(bin.free, spot);
    bin.plate.placements.push({
      index: it.index,
      x: bed.margin + spot.x,
      y: bed.margin + spot.y,
      rotated: spot.rotated,
      w: spot.rotated ? it.h : it.w,
      h: spot.rotated ? it.w : it.h,
    });
  }

  return { plates: open.map((b) => b.plate), rejected };
};

/** Footprint of a tag on the bed, before any rotation. */
export const footprint = (mesh: Mesh): { w: number; h: number } => {
  const b = meshBounds(mesh);
  return { w: b.dx, h: b.dy };
};

/**
 * Move a tag into its slot. Rotation is a quarter turn about Z, which keeps
 * the alpha = 0 face on the bed so the part still prints the way it was
 * designed to.
 */
export const placeMesh = (mesh: Mesh, p: Placement): Mesh => {
  const b = meshBounds(mesh);
  let m = translateMesh(mesh, -b.x0, -b.y0, -b.z0);
  if (p.rotated) {
    const out = new Float32Array(m.positions.length);
    for (let i = 0; i < m.positions.length; i += 3) {
      // (x, y) -> (y, -x), then shift back into the positive quadrant.
      out[i] = m.positions[i + 1]!;
      out[i + 1] = b.dx - m.positions[i]!;
      out[i + 2] = m.positions[i + 2]!;
    }
    m = { positions: out, indices: m.indices };
  }
  return translateMesh(m, p.x, p.y, 0);
};
