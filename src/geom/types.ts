/** All app-facing geometry is in millimetres. */
export interface Pt {
  x: number;
  y: number;
}

/** A closed ring. First point is not repeated at the end. */
export type Ring = Pt[];

/** One connected region: an outer ring plus the holes directly inside it. */
export interface Poly {
  outer: Ring;
  holes: Ring[];
}

/**
 * Where a ring came from. The connection solver needs this to attach an
 * i-dot to its own stem rather than to whichever letter happens to be
 * nearest, which is what a plain nearest-neighbour pass would do.
 */
export interface Contour {
  ring: Ring;
  /** Index of the glyph within its line. */
  glyph: number;
  char: string;
  /** 0 = first name (top line), 1 = surname (bottom line). */
  line: number;
  /** True for a detached accent or tittle: a piece needing a stem to its base. */
  isMark: boolean;
}

export const bboxOf = (rings: Ring[]): { x0: number; y0: number; x1: number; y1: number } => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) {
    for (const p of r) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return { x0, y0, x1, y1 };
};

/** Shoelace signed area: positive for counter-clockwise rings. */
export const ringArea = (r: Ring): number => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    a += r[j]!.x * r[i]!.y - r[i]!.x * r[j]!.y;
  }
  return a / 2;
};

export const polyRings = (p: Poly): Ring[] => [p.outer, ...p.holes];
export const allRings = (ps: Poly[]): Ring[] => ps.flatMap(polyRings);
