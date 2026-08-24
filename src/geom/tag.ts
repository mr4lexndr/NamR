import type opentype from 'opentype.js';
import type { Poly } from './types';
import { bboxOf } from './types';
import type { Geom } from './clipper';
import { substituteMissing, textToContours } from './text';
import type { Bridge, ConnectOptions } from './connect';
import { DEFAULT_CONNECT, connect, solveLineOverlap, translateContours } from './connect';
import type { Mesh, SweepOptions } from './sweep';
import { DEFAULT_SWEEP, meshBounds, sweepTag } from './sweep';
import { simplifyPolys } from './simplify';

export type Align = 'center' | 'left' | 'right';

export interface TagParams {
  first: string;
  last: string;
  /** Height of the em square in mm; the front height of the finished tag. */
  sizeMm: number;
  align: Align;
  /** Horizontal nudge of the surname relative to the first name. */
  nudgeX: number;
  /** Overrides the solved vertical overlap when set. */
  overlapY?: number;
  connect: ConnectOptions;
  sweep: SweepOptions;
  /** Curve flattening tolerance, mm. */
  flattenTol: number;
  /** Profile decimation tolerance, mm. */
  simplifyTol: number;
  manualBridges: Bridge[];
  minFeature: number;
}

export const DEFAULT_TAG: Omit<TagParams, 'first' | 'last'> = {
  sizeMm: 20,
  align: 'center',
  nudgeX: 0,
  connect: DEFAULT_CONNECT,
  sweep: DEFAULT_SWEEP,
  flattenTol: 0.02,
  simplifyTol: 0.02,
  manualBridges: [],
  minFeature: 0.8,
};

export interface TagResult {
  polys: Poly[];
  mesh: Mesh;
  bridges: Bridge[];
  components: number;
  warnings: string[];
  /** The vertical overlap that was used, so the UI can show and override it. */
  overlapY: number;
  substituted: string[];
  bounds: ReturnType<typeof meshBounds>;
  ok: boolean;
}

/**
 * Whole pipeline for one tag: outlines, line placement, welding, decimation,
 * revolve. Everything the app produces goes through here so the preview, the
 * downloaded file and the packed plate can never disagree.
 */
export const buildTag = (font: opentype.Font, geom: Geom, params: TagParams): TagResult => {
  const warnings: string[] = [];
  const substituted: string[] = [];

  const lineOf = (text: string, idx: number) => {
    const sub = substituteMissing(font, text);
    substituted.push(...sub.substituted);
    return textToContours(font, sub.text, idx, { sizeMm: params.sizeMm, tolerance: params.flattenTol }, geom);
  };

  const top = lineOf(params.first, 0);
  let bottom = lineOf(params.last, 1);

  if (top.length === 0 && bottom.length === 0) {
    throw new Error('nothing to draw');
  }

  if (top.length > 0 && bottom.length > 0) {
    const bt = bboxOf(top.map((c) => c.ring));
    const bb = bboxOf(bottom.map((c) => c.ring));
    const dx =
      params.align === 'left' ? bt.x0 - bb.x0
      : params.align === 'right' ? bt.x1 - bb.x1
      : (bt.x0 + bt.x1) / 2 - (bb.x0 + bb.x1) / 2;
    bottom = translateContours(bottom, dx + params.nudgeX, 0);
  }

  let overlapY = params.overlapY ?? 0;
  if (params.overlapY === undefined && top.length > 0 && bottom.length > 0) {
    const solved = solveLineOverlap(
      geom.union(top.map((c) => c.ring)),
      geom.union(bottom.map((c) => c.ring)),
      geom,
      params.connect,
    );
    overlapY = solved.dy;
    if (!solved.welded) warnings.push('the two lines never meet; nudge them closer by hand');
  }
  bottom = translateContours(bottom, 0, overlapY);

  const solved = connect([...top, ...bottom], geom, params.connect, params.manualBridges);
  warnings.push(...solved.warnings);

  const polys = simplifyPolys(solved.polys, params.simplifyTol);
  if (!geom.survivesErosion(polys, params.minFeature)) {
    warnings.push(`thinner than ${params.minFeature}mm somewhere; it may snap`);
  }

  const mesh = sweepTag(polys, params.sweep);

  return {
    polys,
    mesh,
    bridges: solved.bridges,
    components: solved.components,
    warnings,
    overlapY,
    substituted,
    bounds: meshBounds(mesh),
    ok: solved.components === 1,
  };
};
