import earcut from 'earcut';
import type { Poly, Ring } from './types';
import { bboxOf, ringArea } from './types';

export type SweepMode = 'extrude' | 'revolve';

export interface SweepOptions {
  /**
   * 'revolve' is the real tag: the profile sweeps 60 deg about an axis
   * parallel to the baseline, and the name reads off the alpha = 0 face.
   * 'extrude' gives a flat plate of `thickness` instead, useful for a quick
   * proof or a flat-pack variant.
   */
  mode: SweepMode;
  /** Plate thickness for 'extrude', in mm. */
  thickness: number;
  /** Total revolve angle in degrees, for 'revolve'. */
  angleDeg: number;
  /** How far beyond the profile's lowest edge the revolve axis sits, in mm. */
  axisOffset: number;
  /** Max chord deviation of the arc tessellation, in mm. */
  tolerance: number;
  /** Hard override of the segment count; normally derived from `tolerance`. */
  segments?: number;
}

/**
 * Confirmed against ref/AsiaJ.step: all 462 circles in that B-rep share a
 * single axis along X (parallel to the baseline) at a fixed line, radii run
 * 5.000 to 46.534, and max Z / max radius = sin(60 deg) exactly. So the tag is
 * a 60 deg revolve about an axis 5mm past the lowest ink, and the R50 in the
 * reference sketch is construction geometry that does not reach the solid.
 */
export const DEFAULT_SWEEP: SweepOptions = {
  mode: 'revolve',
  thickness: 4,
  angleDeg: 60,
  axisOffset: 5,
  tolerance: 0.02,
};

/**
 * Segments needed so the flat facets stay within `tolerance` of the true arc.
 * A chord subtending theta at radius r sits r(1-cos(theta/2)) inside the arc,
 * so the outermost radius sets the count for the whole tag. A fixed count
 * instead badly over-tessellates: 48 segments holds 0.0015mm at r=25, which
 * buys nothing and costs a 16MB STL.
 */
export const arcSegments = (opts: SweepOptions, rMax: number): number => {
  if (opts.mode === 'extrude') return 1;
  if (opts.segments) return Math.max(1, opts.segments);
  const total = (opts.angleDeg * Math.PI) / 180;
  if (rMax <= 0 || opts.tolerance <= 0) return 64;
  const ratio = Math.min(1, opts.tolerance / rMax);
  const maxStep = 2 * Math.acos(1 - ratio);
  return Math.max(2, Math.min(256, Math.ceil(total / maxStep)));
};

export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * The solid is the flat text profile revolved about an axis running parallel
 * to the baseline, `axisOffset` below the lowest ink. Sweeping a profile
 * along a circular path whose centre lies in the profile plane is the same
 * operation as a revolve, which is why the construction arc's radius drops
 * out -- only the angle and the axis position change the shape.
 *
 * At alpha = 0 the profile lies in the z = 0 plane, so a tag prints with one
 * text face flat on the bed.
 */
export const revolvePoint = (
  x: number,
  y: number,
  alpha: number,
  yAxis: number,
): [number, number, number] => {
  const r = y - yAxis;
  return [x, yAxis + r * Math.cos(alpha), r * Math.sin(alpha)];
};

/** Signed-area convention: outer rings CCW, holes CW. */
const orient = (ring: Ring, wantCCW: boolean): Ring =>
  ringArea(ring) >= 0 === wantCCW ? ring : [...ring].reverse();

/**
 * Build a watertight mesh for one connected profile. Two caps from a shared
 * triangulation plus a quad band per boundary edge; no 3D booleans involved,
 * which is what keeps this fast enough to run per name in a worker.
 */
export const sweepPoly = (poly: Poly, opts: SweepOptions, yAxis: number): Mesh => {
  const outer = orient(poly.outer, true);
  const holes = poly.holes.map((h) => orient(h, false));

  // earcut wants one flat coordinate run with hole start indices.
  const coords: number[] = [];
  const holeIdx: number[] = [];
  for (const p of outer) coords.push(p.x, p.y);
  for (const h of holes) {
    holeIdx.push(coords.length / 2);
    for (const p of h) coords.push(p.x, p.y);
  }
  const capTris = earcut(coords, holeIdx, 2);
  const nProfile = coords.length / 2;

  const total = (opts.angleDeg * Math.PI) / 180;
  let rMax = 0;
  for (let i = 1; i < coords.length; i += 2) rMax = Math.max(rMax, coords[i]! - yAxis);
  const segs = arcSegments(opts, rMax);
  const nRings = segs + 1;

  const positions = new Float32Array(nProfile * nRings * 3);
  for (let s = 0; s < nRings; s++) {
    const base = s * nProfile * 3;
    for (let i = 0; i < nProfile; i++) {
      const x = coords[i * 2]!, y = coords[i * 2 + 1]!;
      let px: number, py: number, pz: number;
      if (opts.mode === 'extrude') {
        px = x; py = y; pz = (opts.thickness * s) / segs;
      } else {
        [px, py, pz] = revolvePoint(x, y, (total * s) / segs, yAxis);
      }
      positions[base + i * 3] = px;
      positions[base + i * 3 + 1] = py;
      positions[base + i * 3 + 2] = pz;
    }
  }

  const idx: number[] = [];
  // Start cap faces -z (winding reversed); end cap faces along the sweep.
  const lastBase = segs * nProfile;
  for (let t = 0; t < capTris.length; t += 3) {
    const [a, b, c] = [capTris[t]!, capTris[t + 1]!, capTris[t + 2]!];
    idx.push(a, c, b);
    idx.push(lastBase + a, lastBase + b, lastBase + c);
  }

  // Walls. Each boundary ring contributes a quad strip; outer and hole rings
  // are already oppositely wound, so one rule gives outward normals for both.
  const ringSpans: { start: number; count: number }[] = [{ start: 0, count: outer.length }];
  holes.forEach((h, i) => ringSpans.push({ start: holeIdx[i]!, count: h.length }));

  for (const { start, count } of ringSpans) {
    for (let s = 0; s < segs; s++) {
      const b0 = s * nProfile, b1 = (s + 1) * nProfile;
      for (let i = 0; i < count; i++) {
        const i0 = start + i, i1 = start + ((i + 1) % count);
        // Wound so the normal is (edge x sweep), which points away from the
        // material for a CCW outer ring and into the void for a CW hole.
        idx.push(b0 + i0, b0 + i1, b1 + i0);
        idx.push(b0 + i1, b1 + i1, b1 + i0);
      }
    }
  }

  return { positions, indices: new Uint32Array(idx) };
};

export const mergeMeshes = (meshes: Mesh[]): Mesh => {
  const nPos = meshes.reduce((a, m) => a + m.positions.length, 0);
  const nIdx = meshes.reduce((a, m) => a + m.indices.length, 0);
  const positions = new Float32Array(nPos);
  const indices = new Uint32Array(nIdx);
  let po = 0, io = 0, vo = 0;
  for (const m of meshes) {
    positions.set(m.positions, po);
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i]! + vo;
    po += m.positions.length;
    io += m.indices.length;
    vo += m.positions.length / 3;
  }
  return { positions, indices };
};

/** Sweep a whole tag. Every component shares one axis so the pieces stay coplanar. */
export const sweepTag = (polys: Poly[], opts: SweepOptions): Mesh => {
  const b = bboxOf(polys.flatMap((p) => [p.outer, ...p.holes]));
  const yAxis = b.y0 - opts.axisOffset;
  return mergeMeshes(polys.map((p) => sweepPoly(p, opts, yAxis)));
};

export const meshBounds = (m: Mesh) => {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i]!, y = m.positions[i + 1]!, z = m.positions[i + 2]!;
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
    if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
  }
  return { x0, y0, z0, x1, y1, z1, dx: x1 - x0, dy: y1 - y0, dz: z1 - z0 };
};

export const translateMesh = (m: Mesh, dx: number, dy: number, dz: number): Mesh => {
  const positions = new Float32Array(m.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i]! += dx;
    positions[i + 1]! += dy;
    positions[i + 2]! += dz;
  }
  return { positions, indices: m.indices };
};
