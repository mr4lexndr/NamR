import type { Font } from './opentype';
import type { Poly } from './types';
import { bboxOf } from './types';
import type { Geom } from './clipper';
import { substituteMissing, textToContours } from './text';
import type { Bridge, ConnectOptions } from './connect';
import {
  DEFAULT_CONNECT, connect, solveLinePlacement, tightenLine, translateContours,
} from './connect';
import type { Mesh, SweepOptions } from './sweep';
import { DEFAULT_SWEEP, meshBounds, sweepTag } from './sweep';
import { simplifyPolys } from './simplify';

export type Align = 'center' | 'left' | 'right';

export interface TagParams {
  first: string;
  last: string;
  /** Font height in mm: the type size the lettering is set at. */
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
  /** Ids of automatic links the user has removed. */
  suppressedBridges: string[];
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
  suppressedBridges: [],
  minFeature: 0.8,
};

export interface TagResult {
  /** The font height used, echoed back for the readout. */
  emMm: number;
  /** Ink height of the front line, for comparing against a CAD dimension. */
  frontLineMm: number;
  /** Ink height of both lines combined, i.e. the swept profile. */
  profileMm: number;
  polys: Poly[];
  mesh: Mesh;
  bridges: Bridge[];
  components: number;
  warnings: string[];
  /** The vertical overlap that was used, so the UI can show and override it. */
  overlapY: number;
  /** Horizontal placement of the surname, including any nudge. */
  offsetX: number;
  /** Places the two lines overlap on their own, before any strut. */
  naturalWelds: number;
  /** How many places the two lines are tied together. */
  lineLinks: number;
  substituted: string[];
  bounds: ReturnType<typeof meshBounds>;
  ok: boolean;
}

/**
 * Whole pipeline for one tag: outlines, line placement, welding, decimation,
 * revolve. Everything the app produces goes through here so the preview, the
 * downloaded file and the packed plate can never disagree.
 */
export const buildTag = (font: Font, geom: Geom, params: TagParams): TagResult => {
  const warnings: string[] = [];
  const substituted: string[] = [];

  const em = params.sizeMm;
  const lineOf = (text: string, idx: number) => {
    const sub = substituteMissing(font, text);
    substituted.push(...sub.substituted);
    return textToContours(font, sub.text, idx, { sizeMm: em, tolerance: params.flattenTol }, geom);
  };

  // Connection settings are quoted at a 20mm em; scale them so a tag behaves
  // the same at any size. Areas scale with the square.
  const k = em / 20;
  const conn = {
    ...params.connect,
    letterTighten: params.connect.letterTighten * k,
    tightenOverlap: params.connect.tightenOverlap * k,
    minHoleArea: params.connect.minHoleArea * k * k,
  };

  // Close the gaps inside each line before the lines are positioned, so the
  // overlap search sees the shapes it will actually have to weld.
  const top = tightenLine(lineOf(params.first, 0), geom, conn);
  let bottom = tightenLine(lineOf(params.last, 1), geom, conn);

  if (top.length === 0 && bottom.length === 0) {
    throw new Error('nothing to draw');
  }

  let overlapY = params.overlapY ?? 0;
  let offsetX = params.nudgeX;
  let naturalWelds = 0;

  if (top.length > 0 && bottom.length > 0) {
    const bt = bboxOf(top.map((c) => c.ring));
    const bb = bboxOf(bottom.map((c) => c.ring));
    const align =
      params.align === 'left' ? bt.x0 - bb.x0
      : params.align === 'right' ? bt.x1 - bb.x1
      : (bt.x0 + bt.x1) / 2 - (bb.x0 + bb.x1) / 2;
    bottom = translateContours(bottom, align, 0);

    if (params.overlapY === undefined) {
      const spot = solveLinePlacement(
        geom.union(top.map((c) => c.ring)),
        geom.union(bottom.map((c) => c.ring)),
        geom,
        conn,
        simplifyPolys,
      );
      overlapY = spot.dy;
      offsetX = spot.dx + params.nudgeX;
      naturalWelds = spot.welds;
    }
    bottom = translateContours(bottom, offsetX, overlapY);
  }

  const solved = connect([...top, ...bottom], geom, conn, params.manualBridges, params.suppressedBridges);
  warnings.push(...solved.warnings);
  // Only worth mentioning if bridging did not rescue it: the lines not
  // touching on their own is normal on a light face.
  if (naturalWelds === 0 && solved.lineLinks < conn.minLineLinks) {
    warnings.push('the lines do not overlap; try a deeper line overlap');
  }

  const polys = simplifyPolys(solved.polys, params.simplifyTol);
  if (!geom.survivesErosion(polys, params.minFeature)) {
    warnings.push(`thinner than ${params.minFeature}mm somewhere; it may snap`);
  }

  const mesh = sweepTag(polys, params.sweep);

  const pb = bboxOf(polys.flatMap((p) => [p.outer, ...p.holes]));
  const fb = bottom.length ? bboxOf(bottom.map((c) => c.ring)) : pb;

  return {
    emMm: em,
    frontLineMm: fb.y1 - fb.y0,
    profileMm: pb.y1 - pb.y0,
    polys,
    mesh,
    bridges: solved.bridges,
    components: solved.components,
    lineLinks: solved.lineLinks,
    warnings,
    overlapY,
    offsetX,
    naturalWelds,
    substituted,
    bounds: meshBounds(mesh),
    ok: solved.components === 1,
  };
};
