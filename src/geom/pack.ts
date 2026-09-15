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

const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Length of `s`'s edges lying against the plate edge or an item already placed. */
const touching = (s: Rect, used: Rect[], plate: { w: number; h: number }): number => {
  let t = 0;
  if (s.x < EPS || Math.abs(s.x + s.w - plate.w) < EPS) t += s.h;
  if (s.y < EPS || Math.abs(s.y + s.h - plate.h) < EPS) t += s.w;
  for (const u of used) {
    if (Math.abs(u.x - s.x - s.w) < EPS || Math.abs(u.x + u.w - s.x) < EPS) t += overlap(u.y, u.y + u.h, s.y, s.y + s.h);
    if (Math.abs(u.y - s.y - s.h) < EPS || Math.abs(u.y + u.h - s.y) < EPS) t += overlap(u.x, u.x + u.w, s.x, s.x + s.w);
  }
  return t;
};

/** Scores a candidate spot inside free rectangle `r`; lower wins, the second number breaks ties. */
type Rule = (s: Rect, r: Rect, used: Rect[], plate: { w: number; h: number }) => [number, number];

/** The usual maximal-rectangles heuristics. Which packs a given list best varies, so all are tried. */
const RULES: Rule[] = [
  (s, r) => [Math.min(r.w - s.w, r.h - s.h), Math.max(r.w - s.w, r.h - s.h)],
  (s, r) => [Math.max(r.w - s.w, r.h - s.h), Math.min(r.w - s.w, r.h - s.h)],
  (s, r) => [r.w * r.h - s.w * s.h, Math.min(r.w - s.w, r.h - s.h)],
  (s) => [s.y + s.h, s.x],
  (s, _r, used, plate) => [-touching(s, used, plate), s.y],
];
const [SHORT_SIDE, , , TOP_LEFT, CONTACT] = RULES as [Rule, Rule, Rule, Rule, Rule];

const ORDERS: ((it: PackItem) => number)[] = [
  (it) => Math.max(it.w, it.h) * 1e4 + it.w * it.h * 1e-3,
  (it) => it.w * it.h,
  (it) => Math.min(it.w, it.h) * 1e4 + Math.max(it.w, it.h),
  (it) => it.w + it.h,
];

interface Bin { free: Rect[]; used: Rect[]; placements: Placement[] }

/** Where a w x h item goes in `bin` under `rule`, either way round; unturned wins a tie. */
const bestFit = (bin: Bin, w: number, h: number, rule: Rule, plate: { w: number; h: number }) => {
  let best: (Rect & { rotated: boolean; score: [number, number] }) | null = null;
  for (const r of bin.free) {
    for (const [ww, hh, rotated] of [[w, h, false], [h, w, true]] as const) {
      if (ww > r.w + EPS || hh > r.h + EPS) continue;
      const s = { x: r.x, y: r.y, w: ww, h: hh };
      const score = rule(s, r, bin.used, plate);
      if (!best || score[0] < best.score[0] - EPS
          || (Math.abs(score[0] - best.score[0]) <= EPS && score[1] < best.score[1] - EPS)) {
        best = { ...s, rotated, score };
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

/** One pass: items in the given order, each on the earliest plate it fits. */
const packInOrder = (queue: PackItem[], bed: Bed, rule: Rule): PackResult => {
  // Every item carries its spacing on the far sides, and the plate grows by
  // one spacing so an item against the far edge needs none.
  const plate = { w: bed.width - bed.margin * 2 + bed.spacing, h: bed.depth - bed.margin * 2 + bed.spacing };
  const rejected: number[] = [];
  const bins: Bin[] = [];

  for (const it of queue) {
    const w = it.w + bed.spacing;
    const h = it.h + bed.spacing;
    let bin = bins.find((b) => bestFit(b, w, h, rule, plate));
    if (!bin) {
      bin = { free: [{ x: 0, y: 0, ...plate }], used: [], placements: [] };
      if (!bestFit(bin, w, h, rule, plate)) { rejected.push(it.index); continue; }
      bins.push(bin);
    }
    const spot = bestFit(bin, w, h, rule, plate)!;
    const taken = { x: spot.x, y: spot.y, w: spot.w, h: spot.h };
    bin.free = occupy(bin.free, taken);
    bin.used.push(taken);
    bin.placements.push({
      index: it.index,
      x: bed.margin + spot.x,
      y: bed.margin + spot.y,
      rotated: spot.rotated,
      w: spot.rotated ? it.h : it.w,
      h: spot.rotated ? it.w : it.h,
    });
  }
  return { plates: bins.map((b) => ({ placements: b.placements })), rejected };
};

const turned = (r: PackResult): number => r.plates.reduce((n, p) => n + p.placements.filter((pl) => pl.rotated).length, 0);

/** Fewer plates first; then the emptiest last plate, so the others are fullest; then fewer turned tags. */
const beats = (a: PackResult, b: PackResult): boolean =>
  a.rejected.length !== b.rejected.length ? a.rejected.length < b.rejected.length
  : a.plates.length !== b.plates.length ? a.plates.length < b.plates.length
  : (a.plates.at(-1)?.placements.length ?? 0) !== (b.plates.at(-1)?.placements.length ?? 0)
    ? (a.plates.at(-1)?.placements.length ?? 0) < (b.plates.at(-1)?.placements.length ?? 0)
  : turned(a) < turned(b);

/** Small seeded generator, so the same list always packs the same way. */
const seeded = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Pack tags onto as few plates as possible.
 *
 * Maximal-rectangles packing: every free rectangle is tracked, and a tag may
 * be turned a quarter about Z, which keeps the reading face on the glass.
 * That is what fills the strip left at the end of each row, too narrow for a
 * tag lying flat but deep enough across two rows for a turned one.
 *
 * No single ordering or placement rule wins on every list, so every
 * combination is tried, then a few hundred seeded shuffles of the longest-first
 * order, keeping the best result. On random 40-150 name lists that averages
 * 4.75 plates on a 256mm bed against 5.17 for one fixed rule, where the tags'
 * total area alone would need 4.33. It costs a fraction of a second, next to
 * seconds spent building the tags.
 */
export const packBeds = (items: PackItem[], bed: Bed): PackResult => {
  let best: PackResult | null = null;
  const consider = (r: PackResult): void => { if (!best || beats(r, best)) best = r; };

  for (const order of ORDERS) {
    const queue = [...items].sort((a, b) => order(b) - order(a));
    for (const rule of RULES) consider(packInOrder(queue, bed, rule));
  }

  const longest = [...items].sort((a, b) => ORDERS[0]!(b) - ORDERS[0]!(a));
  const random = seeded(items.length * 7919 + 17);
  // Scaled down for very long lists so packing stays well under a second.
  const shuffles = Math.min(300, Math.floor(40000 / Math.max(1, items.length)));
  for (let s = 0; s < shuffles; s++) {
    const queue = [...longest];
    for (let i = 0; i < queue.length - 1; i++) {
      if (random() < 0.3) {
        const j = Math.min(queue.length - 1, i + 1 + Math.floor(random() * 3));
        [queue[i], queue[j]] = [queue[j]!, queue[i]!];
      }
    }
    for (const rule of [SHORT_SIDE, TOP_LEFT, CONTACT]) consider(packInOrder(queue, bed, rule));
  }

  return best ?? { plates: [], rejected: [] };
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
