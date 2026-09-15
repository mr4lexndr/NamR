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
  /** How far around a join's stroke ends counts as the join, mm at a 20mm em. */
  joinRadius: number;
  /**
   * How much further a join near the baseline may be than the nearest
   * approach and still be preferred, mm at a 20mm em. Small: Savoye LET's r
   * has its baseline join only a quarter millimetre further than its top
   * knob, while a crossbar like ł's is a millimetre and more nearer than its
   * foot, and joins best there.
   */
  joinSlack: number;
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
  joinRadius: 2,
  joinSlack: 0.5,
  filletRadius: 0.25,
  minHoleArea: 1,
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
        // Keyed by where it lands, not by discovery order, so removing one
        // still refers to the same link after the tag is rebuilt.
        id: `stem:${key}:${a.x.toFixed(1)},${a.y.toFixed(1)}`,
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
  prefix = 'auto',
  pairOf: (a: Poly[], b: Poly[]) => { a: Pt; b: Pt; dist: number } = closestPair,
): { bridges: Bridge[]; warnings: string[] } => {
  const bridges: Bridge[] = [];
  const warnings: string[] = [];
  if (polys.length <= 1) return { bridges, warnings };

  const n = polys.length;
  const pair: { a: Pt; b: Pt; dist: number }[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i < j) pair[i]![j] = pairOf([polys[i]!], [polys[j]!]);
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
        id: `${prefix}:${a.x.toFixed(1)},${a.y.toFixed(1)}`,
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
 * The height where script letters join, in line coordinates with the
 * baseline at y = 0: from a little below the baseline to half the x-height.
 */
export interface Band { y0: number; y1: number }

const strip = (band: Band): Poly[] =>
  [{ outer: [{ x: -1e4, y: band.y0 }, { x: 1e4, y: band.y0 }, { x: 1e4, y: band.y1 }, { x: -1e4, y: band.y1 }], holes: [] }];

const disk = (c: Pt, r: number): Poly[] =>
  [{ outer: Array.from({ length: 24 }, (_, k) => ({ x: c.x + r * Math.cos((k * Math.PI) / 12), y: c.y + r * Math.sin((k * Math.PI) / 12) })), holes: [] }];

/**
 * Where two neighbouring letters are meant to join: the ends of the exit and
 * entry strokes, found as the nearest approach at the font's own spacing.
 * Near the baseline if there is a join there not much further off, since on a
 * face like Savoye LET the top of an M's last hump sits nearer the next letter
 * than the stroke that actually leads into it.
 */
const joinTips = (A: Poly[], B: Poly[], geom: Geom, band: Band, slack: number): { a: Pt; b: Pt; dist: number } => {
  const nearest = closestPair(A, B);
  if (nearest.dist < 0.01) return nearest;
  const low = strip(band);
  const lowA = intersect(A, low, geom), lowB = intersect(B, low, geom);
  if (lowA.length === 0 || lowB.length === 0) return nearest;
  const inBand = closestPair(lowA, lowB);
  return inBand.dist <= nearest.dist + slack ? inBand : nearest;
};

/**
 * Pull letters towards their neighbours until their strokes join.
 *
 * A script is meant to join up, so a gap between two letters is better closed
 * by tightening the spacing than by bridging across it: the result reads as
 * handwriting rather than as two letters wired together. Each letter may only
 * travel `letterTighten`, and anything still apart after that is left to the
 * bridging pass.
 *
 * It closes the gap between the stroke ends meant to meet, not between
 * whichever points happen to be nearest, and only while the rest of both
 * letters stays clear of the weld. Pulled together by nearest points, the
 * letters of a face drawn apart meet at a shoulder or a bowl — an r fused into
 * the d before it — and trap specks of background that print as blobs. And it
 * stops at contact, leaving the join its width from the weld: pulling further
 * makes strokes that meet at a shallow angle cross, and the lens between the
 * crossings prints as a slit through the stroke.
 *
 * Shifts accumulate rightwards, so closing an early gap carries the rest of
 * the word with it and the spacing stays even.
 */
export const tightenLine = (
  contours: Contour[],
  geom: Geom,
  opts: ConnectOptions,
  band: Band,
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
      const tips = joinTips(placed, geom.union(at(carry)), geom, band, opts.joinSlack);
      const zoneA = disk(tips.a, opts.joinRadius);
      const weldGap = 2 * opts.weldRadius + 0.1;
      /** How far the join's stroke ends are apart, and how near everything else comes. */
      const measure = (d: number): { gap: number; rest: number } | null => {
        const glyph = geom.union(at(d));
        const zoneB = disk({ x: tips.b.x + d - carry, y: tips.b.y }, opts.joinRadius);
        const endA = intersect(placed, zoneA, geom), endB = intersect(glyph, zoneB, geom);
        if (endA.length === 0 || endB.length === 0) return null;
        const restA = geom.difference(placed, zoneA), restB = geom.difference(glyph, zoneB);
        return {
          gap: closestPair(endA, endB).dist,
          rest: Math.min(
            restA.length ? closestPair(restA, glyph).dist : Infinity,
            restB.length ? closestPair(placed, restB).dist : Infinity,
          ),
        };
      };
      let budget = opts.letterTighten;
      const start = tips.dist >= 0.01 ? measure(dx) : null;
      if (start && start.rest > 0 && start.rest < weldGap) {
        // Some other part already sits within welding distance of the
        // neighbour: Savoye LET's r keeps its top knob half a millimetre from
        // the letter before, while the strokes meant to join, down at the
        // baseline, stand further apart. Welded as set, the r hangs off its
        // knob. Easing it just clear leaves the join to be linked stroke to
        // stroke instead.
        dx += Math.min(weldGap - start.rest, budget);
      } else {
        // A few short steps rather than one guess: the gap is rarely
        // horizontal, so moving by its width does not close it in one go.
        for (let i = 0; i < 5 && budget > 0.01 && start; i++) {
          const m = measure(dx);
          if (!m || m.gap < 0.01) break;
          const step = Math.min(m.gap, m.rest - weldGap, budget);
          if (step <= 0.01) break;
          dx -= step;
          budget -= step;
        }
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
  topContours: Contour[],
  bottomContours: Contour[],
  geom: Geom,
  opts: ConnectOptions,
): { bridges: Bridge[]; links: number } => {
  const bridges: Bridge[] = [];
  if (topContours.length === 0 || bottomContours.length === 0) return { bridges, links: 0 };

  const top = geom.union(topContours.map((c) => c.ring));
  const bottom = geom.union(bottomContours.map((c) => c.ring));
  if (top.length === 0 || bottom.length === 0) return { bridges, links: 0 };

  /** Which letter of a line a point belongs to. */
  const owner = (contours: Contour[]) => {
    const byGlyph = new Map<number, Ring[]>();
    for (const c of contours) {
      const list = byGlyph.get(c.glyph);
      if (list) list.push(c.ring);
      else byGlyph.set(c.glyph, [c.ring]);
    }
    const entries = [...byGlyph.entries()];
    return (p: Pt): number => {
      let bestG = -1, bestD = Infinity;
      for (const [g, rings] of entries) {
        for (const r of rings) {
          for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const { d2 } = nearestOnSeg(p, r[j]!, r[i]!);
            if (d2 < bestD) { bestD = d2; bestG = g; }
          }
        }
      }
      return bestG;
    };
  };
  const topGlyph = owner(topContours);
  const bottomGlyph = owner(bottomContours);

  /**
   * A link is only worth counting once per pair of letters.
   *
   * Two welds a few millimetres apart on the same descender look like two
   * connections but brace nothing: the tag still folds along that one letter.
   * Keying by which letter each end lands on is what makes "two links" mean
   * two places the lines are actually held together.
   */
  const held = new Set<string>();
  const letters = new Set<number>();
  const noteSite = (p: Pt): boolean => {
    const key = `${topGlyph(p)}:${bottomGlyph(p)}`;
    if (held.has(key)) return false;
    held.add(key);
    letters.add(topGlyph(p));
    return true;
  };

  for (const patch of intersect(top, bottom, geom)) {
    const b = bboxOf([patch.outer]);
    noteSite({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  }

  const enough = (): boolean => held.size >= opts.minLineLinks && letters.size >= 2;

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

  for (const c of cands) {
    if (enough()) break;
    if (c.d > opts.maxBridgeLength) break;
    const mid = { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 };
    if (!noteSite(mid)) continue;
    const ends = overshoot(c.a, c.b, opts.bridgeWidth * 0.6);
    bridges.push({
      id: `link:${c.a.x.toFixed(1)},${c.a.y.toFixed(1)}`,
      a: ends.a, b: ends.b,
      width: opts.bridgeWidth,
      kind: 'auto',
    });
  }

  return { bridges, links: held.size };
};

export const applyBridges = (polys: Poly[], bridges: Bridge[], geom: Geom): Poly[] => {
  if (bridges.length === 0) return polys;
  const rings = ringsOf(polys);
  for (const br of bridges) rings.push(...ringsOf(geom.capsule(br.a, br.b, br.width)));
  return geom.union(rings);
};

/** How many separate places two lines touch with real width. */
export const countWelds = (
  top: Poly[],
  bottom: Poly[],
  geom: Geom,
  minWidth: number,
): number => {
  const shared = intersect(top, bottom, geom);
  if (shared.length === 0) return 0;
  // Erode to discard tangential kisses, then count what is left standing.
  return geom.offset(shared, -minWidth / 2).length;
};

export interface Placement2D {
  dx: number;
  dy: number;
  welds: number;
  score: number;
}

/**
 * Find where the surname actually wants to sit.
 *
 * Sliding it straight up is the wrong single degree of freedom: two lines of
 * script interlock at particular horizontal offsets, where a descender drops
 * into the gap between two ascenders. Searching sideways as well as vertically
 * finds those, and the pair then joins by overlapping the way the reference
 * sketches do.
 *
 * The search runs on decimated outlines. It evaluates a few hundred
 * placements, and at full resolution that would cost more than the rest of the
 * pipeline put together; the answer is a millimetre-scale offset, so tenth-
 * millimetre detail cannot change it.
 *
 * `linkCost` prices what the rest of the pipeline will still add to tie the
 * lines on two letter pairs. It is too slow to run on every placement, so a
 * shortlist is re-ranked with it: without that the search happily settles on
 * one weld and leaves a long strut to some distant letter.
 */
export const solveLinePlacement = (
  top: Poly[],
  bottom: Poly[],
  geom: Geom,
  opts: ConnectOptions,
  simplify: (p: Poly[], tol: number) => Poly[],
  linkCost?: (dx: number, dy: number) => number,
): Placement2D => {
  const coarse = { T: simplify(top, 0.5), B: simplify(bottom, 0.5) };
  const fine = { T: simplify(top, 0.2), B: simplify(bottom, 0.2) };

  const tb = bboxOf(ringsOf(coarse.T));
  const bb = bboxOf(ringsOf(coarse.B));
  const clear = tb.y0 - bb.y1;
  const shorter = Math.min(tb.y1 - tb.y0, bb.y1 - bb.y0);
  const maxTravel = shorter * opts.maxOverlapFraction;
  // Reach is set by the longer line, not the shorter. Scaling it to the
  // shorter one leaves a short first name — Ala, Ula — barely able to move
  // sideways, which is exactly the case that needs to.
  const span = Math.max(tb.x1 - tb.x0, bb.x1 - bb.x0);
  const areaT = geom.area(coarse.T);
  const areaB = geom.area(coarse.B);
  const areaSum = areaT + areaB;
  const areaMin = Math.max(1, Math.min(areaT, areaB));

  /**
   * Total strut a placement would still need: the minimum spanning tree over
   * whatever islands are left. Counting welds alone is happy to accept a
   * position that welds twice and then leaves a letter stranded across half
   * the tag, and the strut bridging that gap is the thing that looks wrong.
   */
  const strutLength = (P: { T: Poly[]; B: Poly[] }, dx: number, dy: number): number => {
    const islands = geom.union([...ringsOf(P.T), ...ringsOf(translate(P.B, dx, dy))]);
    const n = islands.length;
    if (n <= 1) return 0;
    const inTree = new Set([0]);
    let total = 0;
    while (inTree.size < n) {
      let pick: { j: number; d: number } | null = null;
      for (const i of inTree) {
        for (let j = 0; j < n; j++) {
          if (inTree.has(j)) continue;
          const d = closestPair([islands[i]!], [islands[j]!]).dist;
          if (!pick || d < pick.d) pick = { j, d };
        }
      }
      if (!pick) break;
      total += pick.d;
      inTree.add(pick.j);
    }
    return total;
  };

  /**
   * Cost of one placement.
   *
   * Readability comes first. How much ink the two lines share is the measure,
   * as a fraction of the smaller line so a short name is not drowned by an
   * overlap that would be a sound weld on a long one; it rises steeply past 2%.
   * Earlier weights let a third weld buy several percent more overlap, and the
   * lines were pushed until a first name's letters sat inside the surname's.
   * Welds earn credit only up to the two a tag needs, and a short strut is
   * cheap next to a crowded name.
   */
  const cost = (
    P: { T: Poly[]; B: Poly[] },
    dx: number,
    dy: number,
    ceiling = Infinity,
  ): { score: number; welds: number } => {
    const moved = translate(P.B, dx, dy);
    const welds = countWelds(P.T, moved, geom, opts.minWeldWidth);
    const merged = geom.union([...ringsOf(P.T), ...ringsOf(moved)]);
    const shared = Math.max(0, areaSum - geom.area(merged)) / areaMin;
    const crowding = shared * 250 + Math.max(0, shared - 0.02) ** 2 * 10000;
    const cheap = -Math.min(welds, 2) * 2 + crowding + Math.abs(dx) * 0.06;
    // The island tree is by far the costliest term and can only add to the
    // score, so a placement that cannot make the shortlist without it is
    // dropped unmeasured. That prunes most of the grid.
    if (cheap >= ceiling) return { score: cheap, welds };
    return { score: cheap + strutLength(P, dx, dy), welds };
  };

  // The shortlist for re-ranking: the best few overall, plus the best at each
  // depth. By the cheap score the leaders are all shallow placements that need
  // long links; a deeper one that welds on its own only wins once its links
  // are costed, so it has to be on the list to be costed at all.
  const SHORTLIST = 5;
  let ranked: Placement2D[] = [];
  const bestAtDepth = new Map<number, Placement2D>();
  const consider = (P: { T: Poly[]; B: Poly[] }, dx: number, dy: number, depth?: number): void => {
    const shortlistBar = ranked.length < SHORTLIST ? Infinity : ranked.at(-1)!.score;
    const depthBar = depth === undefined ? -Infinity : (bestAtDepth.get(depth)?.score ?? Infinity);
    const ceiling = Math.max(shortlistBar, depthBar);
    const r = cost(P, dx, dy, ceiling);
    if (r.score >= ceiling) return;
    const c = { dx, dy, welds: r.welds, score: r.score };
    if (depth !== undefined && r.score < depthBar) bestAtDepth.set(depth, c);
    if (r.score < shortlistBar) ranked = [...ranked, c].sort((a, b) => a.score - b.score).slice(0, SHORTLIST);
  };

  // Coarse sweep of both axes on heavily decimated outlines. Depth is stepped
  // finely enough to find the placement just past first contact, which is
  // where the clean ones sit.
  const reach = span * 0.4;
  const DX = 11, DY = 12;
  for (let i = 0; i <= DX; i++) {
    const dx = -reach + (2 * reach * i) / DX;
    for (let j = 1; j <= DY; j++) {
      consider(coarse, dx, clear + (maxTravel * j) / DY, j);
    }
  }
  if (ranked.length === 0) return { dx: 0, dy: clear + maxTravel, welds: 0, score: Infinity };

  // ...then refine around each of the leaders at finer resolution.
  const seeds = ranked;
  ranked = [];
  const stepX = reach / DX, stepY = maxTravel / DY;
  for (const seed of seeds) {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        consider(fine, seed.dx + i * stepX, Math.min(clear + maxTravel, seed.dy + j * stepY));
      }
    }
  }
  if (ranked.length === 0) return seeds[0]!;
  if (!linkCost) return ranked[0]!;

  let pick = ranked[0]!, pickTotal = Infinity;
  for (const c of [...ranked, ...bestAtDepth.values()]) {
    const total = c.score + linkCost(c.dx, c.dy);
    if (total < pickTotal) { pickTotal = total; pick = c; }
  }
  return pick;
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

/** Area-weighted centroid of a set of polygons, holes subtracted. */
const centroid = (polys: Poly[]): Pt => {
  let a = 0, cx = 0, cy = 0;
  for (const r of ringsOf(polys)) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j]!.x * r[i]!.y - r[i]!.x * r[j]!.y;
      a += f;
      cx += (r[j]!.x + r[i]!.x) * f;
      cy += (r[j]!.y + r[i]!.y) * f;
    }
  }
  return a === 0 ? ringsOf(polys)[0]![0]! : { x: cx / (3 * a), y: cy / (3 * a) };
};

/**
 * Reinforce every join between neighbouring letters that is thinner than a
 * connector.
 *
 * Letters pulled together until they touch, or left within welding distance,
 * meet at a point: the weld fills a pinch no wider than the gap was, and it
 * snaps. The connector width never reached those joins, because nothing was
 * added there. Each one now gets a connector of that width laid along the two
 * strokes where they meet, from inside one to inside the other. A join where
 * the strokes already overlap by a connector's width is left alone.
 */
export const braceJoins = (contours: Contour[], geom: Geom, opts: ConnectOptions): Bridge[] => {
  const byGlyph = new Map<number, Ring[]>();
  for (const c of contours) {
    if (c.isMark) continue;
    byGlyph.set(c.glyph, [...(byGlyph.get(c.glyph) ?? []), c.ring]);
  }
  const glyphs = [...byGlyph.keys()].sort((a, b) => a - b).map((g) => geom.union(byGlyph.get(g)!));
  const reach = opts.bridgeWidth;
  const braces: Bridge[] = [];

  for (let i = 0; i + 1 < glyphs.length; i++) {
    const A = glyphs[i]!, B = glyphs[i + 1]!;
    const { a, b, dist } = closestPair(A, B);
    if (dist > 2 * opts.weldRadius) continue;
    const shared = intersect(A, B, geom);
    if (shared.length && geom.survivesErosion(shared, opts.bridgeWidth)) continue;

    const at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const zone = disk(at, reach);
    const nearA = intersect(A, zone, geom), nearB = intersect(B, zone, geom);
    if (!nearA.length || !nearB.length) continue;
    // The middle of each stroke near the join, pulled back onto the stroke if
    // it curves away from its own centroid.
    const onto = (p: Pt, region: Poly[]): Pt =>
      geom.area(intersect(disk(p, 0.05), region, geom)) > 0 ? p : closestPair(disk(p, 0.01), region).b;
    const from = onto(centroid(nearA), nearA), to = onto(centroid(nearB), nearB);
    braces.push({
      id: `brace:${contours[0]!.line}:${at.x.toFixed(1)},${at.y.toFixed(1)}`,
      a: from, b: to,
      width: opts.bridgeWidth,
      kind: 'auto',
    });
  }
  return braces;
};

/** One line of the name, joined into a single piece on its own. */
export interface LinePiece {
  contours: Contour[];
  polys: Poly[];
  bridges: Bridge[];
}

/**
 * Join one line into a single piece: stem the accents, weld near-misses, then
 * bridge whatever letters are still apart.
 *
 * Each line is finished before the two are placed together. Solving both at
 * once let a letter be held on only through the other line, so either name
 * on its own would fall apart.
 */
export const connectLine = (
  contours: Contour[],
  geom: Geom,
  opts: ConnectOptions,
  band: Band,
  suppressed: string[] = [],
): LinePiece => {
  if (contours.length === 0) return { contours, polys: [], bridges: [] };
  const dropped = new Set(suppressed);
  const stems = markStems(contours, geom, opts).filter((b) => !dropped.has(b.id));
  const braces = braceJoins(contours, geom, opts).filter((b) => !dropped.has(b.id));
  let polys = geom.union(contours.map((c) => c.ring));
  polys = applyBridges(polys, [...stems, ...braces], geom);
  polys = geom.close(polys, opts.weldRadius);
  // A letter still apart is linked where its strokes were meant to join, low
  // in the band so the link runs along the baseline like the exit stroke it
  // continues; higher up it cuts diagonally across the valley between letters.
  // Ids are in the line's own coordinates, so an edit still finds its link
  // after the surname has been moved.
  const baseline = { y0: band.y0, y1: band.y0 + (band.y1 - band.y0) * 0.55 };
  const joins = bridgeIslands(
    polys, opts, `join:${contours[0]!.line}`,
    (a, b) => joinTips(a, b, geom, baseline, opts.joinSlack),
  ).bridges.filter((b) => !dropped.has(b.id));
  return { contours, polys: applyBridges(polys, joins, geom), bridges: [...stems, ...braces, ...joins] };
};

export const translatePiece = (piece: LinePiece, dx: number, dy: number): LinePiece => ({
  contours: translateContours(piece.contours, dx, dy),
  polys: translate(piece.polys, dx, dy),
  bridges: piece.bridges.map((b) => ({
    ...b, a: { x: b.a.x + dx, y: b.a.y + dy }, b: { x: b.b.x + dx, y: b.b.y + dy },
  })),
});

/**
 * Put the finished lines together: tie them on two letter pairs, add the
 * user's own links, and make sure what comes out is one printable piece.
 */
export const assemble = (
  pieces: LinePiece[],
  geom: Geom,
  opts: ConnectOptions,
  manual: Bridge[] = [],
  suppressed: string[] = [],
): ConnectResult => {
  const dropped = new Set(suppressed);
  const keep = (b: Bridge): boolean => !dropped.has(b.id);
  const warnings: string[] = [];
  // A link placed or moved by hand follows the connector width in force now,
  // not whatever it was when the link was made.
  const own = manual.map((b) => ({ ...b, width: opts.bridgeWidth }));
  const counters = glyphCounters(pieces.flatMap((p) => p.contours), geom, opts);

  let polys = geom.union(pieces.flatMap((p) => ringsOf(p.polys)));
  polys = applyBridges(polys, own, geom);
  polys = geom.close(polys, opts.weldRadius);

  let links: Bridge[] = [];
  let lineLinks = 0;
  if (pieces.length === 2) {
    const found = linkLines(pieces[0]!.contours, pieces[1]!.contours, geom, opts);
    links = found.bridges.filter(keep);
    lineLinks = found.links - (found.bridges.length - links.length);
    polys = applyBridges(polys, links, geom);
    if (lineLinks < opts.minLineLinks) {
      warnings.push(`the two lines meet in only ${lineLinks} place${lineLinks === 1 ? '' : 's'}`);
    }
  }

  const first = bridgeIslands(polys, opts);
  warnings.push(...first.warnings);
  const auto = first.bridges.filter(keep);
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
  // This pass ignores suppressions: the tag has to come out in one piece, so
  // removing a link may move it rather than delete it outright.
  if (polys.length > 1) {
    const { bridges: extra, warnings: w2 } = bridgeIslands(polys, opts);
    warnings.push(...w2);
    polys = applyBridges(polys, extra, geom);
    auto.push(...extra);
  }

  const components = polys.length;
  if (components > 1) warnings.push(`${components} separate pieces remain`);

  return {
    polys,
    bridges: [...pieces.flatMap((p) => p.bridges), ...own, ...links, ...auto],
    components,
    lineLinks,
    warnings,
  };
};
