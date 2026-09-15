/**
 * A .ttc packs several faces behind one shared header, and opentype.js only
 * reads a single font. macOS ships Savoye LET this way, and a font read from
 * the visitor's own system arrives as the whole collection file.
 *
 * Kept free of opentype.js so the main thread can use it without pulling the
 * parser out of the worker bundle.
 */

const tagAt = (v: DataView, o: number): string =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

/**
 * PostScript name (name ID 6) of the face whose table directory starts at
 * `dir`. Table offsets inside a collection are from the start of the file,
 * so the same reader serves a standalone font with `dir` = 0.
 */
const postscriptName = (v: DataView, dir: number): string | null => {
  const tables = v.getUint16(dir + 4);
  for (let t = 0; t < tables; t++) {
    const rec = dir + 12 + 16 * t;
    if (tagAt(v, rec) !== 'name') continue;
    const base = v.getUint32(rec + 8);
    const count = v.getUint16(base + 2);
    const strings = base + v.getUint16(base + 4);
    for (let k = 0; k < count; k++) {
      const r = base + 6 + 12 * k;
      if (v.getUint16(r + 6) !== 6) continue;
      const platform = v.getUint16(r);
      const len = v.getUint16(r + 8);
      const at = strings + v.getUint16(r + 10);
      let s = '';
      // Unicode and Windows records are UTF-16BE; Macintosh Roman is one byte a character.
      if (platform === 0 || platform === 3) for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(v.getUint16(at + i));
      else for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(at + i));
      return s;
    }
  }
  return null;
};

/** Rebuild one face as a standalone font: its table directory, then every table it points at. */
const extractFace = (data: ArrayBuffer, dir: number): ArrayBuffer => {
  const v = new DataView(data);
  const bytes = new Uint8Array(data);
  const count = v.getUint16(dir + 4);
  const head = 12 + 16 * count;
  const tables = Array.from({ length: count }, (_, t) => ({
    offset: v.getUint32(dir + 12 + 16 * t + 8),
    length: v.getUint32(dir + 12 + 16 * t + 12),
  }));
  const padded = (n: number): number => (n + 3) & ~3;

  const out = new Uint8Array(tables.reduce((n, t) => n + padded(t.length), head));
  const ov = new DataView(out.buffer);
  out.set(bytes.subarray(dir, dir + head), 0);
  let at = head;
  tables.forEach((t, k) => {
    ov.setUint32(12 + 16 * k + 8, at);
    out.set(bytes.subarray(t.offset, t.offset + t.length), at);
    at += padded(t.length);
  });
  return out.buffer;
};

/**
 * The font to parse. A plain font is returned untouched; from a collection,
 * the face named `postscript`, or the first face when none matches.
 */
export const singleFace = (data: ArrayBuffer, postscript?: string): ArrayBuffer => {
  const v = new DataView(data);
  if (data.byteLength < 16 || tagAt(v, 0) !== 'ttcf') return data;
  const dirs = Array.from({ length: v.getUint32(8) }, (_, i) => v.getUint32(12 + 4 * i));
  const dir = dirs.find((d) => postscriptName(v, d) === postscript) ?? dirs[0]!;
  return extractFace(data, dir);
};

/** PostScript name of a font, or of each face in a collection. */
export const postscriptNames = (data: ArrayBuffer): string[] => {
  const v = new DataView(data);
  if (tagAt(v, 0) !== 'ttcf') return [postscriptName(v, 0) ?? ''];
  return Array.from({ length: v.getUint32(8) }, (_, i) => postscriptName(v, v.getUint32(12 + 4 * i)) ?? '');
};
