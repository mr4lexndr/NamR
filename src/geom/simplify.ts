import type { Poly, Ring } from './types';

/**
 * Douglas-Peucker on an open polyline, keeping both endpoints.
 * Iterative rather than recursive: a flattened script glyph can run to a few
 * thousand points and deep recursion on that is a needless risk.
 */
const dpOpen = (pts: Ring, tol: number): Ring => {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];

  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi <= lo + 1) continue;
    const a = pts[lo]!, b = pts[hi]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let far = -1, farD = tol;
    for (let i = lo + 1; i < hi; i++) {
      const p = pts[i]!;
      // Perpendicular distance, degrading to radial when the span is a point.
      const d = len === 0
        ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / len;
      if (d > farD) { farD = d; far = i; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }

  const out: Ring = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]!);
  return out;
};

/**
 * Simplify a closed ring. The ring is cut at its two most distant points
 * before running DP so the result does not depend on where the vertex list
 * happens to start.
 */
export const simplifyRing = (ring: Ring, tol: number): Ring => {
  const n = ring.length;
  if (n <= 4) return ring.slice();

  const a = ring[0]!;
  let far = 0, farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (ring[i]!.x - a.x) ** 2 + (ring[i]!.y - a.y) ** 2;
    if (d > farD) { farD = d; far = i; }
  }

  const first = dpOpen(ring.slice(0, far + 1), tol);
  const second = dpOpen([...ring.slice(far), ring[0]!], tol);
  // Drop the duplicated seam vertices where the two halves rejoin.
  const merged = [...first.slice(0, -1), ...second.slice(0, -1)];
  return merged.length >= 3 ? merged : ring.slice();
};

/**
 * Decimate a solved profile before it is swept. Flattening at 0.02mm plus the
 * round joins from morphological closing leaves several thousand points per
 * tag; at 48 sweep segments that is a third of a million triangles and a
 * 16MB STL for one name. Simplifying first is what makes the output a
 * sensible size, and it also clears the near-degenerate slivers that make
 * ear-clipping drop a triangle.
 */
export const simplifyPolys = (polys: Poly[], tol: number): Poly[] => {
  if (tol <= 0) return polys;
  const out: Poly[] = [];
  for (const p of polys) {
    const outer = simplifyRing(p.outer, tol);
    if (outer.length < 3) continue;
    const holes = p.holes.map((h) => simplifyRing(h, tol)).filter((h) => h.length >= 3);
    out.push({ outer, holes });
  }
  return out;
};

export const countPoints = (polys: Poly[]): number =>
  polys.reduce((a, p) => a + p.outer.length + p.holes.reduce((h, r) => h + r.length, 0), 0);
