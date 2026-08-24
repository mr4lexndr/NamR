import { zipSync } from 'fflate';
import type { Font } from './opentype';
import type { Geom } from './clipper';
import type { TagParams } from './tag';
import { buildTag } from './tag';
import type { NameRow } from './csv';
import type { Bed, Plate } from './pack';
import { footprint, packBeds, placeMesh } from './pack';
import { to3mf, toStl } from './export';
import { mergeMeshes, orientForPrint } from './sweep';
import type { Mesh } from './sweep';

export type Format = 'stl' | '3mf';
export type Grouping = 'plate' | 'tag';

export interface BatchOptions {
  params: Omit<TagParams, 'first' | 'last'>;
  bed: Bed;
  format: Format;
  grouping: Grouping;
}

export interface TagReport {
  index: number;
  first: string;
  last: string;
  ok: boolean;
  components: number;
  warnings: string[];
  substituted: string[];
  w: number;
  h: number;
  /** Flattened rings of the solved outline, for drawing the plate preview. */
  outline?: number[][];
  error?: string;
}

export interface BatchResult {
  reports: TagReport[];
  plates: Plate[];
  rejected: number[];
  files: { name: string; bytes: Uint8Array }[];
  zip: Uint8Array;
}

const slug = (s: string): string =>
  s.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'tag';

/**
 * Build every name, pack the results onto beds, and emit downloadable files.
 * `onProgress` is called per tag so a long guest list can show movement
 * rather than freezing behind one opaque await.
 */
export const buildBatch = (
  font: Font,
  geom: Geom,
  rows: NameRow[],
  opts: BatchOptions,
  onProgress?: (done: number, total: number, report: TagReport) => void,
): BatchResult => {
  const reports: TagReport[] = [];
  const meshes = new Map<number, Mesh>();

  rows.forEach((row, index) => {
    let report: TagReport;
    try {
      const r = buildTag(font, geom, { ...opts.params, first: row.first, last: row.last });
      meshes.set(index, orientForPrint(r.mesh, opts.params.sweep));
      const fp = footprint(r.mesh);
      report = {
        index, first: row.first, last: row.last,
        ok: r.ok, components: r.components,
        warnings: r.warnings, substituted: r.substituted,
        w: fp.w, h: fp.h,
        outline: r.polys.flatMap((p) => [p.outer, ...p.holes].map((ring) => ring.flatMap((q) => [q.x, q.y]))),
      };
    } catch (e) {
      report = {
        index, first: row.first, last: row.last,
        ok: false, components: 0, warnings: [], substituted: [], w: 0, h: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    reports.push(report);
    onProgress?.(index + 1, rows.length, report);
  });

  const packable = reports.filter((r) => meshes.has(r.index)).map((r) => ({ index: r.index, w: r.w, h: r.h }));
  const { plates, rejected } = packBeds(packable, opts.bed);

  const files: { name: string; bytes: Uint8Array }[] = [];

  if (opts.grouping === 'tag') {
    for (const r of reports) {
      const mesh = meshes.get(r.index);
      if (!mesh) continue;
      const base = `${String(r.index + 1).padStart(3, '0')}_${slug(`${r.first} ${r.last}`)}`;
      files.push(
        opts.format === 'stl'
          ? { name: `${base}.stl`, bytes: toStl(mesh, `${r.first} ${r.last}`) }
          : { name: `${base}.3mf`, bytes: to3mf([{ mesh, name: `${r.first} ${r.last}` }], [{ objectIndex: 0 }]) },
      );
    }
  } else {
    plates.forEach((plate, p) => {
      const placed = plate.placements.map((pl) => ({
        mesh: placeMesh(meshes.get(pl.index)!, pl),
        name: `${reports[pl.index]!.first} ${reports[pl.index]!.last}`,
      }));
      const name = `plate-${String(p + 1).padStart(2, '0')}`;
      files.push(
        opts.format === 'stl'
          // STL has no notion of separate objects, so a plate has to be one
          // merged soup of triangles.
          ? { name: `${name}.stl`, bytes: toStl(mergeMeshes(placed.map((x) => x.mesh)), name) }
          : { name: `${name}.3mf`, bytes: to3mf(placed, placed.map((_, i) => ({ objectIndex: i }))) },
      );
    });
  }

  const manifest = [
    '#,first,last,pieces,width_mm,depth_mm,plate,notes',
    ...reports.map((r) => {
      const plateNo = plates.findIndex((p) => p.placements.some((pl) => pl.index === r.index));
      const notes = [...r.warnings, ...(r.substituted.length ? [`swapped ${r.substituted.join(' ')}`] : []),
        ...(r.error ? [r.error] : [])].join('; ');
      return [r.index + 1, r.first, r.last, r.components, r.w.toFixed(1), r.h.toFixed(1),
        plateNo >= 0 ? plateNo + 1 : '', `"${notes.replace(/"/g, '""')}"`].join(',');
    }),
  ].join('\n');

  const entries: Record<string, Uint8Array> = { 'manifest.csv': new TextEncoder().encode(manifest) };
  for (const f of files) entries[f.name] = f.bytes;

  return { reports, plates, rejected, files, zip: zipSync(entries, { level: 6 }) };
};
