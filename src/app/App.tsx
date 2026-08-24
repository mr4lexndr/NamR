import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Viewer } from './Viewer';
import { DEFAULT_TAG } from '../geom/tag';
import type { TagParams } from '../geom/tag';
import type { BuildResponse, Request, RequestInit_ } from './worker';

const BUNDLED = [
  { label: 'Yellowtail', file: 'Yellowtail-Regular.ttf' },
  { label: 'Pacifico', file: 'Pacifico-Regular.ttf' },
];

interface Settings {
  first: string;
  last: string;
  frontHeight: number;
  angleDeg: number;
  axisOffset: number;
  weldRadius: number;
  bridgeWidth: number;
  overlapY: number | null;
  nudgeX: number;
}

const INITIAL: Settings = {
  first: 'Ryszard',
  last: 'Jasiński',
  frontHeight: 20,
  angleDeg: 60,
  axisOffset: 5,
  weldRadius: DEFAULT_TAG.connect.weldRadius,
  bridgeWidth: DEFAULT_TAG.connect.bridgeWidth,
  overlapY: null,
  nudgeX: 0,
};

const toParams = (s: Settings): TagParams => ({
  ...DEFAULT_TAG,
  first: s.first,
  last: s.last,
  frontHeight: s.frontHeight,
  nudgeX: s.nudgeX,
  overlapY: s.overlapY ?? undefined,
  connect: { ...DEFAULT_TAG.connect, weldRadius: s.weldRadius, bridgeWidth: s.bridgeWidth },
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

  const worker = useRef<Worker | null>(null);
  const nextId = useRef(1);
  const pending = useRef(new Map<number, (r: BuildResponse) => void>());
  const fontReady = useRef(false);

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<BuildResponse>) => {
      const fn = pending.current.get(ev.data.id);
      if (fn) { pending.current.delete(ev.data.id); fn(ev.data); }
    };
    worker.current = w;
    return () => w.terminate();
  }, []);

  const send = useCallback((req: RequestInit_): Promise<BuildResponse> => {
    const id = nextId.current++;
    return new Promise((resolve) => {
      pending.current.set(id, resolve);
      worker.current?.postMessage({ ...req, id } as Request);
    });
  }, []);

  const loadFontBuffer = useCallback(async (buf: ArrayBuffer, name: string) => {
    const r = await send({ kind: 'font', data: buf });
    if (!r.ok) { setErr(r.error ?? 'could not read that font'); return; }
    fontReady.current = true;
    setFontName(name);
    setErr(null);
  }, [send]);

  // Bundled default face.
  useEffect(() => {
    if (!worker.current) return;
    let dead = false;
    (async () => {
      for (const f of BUNDLED) {
        try {
          const r = await fetch(`${import.meta.env.BASE_URL}fonts/${f.file}`);
          if (!r.ok) continue;
          const buf = await r.arrayBuffer();
          if (dead) return;
          await loadFontBuffer(buf, f.label);
          return;
        } catch { /* try the next one */ }
      }
      if (!dead) { setFontName('none'); setBusy(false); setErr('No bundled font found — drop a .ttf or .otf below.'); }
    })();
    return () => { dead = true; };
  }, [loadFontBuffer]);

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

        <label className="fld"><span>First name</span>
          <input value={s.first} onChange={(e) => setS({ ...s, first: e.target.value })} />
        </label>
        <label className="fld"><span>Surname</span>
          <input value={s.last} onChange={(e) => setS({ ...s, last: e.target.value })} />
        </label>

        <Slider label="Front height" unit="mm" min={8} max={45} step={0.5}
          value={s.frontHeight} onChange={(v) => num('frontHeight', v)}
          hint="Ink height of the surname line" />
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

        <label className="fld"><span>Font — {fontName}</span>
          <input type="file" accept=".ttf,.otf,font/ttf,font/otf"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFont(f); }} />
        </label>
        <p className="note">Your font and the names never leave this browser.</p>

        <div className="row">
          <button className="primary" disabled={busy || !info} onClick={() => void save('3mf')}>Download 3MF</button>
          <button disabled={busy || !info} onClick={() => void save('stl')}>STL</button>
        </div>
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
              <span>{info.dx.toFixed(0)} × {info.dy.toFixed(0)} × {info.dz.toFixed(0)} mm</span>
              <span>{(info.triangles / 1000).toFixed(0)}K tris</span>
              <span>em {info.emMm.toFixed(1)} mm</span>
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
