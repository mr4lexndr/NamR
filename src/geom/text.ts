import { parseFont } from './opentype';
import type { Font, Path } from './opentype';
import type { Contour, Ring } from './types';
import { bboxOf, ringArea } from './types';
import type { Geom } from './clipper';

export interface TextOptions {
  /** Cap-to-baseline size in mm that the em square maps to. */
  sizeMm: number;
  /** Max chord deviation when flattening curves, in mm. */
  tolerance: number;
}

/**
 * Polish letters that some script faces lack as precomposed glyphs. When one
 * is missing we fall back to the bare Latin letter rather than emitting
 * .notdef, which is what the reference sketches do by hand anyway.
 */
const FALLBACK: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z',
};

export interface LoadedFont {
  font: Font;
  familyName: string;
  missingGlyphs: string[];
}

export const loadFont = (data: ArrayBuffer): LoadedFont => {
  const font = parseFont(data);
  return {
    font,
    familyName: font.names.fontFamily?.en ?? font.names.fullName?.en ?? 'Unnamed',
    missingGlyphs: [],
  };
};

/** Substitute characters the font cannot draw, reporting what was swapped. */
export const substituteMissing = (
  font: Font,
  text: string,
): { text: string; substituted: string[] } => {
  const substituted: string[] = [];
  let out = '';
  for (const ch of text) {
    if (font.charToGlyphIndex(ch) !== 0) {
      out += ch;
      continue;
    }
    const alt = FALLBACK[ch] ?? ch.normalize('NFD').replace(/\p{M}/gu, '');
    if (alt && alt !== ch && font.charToGlyphIndex(alt) !== 0) {
      substituted.push(`${ch}->${alt}`);
      out += alt;
    } else {
      substituted.push(`${ch}->?`);
    }
  }
  return { text: out, substituted };
};

/**
 * Flatten one glyph path into closed rings. opentype.js hands back cubic and
 * quadratic segments; subdivision count is chosen per segment from its
 * control-polygon length so the chord error stays under `tolerance`.
 */
const flattenPath = (path: Path, tolerance: number): Ring[] => {
  const rings: Ring[] = [];
  let cur: Ring = [];
  let x = 0, y = 0;

  const steps = (len: number, degree: 2 | 3): number => {
    // Chord error of an n-segment approximation falls as 1/n^2; the constant
    // differs between quadratic and cubic, hence the degree-dependent factor.
    const k = degree === 3 ? 0.125 : 0.0625;
    return Math.max(2, Math.min(96, Math.ceil(Math.sqrt((k * len) / tolerance))));
  };

  for (const c of path.commands) {
    if (c.type === 'M') {
      if (cur.length > 2) rings.push(cur);
      cur = [{ x: c.x, y: c.y }];
      x = c.x; y = c.y;
    } else if (c.type === 'L') {
      cur.push({ x: c.x, y: c.y });
      x = c.x; y = c.y;
    } else if (c.type === 'Q') {
      const n = steps(Math.hypot(c.x1 - x, c.y1 - y) + Math.hypot(c.x - c.x1, c.y - c.y1), 2);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        cur.push({
          x: u * u * x + 2 * u * t * c.x1 + t * t * c.x,
          y: u * u * y + 2 * u * t * c.y1 + t * t * c.y,
        });
      }
      x = c.x; y = c.y;
    } else if (c.type === 'C') {
      const n = steps(
        Math.hypot(c.x1 - x, c.y1 - y) +
          Math.hypot(c.x2 - c.x1, c.y2 - c.y1) +
          Math.hypot(c.x - c.x2, c.y - c.y2),
        3,
      );
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        cur.push({
          x: u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          y: u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        });
      }
      x = c.x; y = c.y;
    } else if (c.type === 'Z') {
      if (cur.length > 2) rings.push(cur);
      cur = [];
    }
  }
  if (cur.length > 2) rings.push(cur);
  return rings;
};

/**
 * Turn a string into tagged contours on a baseline at y = 0, x starting at 0.
 * Y is flipped from font space so the result is y-up like the rest of the app.
 */
export const textToContours = (
  font: Font,
  text: string,
  line: number,
  opts: TextOptions,
  geom: Geom,
): Contour[] => {
  const scale = opts.sizeMm / font.unitsPerEm;
  const tolFontUnits = opts.tolerance / scale;
  const out: Contour[] = [];
  let penX = 0;
  const chars = [...text];

  chars.forEach((ch, i) => {
    const glyph = font.charToGlyph(ch);
    const path = glyph.getPath(penX, 0, font.unitsPerEm);
    const rings = flattenPath(path, tolFontUnits).map((r) =>
      r.map((p) => ({ x: p.x * scale, y: -p.y * scale })),
    );
    for (const c of markSplit(rings, ch, i, line, geom)) out.push(c);

    penX += glyph.advanceWidth ?? 0;
    const next = chars[i + 1];
    if (next) penX += font.getKerningValue(glyph, font.charToGlyph(next));
  });

  return out;
};

/**
 * Split one glyph's rings into base and mark. A glyph whose rings form more
 * than one island -- i and its tittle, n and its acute, a and its ogonek --
 * yields marks for every island but the largest.
 */
const markSplit = (
  rings: Ring[],
  char: string,
  glyph: number,
  line: number,
  geom: Geom,
): Contour[] => {
  if (rings.length === 0) return [];
  const islands = geom.union(rings);
  if (islands.length <= 1) {
    return rings.map((ring) => ({ ring, glyph, char, line, isMark: false }));
  }

  const areas = islands.map((p) => Math.abs(ringArea(p.outer)));
  const biggest = areas.indexOf(Math.max(...areas));

  return islands.flatMap((island, idx) =>
    [island.outer, ...island.holes].map((ring) => ({
      ring,
      glyph,
      char,
      line,
      isMark: idx !== biggest,
    })),
  );
};

export const contoursBBox = (cs: Contour[]) => bboxOf(cs.map((c) => c.ring));
