import { useMemo, useRef, useState } from 'react';
import type { TagParams } from '../geom/tag';
import { parseNames } from '../geom/csv';
import type { NameRow } from '../geom/csv';
import { DEFAULT_BED } from '../geom/pack';
import type { Bed, Plate } from '../geom/pack';
import type { Format, Grouping, TagReport } from '../geom/batch';
import type { BuildResponse, RequestInit_ } from './worker';

interface Props {
  params: Omit<TagParams, 'first' | 'last'>;
  send: (req: RequestInit_, onProgress?: (r: BuildResponse) => void) => Promise<BuildResponse>;
  ready: boolean;
}

const PRESETS: { label: string; w: number; d: number }[] = [
  { label: 'Bambu A1 / P1 · 256 × 256', w: 256, d: 256 },
  { label: 'Prusa MK4 · 250 × 210', w: 250, d: 210 },
  { label: 'Ender 3 · 220 × 220', w: 220, d: 220 },
  { label: 'A1 mini · 180 × 180', w: 180, d: 180 },
];
const CUSTOM = 'custom';

export const Batch = ({ params, send, ready }: Props): React.ReactElement => {
  const [rows, setRows] = useState<NameRow[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [bed, setBed] = useState<Bed>(DEFAULT_BED);
  const [custom, setCustom] = useState(false);
  const [format, setFormat] = useState<Format>('3mf');
  const [grouping, setGrouping] = useState<Grouping>('plate');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [reports, setReports] = useState<TagReport[]>([]);
  const [plates, setPlates] = useState<Plate[]>([]);
  const [zip, setZip] = useState<Uint8Array | null>(null);
  const paste = useRef<HTMLTextAreaElement>(null);

  const load = (text: string): void => {
    const r = parseNames(text);
    setRows(r.rows);
    setNotes(r.notes);
    setReports([]);
    setPlates([]);
    setZip(null);
  };

  const run = async (): Promise<void> => {
    if (!rows.length) return;
    setRunning(true);
    setDone(0);
    setReports([]);
    setZip(null);
    const res = await send(
      { kind: 'batch', rows, opts: { params, bed, format, grouping } },
      (m) => { if (m.progress) setDone(m.progress.done); },
    );
    if (res.batch) {
      setReports(res.batch.reports);
      setPlates(res.batch.plates);
      setZip(res.batch.zip);
    }
    setRunning(false);
  };

  const save = (): void => {
    if (!zip) return;
    const url = URL.createObjectURL(new Blob([zip as unknown as BlobPart], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `namr-tags-${rows.length}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const problems = useMemo(() => reports.filter((r) => !r.ok || r.warnings.length), [reports]);

  return (
    <div className="batch">
      <label className="fld"><span>Guest list</span>
        <input type="file" accept=".csv,.txt,text/csv,text/plain"
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) load(await f.text()); }} />
      </label>

      <p className="help">
        <b>One guest per line.</b> First name, then surname. Separate the two with a
        comma, semicolon, tab — or just a space.
      </p>
      <pre className="sample">Anna, Kowalska
Piotr Zaręba
Maria Anna;Zielińska</pre>
      <p className="help dimmer">
        A CSV exported from Excel works as-is, header row and all. With a space,
        the last word becomes the surname, so “Maria Anna Zielińska” splits as
        you would expect.
      </p>

      <textarea ref={paste} className="paste" rows={4}
        placeholder={'…or paste your list here'}
        onChange={(e) => load(e.target.value)} />
      {notes.length > 0 && <p className="note">Read: {notes.join(' · ')}</p>}
      {rows.length > 0 && (
        <p className="note">
          First: <b>{rows[0]!.first}</b> / <b>{rows[0]!.last || '(none)'}</b>
          {rows.length > 1 && <> · Last: <b>{rows.at(-1)!.first}</b> / <b>{rows.at(-1)!.last || '(none)'}</b></>}
        </p>
      )}

      <label className="fld"><span>Printer bed</span>
        <select value={custom ? CUSTOM : `${bed.width}x${bed.depth}`}
          onChange={(e) => {
            if (e.target.value === CUSTOM) { setCustom(true); return; }
            const p = PRESETS.find((q) => `${q.w}x${q.d}` === e.target.value);
            if (p) { setCustom(false); setBed({ ...bed, width: p.w, depth: p.d }); }
          }}>
          {PRESETS.map((p) => <option key={p.label} value={`${p.w}x${p.d}`}>{p.label}</option>)}
          <option value={CUSTOM}>Custom…</option>
        </select>
      </label>
      {custom && (
        <div className="two">
          <label className="fld"><span>Width <b>mm</b></span>
            <input type="number" min={20} max={2000} value={bed.width}
              onChange={(e) => setBed({ ...bed, width: Math.max(20, Number(e.target.value) || 0) })} />
          </label>
          <label className="fld"><span>Depth <b>mm</b></span>
            <input type="number" min={20} max={2000} value={bed.depth}
              onChange={(e) => setBed({ ...bed, depth: Math.max(20, Number(e.target.value) || 0) })} />
          </label>
        </div>
      )}

      <div className="two">
        <label className="fld"><span>Spacing <b>{bed.spacing}mm</b></span>
          <input type="range" min={1} max={20} step={1} value={bed.spacing}
            onChange={(e) => setBed({ ...bed, spacing: Number(e.target.value) })} />
        </label>
        <label className="fld"><span>Margin <b>{bed.margin}mm</b></span>
          <input type="range" min={0} max={20} step={1} value={bed.margin}
            onChange={(e) => setBed({ ...bed, margin: Number(e.target.value) })} />
        </label>
      </div>

      <div className="seg">
        <button className={grouping === 'plate' ? 'on' : ''} onClick={() => setGrouping('plate')}>One file per plate</button>
        <button className={grouping === 'tag' ? 'on' : ''} onClick={() => setGrouping('tag')}>One per tag</button>
      </div>
      <div className="seg">
        <button className={format === '3mf' ? 'on' : ''} onClick={() => setFormat('3mf')}>3MF</button>
        <button className={format === 'stl' ? 'on' : ''} onClick={() => setFormat('stl')}>STL</button>
      </div>

      <button className="primary wide" disabled={!ready || running || !rows.length} onClick={() => void run()}>
        {running ? `Building ${done}/${rows.length}…` : `Generate ${rows.length || ''} tag${rows.length === 1 ? '' : 's'}`}
      </button>

      {plates.length > 0 && (
        <>
          <div className="plates">
            {plates.map((p, i) => (
              <figure key={i}>
                <svg viewBox={`0 0 ${bed.width} ${bed.depth}`} className="bedmap">
                  <rect x="0" y="0" width={bed.width} height={bed.depth} className="bedbg" />
                  {p.placements.map((pl) => (
                    <rect key={pl.index} x={pl.x} y={pl.y} width={pl.w} height={pl.h} className="slot">
                      <title>{reports[pl.index]?.first} {reports[pl.index]?.last}</title>
                    </rect>
                  ))}
                </svg>
                <figcaption>Plate {i + 1} · {p.placements.length} tags</figcaption>
              </figure>
            ))}
          </div>
          <button className="primary wide" onClick={save} disabled={!zip}>
            Download {plates.length} plate{plates.length === 1 ? '' : 's'} (.zip)
          </button>
          <p className="note">Includes manifest.csv listing every name, its plate and any warning.</p>
        </>
      )}

      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((r) => (
            <li key={r.index} className={r.ok ? 'warn' : 'bad'}>
              <b>{r.first} {r.last}</b> {r.error ?? (r.components > 1 ? `${r.components} pieces` : r.warnings.join('; '))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
