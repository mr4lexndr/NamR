import type { Font } from './opentype';
import type { Contour, Poly } from './types';
import { bboxOf } from './types';
import type { Geom } from './clipper';
import { embolden, substituteMissing, textToContours } from './text';
import type { Bridge, ConnectOptions } from './connect';
import type { Band, LinePiece } from './connect';
import {
  DEFAULT_CONNECT, assemble, connectLine, linkLines, solveLinePlacement, tightenLine,
  translateContours, translatePiece,
} from './connect';
import type { Mesh, SweepOptions } from './sweep';
import { DEFAULT_SWEEP, meshBounds, sweepTag } from './sweep';
import { simplifyPolys, simplifyRing } from './simplify';

export type Align = 'center' | 'left' | 'right';

export interface TagParams {
  first: string;
  last: string;
  /** Font height in mm: the type size the lettering is set at. */
  sizeMm: number;
  /** Millimetres added to the width of every stroke, for faces too fine to print. */
  weight: number;
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
  sizeMm: 30,
  weight: 0,
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
    const contours = textToContours(font, sub.text, idx, { sizeMm: em, tolerance: params.flattenTol }, geom);
    return embolden(contours, params.weight, geom);
  };

  // Connection settings are quoted at a 20mm em; scale them so a tag behaves
  // the same at any size. Areas scale with the square.
  const k = em / 20;
  const conn = {
    ...params.connect,
    letterTighten: params.connect.letterTighten * k,
    joinRadius: params.connect.joinRadius * k,
    joinSlack: params.connect.joinSlack * k,
    minHoleArea: params.connect.minHoleArea * k * k,
  };

  // Where script letters join: from a little below the baseline, lower still
  // for thickened strokes, up to half the x-height.
  const x = font.charToGlyph('x');
  const xHeight = (x.index ? x.getBoundingBox().y2 : font.unitsPerEm / 2) * em / font.unitsPerEm;
  const band: Band = { y0: -0.25 * xHeight - params.weight, y1: 0.5 * xHeight };

  // Each line is tightened and joined into one piece on its own before the
  // two are placed, so no letter is held on only through the other line.
  const lineAt = (text: string, idx: number): LinePiece =>
    connectLine(tightenLine(lineOf(text, idx), geom, conn, band), geom, conn, band, params.suppressedBridges);
  const top = lineAt(params.first, 0);
  let bottom = lineAt(params.last, 1);
  const twoLines = top.contours.length > 0 && bottom.contours.length > 0;

  if (top.contours.length === 0 && bottom.contours.length === 0) {
    throw new Error('nothing to draw');
  }

  let overlapY = params.overlapY ?? 0;
  let offsetX = params.nudgeX;
  let naturalWelds = 0;

  if (twoLines) {
    const bt = bboxOf(top.contours.map((c) => c.ring));
    const bb = bboxOf(bottom.contours.map((c) => c.ring));
    const align =
      params.align === 'left' ? bt.x0 - bb.x0
      : params.align === 'right' ? bt.x1 - bb.x1
      : (bt.x0 + bt.x1) / 2 - (bb.x0 + bb.x1) / 2;
    bottom = translatePiece(bottom, align, 0);

    if (params.overlapY === undefined) {
      // The links that would really be added to tie the lines on two letter
      // pairs, each costing more steeply the longer it runs: a short one reads
      // as part of the script, a long one as a wire across the name. A second
      // pair out of reach altogether makes a placement broken, not cheap: the
      // tag would hinge on a single join.
      const thin = (cs: Contour[]): Contour[] =>
        cs.map((c) => ({ ...c, ring: simplifyRing(c.ring, 0.2) })).filter((c) => c.ring.length > 2);
      const topThin = thin(top.contours), bottomThin = thin(bottom.contours);
      const linkCost = (dx: number, dy: number): number => {
        const found = linkLines(topThin, translateContours(bottomThin, dx, dy), geom, conn);
        return Math.max(0, conn.minLineLinks - found.links) * 200 + found.bridges
          // Lengths judged at a 20mm em, like the rest of the connection settings.
          .map((b) => Math.hypot(b.a.x - b.b.x, b.a.y - b.b.y) / k)
          .reduce((sum, len) => sum + len * 1.5 + Math.max(0, len - 2.5) ** 2 * 3, 0);
      };

      const spot = solveLinePlacement(top.polys, bottom.polys, geom, conn, simplifyPolys, linkCost);
      overlapY = spot.dy;
      offsetX = spot.dx + params.nudgeX;
      naturalWelds = spot.welds;
    }
    bottom = translatePiece(bottom, offsetX, overlapY);
  }

  const pieces = [top, bottom].filter((p) => p.contours.length > 0);
  const solved = assemble(pieces, geom, conn, params.manualBridges, params.suppressedBridges);
  warnings.push(...solved.warnings);
  // Only worth mentioning if bridging did not rescue it: the lines not
  // touching on their own is normal on a light face.
  if (twoLines && naturalWelds === 0 && solved.lineLinks < conn.minLineLinks) {
    warnings.push('the lines do not overlap; try a deeper line overlap');
  }

  const polys = simplifyPolys(solved.polys, params.simplifyTol);
  if (!geom.survivesErosion(polys, params.minFeature)) {
    warnings.push(`thinner than ${params.minFeature}mm somewhere; it may snap`);
  }

  const mesh = sweepTag(polys, params.sweep);

  const pb = bboxOf(polys.flatMap((p) => [p.outer, ...p.holes]));
  const fb = bottom.contours.length ? bboxOf(bottom.contours.map((c) => c.ring)) : pb;

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
