import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewer } from './Viewer';
import { Batch } from './Batch';
import { DEFAULT_TAG } from '../geom/tag';
import type { TagParams } from '../geom/tag';
import type { BuildResponse, Request, RequestInit_ } from './worker';

/** Open-licensed connected scripts, all verified for full Polish coverage. */
const BUNDLED = [
  { label: 'Yellowtail', file: 'Yellowtail-Regular.ttf', note: 'closest to Brush Script' },
  { label: 'Pacifico', file: 'Pacifico-Regular.ttf', note: 'round, casual' },
  { label: 'Lobster', file: 'Lobster-Regular.ttf', note: 'bold display' },
  { label: 'Damion', file: 'Damion-Regular.ttf', note: 'brush, upright' },
  { label: 'Norican', file: 'Norican-Regular.ttf', note: 'light brush' },
  { label: 'Sacramento', file: 'Sacramento-Regular.ttf', note: 'fine, delicate' },
  { label: 'Alex Brush', file: 'AlexBrush-Regular.ttf', note: 'fine calligraphic' },
  { label: 'Great Vibes', file: 'GreatVibes-Regular.ttf', note: 'formal script' },
];

type SizeMode = 'em' | 'front';

interface Settings {
  first: string;
  last: string;
  sizeMode: SizeMode;
  sizeMm: number;
  frontHeight: number;
  angleDeg: number;
  axisOffset: number;
  weldRadius: number;
  bridgeWidth: number;
  filletRadius: number;
  minHoleArea: number;
  overlapY: number | null;
  nudgeX: number;
}

const INITIAL: Settings = {
  first: 'Ryszard',
  last: 'Jasiński',
  sizeMode: 'em',
  sizeMm: 20,
  frontHeight: 20,
  angleDeg: 60,
  axisOffset: 5,
  weldRadius: DEFAULT_TAG.connect.weldRadius,
  bridgeWidth: DEFAULT_TAG.connect.bridgeWidth,
  filletRadius: DEFAULT_TAG.connect.filletRadius,
  minHoleArea: DEFAULT_TAG.connect.minHoleArea,
  overlapY: null,
  nudgeX: 0,
};

const toParams = (s: Settings): TagParams => ({
  ...DEFAULT_TAG,
  first: s.first,
  last: s.last,
  sizeMm: s.sizeMm,
  frontHeight: s.sizeMode === 'front' ? s.frontHeight : undefined,
  nudgeX: s.nudgeX,
  overlapY: s.overlapY ?? undefined,
  connect: {
    ...DEFAULT_TAG.connect,
    weldRadius: s.weldRadius,
    bridgeWidth: s.bridgeWidth,
    filletRadius: s.filletRadius,
    minHoleArea: s.minHoleArea,
  },
  sweep: { ...DEFAULT_TAG.sweep, angleDeg: s.angleDeg, axisOffset: s.axisOffset },
});

const download = (bytes: Uint8Array, name: string): void => {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

const slug = (s: Settings): string =>
  `${s.first}_${s.last}`.replace(/[^\p{L}\p{N}_-]+/gu, '') || 'tag';

export const App = (): React.ReactElement => {
  const [s, setS] = useState<Settings>(INITIAL);
  const [res, setRes] = useState<BuildResponse | null>(null);
  const [fontName, setFontName] = useState('loading…');
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'single' | 'batch'>('single');

  const worker = useRef<Worker | null>(null);
  const nextId = useRef(1);
  const pending = useRef(new Map<number, { resolve: (r: BuildResponse) => void; onProgress?: (r: BuildResponse) => void }>());
  const fontReady = useRef(false);

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<BuildResponse>) => {
      const entry = pending.current.get(ev.data.id);
      if (!entry) return;
      // Progress messages keep the entry alive; anything else settles it.
      if (ev.data.progress) { entry.onProgress?.(ev.data); return; }
      pending.current.delete(ev.data.id);
      entry.resolve(ev.data);
    };
    worker.current = w;
    return () => w.terminate();
  }, []);

  const send = useCallback(
    (req: RequestInit_, onProgress?: (r: BuildResponse) => void): Promise<BuildResponse> => {
      const id = nextId.current++;
      return new Promise((resolve) => {
        pending.current.set(id, { resolve, onProgress });
        worker.current?.postMessage({ ...req, id } as Request);
      });
    },
    [],
  );

  const loadFontBuffer = useCallback(async (buf: ArrayBuffer, name: string) => {
    const r = await send({ kind: 'font', data: buf });
    if (!r.ok) { setErr(r.error ?? 'could not read that font'); return; }
    fontReady.current = true;
    setFontName(name);
    setErr(null);
  }, [send]);

  const pickBundled = useCallback(async (file: string, label: string) => {
    setBusy(true);
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}fonts/${file}`);
      if (!r.ok) throw new Error(`could not load ${label}`);
      await loadFontBuffer(await r.arrayBuffer(), label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [loadFontBuffer]);

  useEffect(() => {
    if (!worker.current) return;
    void pickBundled(BUNDLED[0]!.file, BUNDLED[0]!.label);
  }, [pickBundled]);

  // Rebuild whenever settings change, coalescing bursts from slider drags.
  const params = useMemo(() => toParams(s), [s]);
  useEffect(() => {
    if (!fontReady.current) return;
    let dead = false;
    setBusy(true);
    const t = setTimeout(async () => {
      const r = await send({ kind: 'build', params });
      if (dead) return;
      if (r.ok) { setRes(r); setErr(null); } else setErr(r.error ?? 'build failed');
      setBusy(false);
    }, 90);
    return () => { dead = true; clearTimeout(t); };
  }, [params, send, fontName]);

  const save = async (fmt: 'stl' | '3mf') => {
    setBusy(true);
    const r = await send({ kind: 'build', params, formats: [fmt] });
    if (r.ok) {
      if (fmt === 'stl' && r.stl) download(r.stl, `${slug(s)}.stl`);
      if (fmt === '3mf' && r.mf) download(r.mf, `${slug(s)}.3mf`);
    } else setErr(r.error ?? 'export failed');
    setBusy(false);
  };

  const onFont = async (file: File) => {
    setBusy(true);
    await loadFontBuffer(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
    setBusy(false);
  };

  const info = res?.info;
  const num = (k: keyof Settings, v: number) => setS((p) => ({ ...p, [k]: v }));

  return (
    <div className="app">
      <aside className="panel">
        <h1>NamR</h1>
        <p className="sub">Script name tags you can print.</p>

        <div className="tabs">
          <button className={tab === 'single' ? 'on' : ''} onClick={() => setTab('single')}>One tag</button>
          <button className={tab === 'batch' ? 'on' : ''} onClick={() => setTab('batch')}>Guest list</button>
        </div>

        {tab === 'batch' ? (
          <Batch params={params} send={send} ready={fontReady.current && !!info} />
        ) : (
        <>
        <label className="fld"><span>First name</span>
          <input value={s.first} onChange={(e) => setS({ ...s, first: e.target.value })} />
        </label>
        <label className="fld"><span>Surname</span>
          <input value={s.last} onChange={(e) => setS({ ...s, last: e.target.value })} />
        </label>

        <div className="seg">
          <button className={s.sizeMode === 'em' ? 'on' : ''}
            onClick={() => setS({ ...s, sizeMode: 'em' })}>Font size</button>
          <button className={s.sizeMode === 'front' ? 'on' : ''}
            onClick={() => setS({ ...s, sizeMode: 'front' })}>Front height</button>
        </div>
        {s.sizeMode === 'em' ? (
          <Slider label="Font size" unit="mm" min={6} max={60} step={0.5}
            value={s.sizeMm} onChange={(v) => num('sizeMm', v)}
            hint="The number you type into Fusion's text Height field" />
        ) : (
          <Slider label="Front height" unit="mm" min={8} max={60} step={0.5}
            value={s.frontHeight} onChange={(v) => num('frontHeight', v)}
            hint="Ink height of the surname line, lowest to highest" />
        )}
        <Slider label="Sweep angle" unit="°" min={0} max={90} step={1}
          value={s.angleDeg} onChange={(v) => num('angleDeg', v)} />
        <Slider label="Axis offset" unit="mm" min={1} max={40} step={0.5}
          value={s.axisOffset} onChange={(v) => num('axisOffset', v)}
          hint="How far the revolve axis sits past the lowest ink" />

        <details>
          <summary>Connection</summary>
          <Slider label="Weld radius" unit="mm" min={0} max={1.5} step={0.05}
            value={s.weldRadius} onChange={(v) => num('weldRadius', v)}
            hint={`Closes gaps up to ${(s.weldRadius * 2).toFixed(2)}mm`} />
          <Slider label="Bridge width" unit="mm" min={0.4} max={3} step={0.05}
            value={s.bridgeWidth} onChange={(v) => num('bridgeWidth', v)} />
          <Slider label="Connector blend" unit="mm" min={0} max={1} step={0.05}
            value={s.filletRadius} onChange={(v) => num('filletRadius', v)}
            hint="Rounds where a connector meets a stroke" />
          <Slider label="Fill holes under" unit="mm²" min={0} max={12} step={0.5}
            value={s.minHoleArea} onChange={(v) => num('minHoleArea', v)}
            hint="Clears slivers trapped between welded strokes" />
          <Slider label="Line overlap" unit="mm" min={-40} max={5} step={0.25}
            value={s.overlapY ?? info?.overlapY ?? 0}
            onChange={(v) => num('overlapY', v)}
            hint={s.overlapY === null ? 'auto — drag to override' : 'manual'} />
          {s.overlapY !== null && (
            <button className="link" onClick={() => setS({ ...s, overlapY: null })}>reset to auto</button>
          )}
          <Slider label="Horizontal nudge" unit="mm" min={-30} max={30} step={0.5}
            value={s.nudgeX} onChange={(v) => num('nudgeX', v)} />
        </details>

        <div className="row">
          <button className="primary" disabled={busy || !info} onClick={() => void save('3mf')}>Download 3MF</button>
          <button disabled={busy || !info} onClick={() => void save('stl')}>STL</button>
        </div>
        </>
        )}

        <label className="fld top"><span>Font</span>
          <select value={BUNDLED.some((b) => b.label === fontName) ? fontName : ''}
            onChange={(e) => {
              const b = BUNDLED.find((q) => q.label === e.target.value);
              if (b) void pickBundled(b.file, b.label);
            }}>
            {BUNDLED.map((b) => <option key={b.label} value={b.label}>{b.label} — {b.note}</option>)}
            {!BUNDLED.some((b) => b.label === fontName) && <option value="">{fontName} (yours)</option>}
          </select>
        </label>
        <label className="fld"><span>…or use your own</span>
          <input type="file" accept=".ttf,.otf,font/ttf,font/otf"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFont(f); }} />
        </label>
        <p className="note">
          Fonts are read in your browser — nothing about your guests is uploaded.
          If you own Brush Script MT, load it here.
        </p>
      </aside>

      <main className="stage">
        <Viewer positions={res?.positions ?? null} indices={res?.indices ?? null} />
        <div className="hud">
          {err && <div className="bad">{err}</div>}
          {info && (
            <>
              <span className={info.components === 1 ? 'ok' : 'bad'}>
                {info.components === 1 ? '1 connected piece' : `${info.components} separate pieces`}
              </span>
              <span className={info.lineLinks >= 2 ? 'ok' : 'warn'}>
                {info.lineLinks} line link{info.lineLinks === 1 ? '' : 's'}
              </span>
              <span>{info.dx.toFixed(0)} × {info.dy.toFixed(0)} × {info.dz.toFixed(0)} mm</span>
              <span>{(info.triangles / 1000).toFixed(0)}K tris</span>
              <span>em {info.emMm.toFixed(1)} · front line {info.frontLineMm.toFixed(1)} · profile {info.profileMm.toFixed(1)} mm</span>
              <span>{info.ms.toFixed(0)} ms</span>
              {busy && <span className="dim">building…</span>}
            </>
          )}
          {info?.substituted.length ? <span className="warn">swapped {info.substituted.join(' ')}</span> : null}
          {info?.warnings.map((w) => <span key={w} className="warn">{w}</span>)}
        </div>
      </main>
    </div>
  );
};

interface SliderProps {
  label: string; unit: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void; hint?: string;
}

const Slider = ({ label, unit, min, max, step, value, onChange, hint }: SliderProps) => (
  <label className="fld">
    <span>{label} <b>{value.toFixed(step < 1 ? 2 : 0)}{unit}</b></span>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(Number(e.target.value))} />
    {hint && <em>{hint}</em>}
  </label>
);
