import type { Contour, Poly, Pt, Ring } from './types';
import { bboxOf, ringArea } from './types';
import type { Geom } from './clipper';

export interface ConnectOptions {
  /** Morphological closing radius. Welds any gap narrower than 2x this. */
  weldRadius: number;
  /** Width of a bridge added between two islands that closing could not reach. */
  bridgeWidth: number;
  /** Width of the stem tying a tittle or accent to its own letter. */
  stemWidth: number;
  /** Bridges longer than this are reported instead of drawn; something is wrong. */
  maxBridgeLength: number;
  /** A weld must be at least this wide to survive printing and handling. */
  minWeldWidth: number;
  /**
   * Ceiling on how far the two lines may be pushed together, as a fraction of
   * the shorter line's height. Without it a light face needs so much overlap
   * to make a wide enough weld that the lines march through each other and
   * the name stops being readable. Past this the links come from bridges.
   */
  maxOverlapFraction: number;
  /**
   * The two lines must meet in at least this many places. One contact is a
   * hinge: the tag flexes there and snaps when handled.
   */
  minLineLinks: number;
  /** Link sites must be at least this far apart, so they brace rather than double up. */
  linkSeparation: number;
  /**
   * How far a letter may be pulled towards its neighbour to close a gap, in
   * mm. Tightening the spacing is what a signwriter would do; a strut across
   * open space is the fallback when the gap is too wide to close by hand.
   */
  letterTighten: number;
  /** How far past first contact to pull, so the join has width. */
  tightenOverlap: number;
  /**
   * Rounds the concave corners where a bridge meets a stroke, so a connector
   * flows into the letter instead of butting against it. Applied after
   * bridging, which is what separates it from `weldRadius`.
   */
  filletRadius: number;
  /**
   * A hole that no single glyph owns is filled only if it is smaller than
   * this, in mm² at a 20mm em. Above it the gap is a deliberate space between
   * letters — the eye of the script — and filling it turns the word solid.
   * Set to 0 to keep every hole.
   */
  minHoleArea: number;
}

export const DEFAULT_CONNECT: ConnectOptions = {
  weldRadius: 0.35,
  bridgeWidth: 1.1,
  stemWidth: 0.9,
  maxBridgeLength: 12,
  minWeldWidth: 0.9,
  maxOverlapFraction: 0.45,
  minLineLinks: 2,
  linkSeparation: 14,
  letterTighten: 1.2,
  tightenOverlap: 0.35,
  filletRadius: 0.25,
  minHoleArea: 4.5,
};

export type BridgeKind = 'stem' | 'auto' | 'manual';

export interface Bridge {
  id: string;
  a: Pt;
  b: Pt;
  width: number;
  kind: BridgeKind;
  /** Populated for stems: which character it serves. */
  label?: string;
}

export interface ConnectResult {
  polys: Poly[];
  bridges: Bridge[];
  /** How many places the two lines are tied together. */
  lineLinks: number;
  /** 1 means the tag is a single printable piece. */
  components: number;
  warnings: string[];
}

const dist2 = (a: Pt, b: Pt): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Nearest point to `p` on segment ab, and its squared distance. */
const nearestOnSeg = (p: Pt, a: Pt, b: Pt): { pt: Pt; d2: number } => {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  const pt = { x: a.x + t * vx, y: a.y + t * vy };
  return { pt, d2: dist2(p, pt) };
};

const ringsOf = (ps: Poly[]): Ring[] => ps.flatMap((p) => [p.outer, ...p.holes]);

/**
 * Closest approach between two polygon sets. The minimum between disjoint
 * polygons is always attained at a vertex-edge pair, so scanning vertices of
 * one against edges of the other in both directions is exact rather than
 * approximate.
 */
export const closestPair = (A: Poly[], B: Poly[]): { a: Pt; b: Pt; dist: number } => {
  const ra = ringsOf(A), rb = ringsOf(B);
  let best = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, d2: Infinity };

  const scan = (verts: Ring[], edges: Ring[], flip: boolean): void => {
    for (const ring of verts) {
      for (const p of ring) {
        for (const e of edges) {
          for (let i = 0, j = e.length - 1; i < e.length; j = i++) {
            const { pt, d2 } = nearestOnSeg(p, e[j]!, e[i]!);
            if (d2 < best.d2) best = flip ? { a: pt, b: p, d2 } : { a: p, b: pt, d2 };
          }
        }
      }
    }
  };
  scan(ra, rb, false);
  scan(rb, ra, true);
  return { a: best.a, b: best.b, dist: Math.sqrt(best.d2) };
};

/**
 * Extend a bridge slightly past both endpoints so its round caps bury
 * themselves in the letters. A capsule that merely touches produces a
 * tangent weld with no width, which prints as a visible seam and snaps.
 */
const overshoot = (a: Pt, b: Pt, by: number): { a: Pt; b: Pt } => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = (dx / len) * by, uy = (dy / len) * by;
  return { a: { x: a.x - ux, y: a.y - uy }, b: { x: b.x + ux, y: b.y + uy } };
};

/**
 * Tie every detached accent to the letter it belongs to. Provenance drives
 * this rather than proximity: on a tight script the tittle of an `i` is often
 * nearer the neighbouring letter than its own stem, and a nearest-neighbour
 * pass would graft it onto the wrong one.
 */
export const markStems = (contours: Contour[], geom: Geom, opts: ConnectOptions): Bridge[] => {
  const bridges: Bridge[] = [];
  const byGlyph = new Map<string, Contour[]>();
  for (const c of contours) {
    const key = `${c.line}:${c.glyph}`;
    const list = byGlyph.get(key);
    if (list) list.push(c);
    else byGlyph.set(key, [c]);
  }

  for (const [key, cs] of byGlyph) {
    const marks = cs.filter((c) => c.isMark);
    if (marks.length === 0) continue;
    const base = cs.filter((c) => !c.isMark);
    if (base.length === 0) continue;

    const basePolys = geom.union(base.map((c) => c.ring));
    // Marks of one glyph can be several islands (a dieresis); stem each.
    for (const island of geom.union(marks.map((c) => c.ring))) {
      const { a, b, dist } = closestPair([island], basePolys);
      if (dist > opts.maxBridgeLength) continue;
      const ends = overshoot(a, b, opts.stemWidth * 0.6);
      bridges.push({
        id: `stem:${key}:${bridges.length}`,
        a: ends.a,
        b: ends.b,
        width: opts.stemWidth,
        kind: 'stem',
        label: cs[0]!.char,
      });
    }
  }
  return bridges;
};

/**
 * Weld whatever islands remain into one piece using a minimum spanning tree
 * over inter-island distance. The MST is what keeps the bridge count minimal:
 * n islands need exactly n-1 bridges, and picking them by shortest distance
 * puts each one where the letters already almost touch.
 */
export const bridgeIslands = (
  polys: Poly[],
  opts: ConnectOptions,
): { bridges: Bridge[]; warnings: string[] } => {
  const bridges: Bridge[] = [];
  const warnings: string[] = [];
  if (polys.length <= 1) return { bridges, warnings };

  const n = polys.length;
  const pair: { a: Pt; b: Pt; dist: number }[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i < j) pair[i]![j] = closestPair([polys[i]!], [polys[j]!]);
    }
  }
  const between = (i: number, j: number) => (i < j ? pair[i]![j]! : pair[j]![i]!);

  // Prim's: grow one tree, always taking the cheapest edge leaving it.
  const inTree = new Set<number>([0]);
  while (inTree.size < n) {
    let best: { i: number; j: number; d: number } | null = null;
    for (const i of inTree) {
      for (let j = 0; j < n; j++) {
        if (inTree.has(j)) continue;
        const d = between(i, j).dist;
        if (!best || d < best.d) best = { i, j, d };
      }
    }
    if (!best) break;
    const link = between(best.i, best.j);
    // closestPair orders its result by the index order it was given.
    const [a, b] = best.i < best.j ? [link.a, link.b] : [link.b, link.a];
    if (best.d > opts.maxBridgeLength) {
      warnings.push(`gap of ${best.d.toFixed(1)}mm exceeds the ${opts.maxBridgeLength}mm bridge limit`);
    } else {
      const ends = overshoot(a, b, opts.bridgeWidth * 0.6);
      bridges.push({
        id: `auto:${best.i}-${best.j}`,
        a: ends.a,
        b: ends.b,
        width: opts.bridgeWidth,
        kind: 'auto',
      });
    }
    inTree.add(best.j);
  }
  return { bridges, warnings };
};

/**
 * Pull letters towards their neighbours until they touch.
 *
 * A script is meant to join up, so a gap between two letters is better closed
 * by tightening the spacing than by bridging across it: the result reads as
 * handwriting rather than as two letters wired together. Each letter may only
 * travel `letterTighten`, and anything still apart after that is left to the
 * bridging pass.
 *
 * Shifts accumulate rightwards, so closing an early gap carries the rest of
 * the word with it and the spacing stays even.
 */
export const tightenLine = (
  contours: Contour[],
  geom: Geom,
  opts: ConnectOptions,
): Contour[] => {
  if (opts.letterTighten <= 0 || contours.length === 0) return contours;

  const order = [...new Set(contours.map((c) => c.glyph))].sort((a, b) => a - b);
  const shift = new Map<number, number>();
  let carry = 0;
  let placed: Poly[] = [];

  for (const g of order) {
    const rings = contours.filter((c) => c.glyph === g).map((c) => c.ring);
    if (rings.length === 0) continue;

    const at = (d: number): Ring[] => rings.map((r) => r.map((p) => ({ x: p.x + d, y: p.y })));
    const islandsWith = (d: number): number =>
      geom.union([...placed.flatMap((p) => [p.outer, ...p.holes]), ...at(d)]).length;

    let dx = carry;
    if (placed.length > 0) {
      const before = islandsWith(carry);
      let budget = opts.letterTighten;
      // A few short steps rather than one guess: the gap is rarely horizontal,
      // so moving by its width does not close it in one go.
      for (let i = 0; i < 5 && budget > 0.01; i++) {
        const { dist } = closestPair(placed, geom.union(at(dx)));
        if (dist < 0.01) break;
        const step = Math.min(dist + opts.tightenOverlap, budget);
        dx -= step;
        budget -= step;
      }
      // Tightening can push a letter into a neighbour's counter, which strands
      // it as an island inside a hole and leaves the word worse off than the
      // gap did. Only keep a shift that actually joined something.
      if (dx !== carry && islandsWith(dx) > before) dx = carry;
    }
    shift.set(g, dx);
    carry = dx;
    placed = geom.union([
      ...placed.flatMap((p) => [p.outer, ...p.holes]),
      ...rings.map((r) => r.map((p) => ({ x: p.x + dx, y: p.y }))),
    ]);
  }

  const tightened = contours.map((c) => {
    const dx = shift.get(c.glyph) ?? 0;
    return dx === 0 ? c : { ...c, ring: c.ring.map((p) => ({ x: p.x + dx, y: p.y })) };
  });

  // Each step was judged against the state it inherited, so a run of locally
  // sensible shifts can still land somewhere worse than not moving at all.
  // Compare the finished word and keep the better one.
  const was = geom.union(contours.map((c) => c.ring)).length;
  const now = geom.union(tightened.map((c) => c.ring)).length;
  return now <= was ? tightened : contours;
};

/**
 * Every enclosed region a glyph can legitimately own, taken one glyph at a
 * time and closed the same way the tag is.
 *
 * Testing against the raw outline alone is not enough: plenty of script
 * capitals draw an open bowl, so the counter only becomes enclosed once
 * welding seals the gap. Yellowtail's R is one, and judging by the raw
 * outline filled it into a solid blob. Closing each glyph in isolation gets
 * that counter back while still refusing anything that needs two glyphs to
 * enclose it, which is exactly what a trapped sliver is.
 */
export const glyphCounters = (
  contours: Contour[],
  geom: Geom,
  opts: ConnectOptions,
): Poly[] => {
  const byGlyph = new Map<string, Ring[]>();
  for (const c of contours) {
    const key = `${c.line}:${c.glyph}`;
    const list = byGlyph.get(key);
    if (list) list.push(c.ring);
    else byGlyph.set(key, [c.ring]);
  }
  const out: Poly[] = [];
  for (const rings of byGlyph.values()) {
    for (const p of geom.close(geom.union(rings), opts.weldRadius)) {
      for (const h of p.holes) out.push({ outer: h, holes: [] });
    }
  }
  return out;
};

/**
 * Drop the slivers welding traps, keep everything that reads as a space.
 *
 * Two tests, and a hole needs to fail both to be filled. Provenance: a
 * counter is enclosed by one glyph on its own, so an open bowl that welding
 * seals still counts. Size: the gap between two adjacent letters is not owned
 * by either of them, but it is the eye of the script and filling it turns the
 * word into a blob. Only a hole that is both foreign and tiny is an artifact.
 */
export const dropTrappedHoles = (
  polys: Poly[],
  counters: Poly[],
  minArea: number,
  geom: Geom,
): Poly[] =>
  polys.map((p) => ({
    outer: p.outer,
    holes: p.holes.filter((h) => {
      const area = Math.abs(ringArea(h));
      if (area >= minArea) return true;
      if (counters.length === 0) return false;
      const hole: Poly[] = [{ outer: h, holes: [] }];
      const kept = geom.difference(hole, geom.difference(hole, counters));
      return geom.area(kept) > area * 0.5;
    }),
  }));

/**
 * Guarantee the two lines are tied together in several places. Natural welds
 * from the overlap count, as do bridges already spanning the gap; whatever is
 * missing gets added at the next-closest approaches, kept `linkSeparation`
 * apart so they brace the tag instead of stacking up in one spot.
 */
export const linkLines = (
  top: Poly[],
  bottom: Poly[],
  geom: Geom,
  opts: ConnectOptions,
): { bridges: Bridge[]; links: number } => {
  const bridges: Bridge[] = [];
  if (top.length === 0 || bottom.length === 0) return { bridges, links: 0 };

  // Existing contact patches: where the two lines already share material.
  const shared = intersect(top, bottom, geom);
  const sites: Pt[] = shared.map((p) => {
    const b = bboxOf([p.outer]);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  });

  // On a short name two links cannot be `linkSeparation` apart, so scale the
  // requirement to the tag and relax it further rather than give up on the
  // second link -- a single contact is the failure worth avoiding.
  const width = bboxOf(ringsOf(top).concat(ringsOf(bottom))).x1
    - bboxOf(ringsOf(top).concat(ringsOf(bottom))).x0;
  let sep = Math.min(opts.linkSeparation, width * 0.35);
  const farEnough = (p: Pt): boolean =>
    sites.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= sep);

  // Candidate contacts, nearest first: every top vertex against the bottom.
  const cands: { a: Pt; b: Pt; d: number }[] = [];
  for (const ring of ringsOf(top)) {
    for (const p of ring) {
      let best = { pt: p, d2: Infinity };
      for (const e of ringsOf(bottom)) {
        for (let i = 0, j = e.length - 1; i < e.length; j = i++) {
          const { pt, d2 } = nearestOnSeg(p, e[j]!, e[i]!);
          if (d2 < best.d2) best = { pt, d2 };
        }
      }
      if (best.d2 < Infinity) cands.push({ a: p, b: best.pt, d: Math.sqrt(best.d2) });
    }
  }
  cands.sort((x, y) => x.d - y.d);

  for (let pass = 0; pass < 3 && sites.length < opts.minLineLinks; pass++) {
    if (pass > 0) sep /= 2;
    for (const c of cands) {
      if (sites.length >= opts.minLineLinks) break;
      if (c.d > opts.maxBridgeLength) break;
      const mid = { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 };
      if (!farEnough(mid)) continue;
      const ends = overshoot(c.a, c.b, opts.bridgeWidth * 0.6);
      bridges.push({
        id: `link:${bridges.length}`,
        a: ends.a, b: ends.b,
        width: opts.bridgeWidth,
        kind: 'auto',
      });
      sites.push(mid);
    }
  }

  return { bridges, links: sites.length };
};

export const applyBridges = (polys: Poly[], bridges: Bridge[], geom: Geom): Poly[] => {
  if (bridges.length === 0) return polys;
  const rings = ringsOf(polys);
  for (const br of bridges) rings.push(...ringsOf(geom.capsule(br.a, br.b, br.width)));
  return geom.union(rings);
};

/**
 * Slide the surname up under the first name until the two lines share a weld
 * at least `minWeldWidth` across. Binary search on the offset: the predicate
 * is monotone because moving the lines together can only ever grow the
 * overlap, so the first offset that welds is the shallowest one that does.
 */
export const solveLineOverlap = (
  top: Poly[],
  bottom: Poly[],
  geom: Geom,
  opts: ConnectOptions,
  extraBite = 0.4,
): { dy: number; welded: boolean } => {
  const tb = bboxOf(ringsOf(top));
  const bb = bboxOf(ringsOf(bottom));

  // Start clear of each other, then close the gap by at most a fraction of
  // the shorter line, so the two never march through one another.
  const clear = tb.y0 - bb.y1;
  const shorter = Math.min(tb.y1 - tb.y0, bb.y1 - bb.y0);
  const maxTravel = shorter * opts.maxOverlapFraction;

  const welds = (dy: number): boolean => {
    const moved = translate(bottom, 0, dy);
    const overlap = intersect(top, moved, geom);
    return overlap.length > 0 && geom.survivesErosion(overlap, opts.minWeldWidth);
  };

  let lo = clear;              // no overlap
  let hi = clear + maxTravel;  // as deep as we allow
  // Not welding at the cap is fine and common on a light face: bridges take
  // over from here.
  if (!welds(hi)) return { dy: hi, welded: false };

  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (welds(mid)) hi = mid;
    else lo = mid;
  }
  return { dy: hi + extraBite, welded: true };
};

export const translate = (polys: Poly[], dx: number, dy: number): Poly[] =>
  polys.map((p) => ({
    outer: p.outer.map((q) => ({ x: q.x + dx, y: q.y + dy })),
    holes: p.holes.map((h) => h.map((q) => ({ x: q.x + dx, y: q.y + dy }))),
  }));

export const translateContours = (cs: Contour[], dx: number, dy: number): Contour[] =>
  cs.map((c) => ({ ...c, ring: c.ring.map((q) => ({ x: q.x + dx, y: q.y + dy })) }));

const intersect = (a: Poly[], b: Poly[], geom: Geom): Poly[] => {
  if (a.length === 0 || b.length === 0) return [];
  // Difference is exact in this wrapper; A n B == A \ (A \ B).
  return geom.difference(a, geom.difference(a, b));
};

/**
 * Full 2D solve for one tag: weld near-misses, stem the accents, then bridge
 * whatever islands are left.
 */
export const connect = (
  contours: Contour[],
  geom: Geom,
  opts: ConnectOptions,
  manual: Bridge[] = [],
): ConnectResult => {
  const warnings: string[] = [];
  const stems = markStems(contours, geom, opts);

  const counters = glyphCounters(contours, geom, opts);

  let polys = geom.union(contours.map((c) => c.ring));
  polys = applyBridges(polys, [...stems, ...manual], geom);
  polys = geom.close(polys, opts.weldRadius);

  const top = geom.union(contours.filter((c) => c.line === 0).map((c) => c.ring));
  const bottom = geom.union(contours.filter((c) => c.line !== 0).map((c) => c.ring));
  const { bridges: links, links: lineLinks } = linkLines(top, bottom, geom, opts);
  polys = applyBridges(polys, links, geom);
  if (lineLinks < opts.minLineLinks) {
    warnings.push(`the two lines meet in only ${lineLinks} place${lineLinks === 1 ? '' : 's'}`);
  }

  const { bridges: auto, warnings: w } = bridgeIslands(polys, opts);
  warnings.push(...w);
  polys = applyBridges(polys, auto, geom);

  // Fillet the bridge junctions, then clear any background the welding
  // trapped. Order matters: filleting can shrink a sliver but rarely closes
  // it, so the hole pass runs last.
  polys = geom.close(polys, opts.filletRadius);
  polys = dropTrappedHoles(polys, counters, opts.minHoleArea, geom);

  // Two strokes meeting at a single point come back from the union as one
  // self-touching ring, so the island pass above sees a shape that is already
  // whole. Filleting resolves the pinch and the piece falls in two. Checking
  // again here catches exactly that: a contact with no width was never a
  // connection worth counting.
  if (polys.length > 1) {
    const { bridges: extra, warnings: w2 } = bridgeIslands(polys, opts);
    warnings.push(...w2);
    polys = applyBridges(polys, extra, geom);
    auto.push(...extra);
  }

  const components = polys.length;
  if (components > 1) warnings.push(`${components} separate pieces remain`);

  return { polys, bridges: [...stems, ...manual, ...links, ...auto], components, lineLinks, warnings };
};
