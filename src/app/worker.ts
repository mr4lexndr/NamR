/// <reference lib="webworker" />
import type { Font } from '../geom/opentype';
import { Geom } from '../geom/clipper';
import { loadFont } from '../geom/text';
import { buildTag } from '../geom/tag';
import type { TagParams } from '../geom/tag';
import { toStl, to3mf } from '../geom/export';
import { orientForPrint } from '../geom/sweep';
import { buildBatch } from '../geom/batch';
import type { BatchOptions, TagReport } from '../geom/batch';
import type { NameRow } from '../geom/csv';
import type { Plate } from '../geom/pack';

export interface BuildRequest {
  id: number;
  kind: 'build';
  params: TagParams;
  /** Also produce downloadable bytes, not just preview geometry. */
  formats?: ('stl' | '3mf')[];
}

export interface BatchRequest {
  id: number;
  kind: 'batch';
  rows: NameRow[];
  opts: BatchOptions;
}

export interface FontRequest {
  id: number;
  kind: 'font';
  data: ArrayBuffer;
}

export type Request = BuildRequest | BatchRequest | FontRequest;

/** Omit distributes over the union so each variant keeps its own fields. */
export type RequestInit_ =
  | Omit<BuildRequest, 'id'>
  | Omit<BatchRequest, 'id'>
  | Omit<FontRequest, 'id'>;

export interface BuildResponse {
  id: number;
  ok: boolean;
  /** Set while a batch is still running; the last message omits it. */
  progress?: { done: number; total: number; report: TagReport };
  batch?: { reports: TagReport[]; plates: Plate[]; rejected: number[]; fileCount: number; zip: Uint8Array };
  error?: string;
  /** Transferable geometry for the preview. */
  positions?: Float32Array;
  indices?: Uint32Array;
  /** Solved 2D outline, for the overlay and the future bridge editor. */
  outline?: number[][];
  bridges?: { id: string; a: { x: number; y: number }; b: { x: number; y: number }; width: number; kind: string }[];
  stl?: Uint8Array;
  mf?: Uint8Array;
  info?: {
    components: number;
    lineLinks: number;
    warnings: string[];
    substituted: string[];
    emMm: number;
    frontLineMm: number;
    profileMm: number;
    overlapY: number;
    triangles: number;
    dx: number;
    dy: number;
    dz: number;
    ms: number;
  };
}

let geom: Geom | null = null;
let font: Font | null = null;

const ready = (async () => {
  geom = await Geom.load();
})();

self.onmessage = async (ev: MessageEvent<Request>) => {
  const req = ev.data;
  await ready;
  try {
    if (req.kind === 'font') {
      font = loadFont(req.data).font;
      post({ id: req.id, ok: true });
      return;
    }

    if (!font) throw new Error('no font loaded');

    if (req.kind === 'batch') {
      const r = buildBatch(font, geom!, req.rows, req.opts, (done, total, report) => {
        post({ id: req.id, ok: true, progress: { done, total, report } });
      });
      post(
        { id: req.id, ok: true,
          batch: { reports: r.reports, plates: r.plates, rejected: r.rejected, fileCount: r.files.length, zip: r.zip } },
        [r.zip.buffer],
      );
      return;
    }

    const t0 = performance.now();
    const r = buildTag(font, geom!, req.params);
    const ms = performance.now() - t0;

    const res: BuildResponse = {
      id: req.id,
      ok: true,
      positions: r.mesh.positions,
      indices: r.mesh.indices,
      outline: r.polys.flatMap((p) =>
        [p.outer, ...p.holes].map((ring) => ring.flatMap((q) => [q.x, q.y])),
      ),
      bridges: r.bridges.map((b) => ({ id: b.id, a: b.a, b: b.b, width: b.width, kind: b.kind })),
      info: {
        components: r.components,
        lineLinks: r.lineLinks,
        warnings: r.warnings,
        substituted: r.substituted,
        emMm: r.emMm,
        frontLineMm: r.frontLineMm,
        profileMm: r.profileMm,
        overlapY: r.overlapY,
        triangles: r.mesh.indices.length / 3,
        dx: r.bounds.dx,
        dy: r.bounds.dy,
        dz: r.bounds.dz,
        ms,
      },
    };
    // Preview keeps the as-built pose; anything downloaded is bedded.
    const printed = req.formats?.length ? orientForPrint(r.mesh, req.params.sweep) : r.mesh;
    if (req.formats?.includes('stl')) res.stl = toStl(printed, `NamR ${req.params.first} ${req.params.last}`);
    if (req.formats?.includes('3mf')) {
      res.mf = to3mf([{ mesh: printed, name: `${req.params.first} ${req.params.last}` }], [{ objectIndex: 0 }]);
    }

    const transfer: Transferable[] = [res.positions!.buffer, res.indices!.buffer];
    if (res.stl) transfer.push(res.stl.buffer);
    if (res.mf) transfer.push(res.mf.buffer);
    post(res, transfer);
  } catch (e) {
    post({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};

const post = (r: BuildResponse, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(r, transfer);
};
