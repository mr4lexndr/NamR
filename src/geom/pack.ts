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

export const DEFAULT_BED: Bed = { width: 220, depth: 220, margin: 5, spacing: 6 };

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

/**
 * Shelf packing, tallest first. Name tags are long and shallow with widths
 * that vary a lot and depths that barely do, so they naturally form full rows;
 * a shelf gives near-optimal use on that shape while staying predictable,
 * which matters because the user has to recognise the plate in their slicer.
 */
export const packBeds = (items: PackItem[], bed: Bed): PackResult => {
  const usableW = bed.width - bed.margin * 2;
  const usableH = bed.depth - bed.margin * 2;
  const rejected: number[] = [];

  const fits = (w: number, h: number): boolean =>
    (w <= usableW && h <= usableH) || (h <= usableW && w <= usableH);

  const queue = items
    .filter((it) => {
      if (fits(it.w, it.h)) return true;
      rejected.push(it.index);
      return false;
    })
    // Rotate each item to lie flat, then sort by height so shelves stay tight.
    .map((it) => (it.w >= it.h ? { ...it, rotated: false } : { index: it.index, w: it.h, h: it.w, rotated: true }))
    .sort((a, b) => b.h - a.h || b.w - a.w);

  const plates: Plate[] = [];
  let plate: Plate = { placements: [] };
  let shelfY = 0;
  let shelfH = 0;
  let cursorX = 0;

  const newPlate = (): void => {
    if (plate.placements.length) plates.push(plate);
    plate = { placements: [] };
    shelfY = 0;
    shelfH = 0;
    cursorX = 0;
  };

  for (const it of queue) {
    let { w, h, rotated } = it;

    // A tall item that will not fit the remaining depth may still fit turned.
    const needsNewShelf = cursorX > 0 && cursorX + bed.spacing + w > usableW;
    if (needsNewShelf) {
      shelfY += shelfH + bed.spacing;
      shelfH = 0;
      cursorX = 0;
    }
    if (shelfY + h > usableH) {
      if (h <= usableW && w <= usableH - shelfY) {
        [w, h] = [h, w];
        rotated = !rotated;
      } else {
        newPlate();
      }
    }

    const x = bed.margin + cursorX;
    const y = bed.margin + shelfY;
    plate.placements.push({ index: it.index, x, y, rotated, w, h });
    cursorX += w + bed.spacing;
    shelfH = Math.max(shelfH, h);
  }
  if (plate.placements.length) plates.push(plate);

  return { plates, rejected };
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
