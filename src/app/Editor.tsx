import { useMemo, useRef, useState } from 'react';
import type { Bridge } from '../geom/connect';
import type { Pt } from '../geom/types';

interface Props {
  outline: number[][];
  bridges: { a: Pt; b: Pt; width: number; kind: string; id: string }[];
  manual: Bridge[];
  suppressed: string[];
  onManualChange: (next: Bridge[]) => void;
  onSuppressedChange: (next: string[]) => void;
  /** Current surname offset, so dragging can nudge from where it is. */
  offset: { x: number; y: number };
  onOffsetChange: (next: { x: number; y: number }) => void;
  onClose: () => void;
}

type Mode = 'link' | 'move';

const PAD = 6;

/**
 * Flat view of the solved outline with direct editing. The 3D preview shows
 * what prints; this shows what is connected to what, which is the thing that
 * actually needs fixing when a tag comes out in two pieces.
 */
export const Editor = ({
  outline, bridges, manual, suppressed, onManualChange, onSuppressedChange,
  offset, onOffsetChange, onClose,
}: Props): React.ReactElement => {
  const [mode, setMode] = useState<Mode>('link');
  const [pending, setPending] = useState<Pt | null>(null);
  const [grab, setGrab] = useState<{ id: string; a: Pt; b: Pt; end: 'a' | 'b' } | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dragFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const view = useMemo(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of outline) {
      for (let i = 0; i < r.length; i += 2) {
        x0 = Math.min(x0, r[i]!); x1 = Math.max(x1, r[i]!);
        y0 = Math.min(y0, r[i + 1]!); y1 = Math.max(y1, r[i + 1]!);
      }
    }
    if (!Number.isFinite(x0)) return { x0: 0, y0: 0, w: 100, h: 50 };
    return { x0: x0 - PAD, y0: y0 - PAD, w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 };
  }, [outline]);

  /**
   * Screen point to model millimetres, via the SVG's own screen matrix.
   * Interpolating across the element instead gets it wrong: the default
   * preserveAspectRatio letterboxes the viewBox, so the drawing does not fill
   * the element and a click lands somewhere other than the cursor.
   */
  const toModel = (e: React.PointerEvent): Pt => {
    const el = svg.current;
    if (!el) return { x: 0, y: 0 };
    const ctm = el.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: -p.y };
  };

  const path = (ring: number[]): string => {
    let d = '';
    for (let i = 0; i < ring.length; i += 2) {
      d += `${i ? 'L' : 'M'}${ring[i]!.toFixed(2)} ${(-ring[i + 1]!).toFixed(2)}`;
    }
    return `${d}Z`;
  };

  /** Turn an automatic link into one of the user's own, at a new position. */
  const rehome = (id: string, a: Pt, b: Pt): void => {
    onManualChange([...manual.filter((m) => m.id !== id),
      { id: id.startsWith('manual:') ? id : `manual:${id}`, a, b, width: 1.1, kind: 'manual' }]);
    if (!id.startsWith('manual:') && !suppressed.includes(id)) onSuppressedChange([...suppressed, id]);
  };

  const remove = (id: string): void => {
    if (id.startsWith('manual:')) onManualChange(manual.filter((m) => m.id !== id));
    else if (!suppressed.includes(id)) onSuppressedChange([...suppressed, id]);
  };

  const down = (e: React.PointerEvent): void => {
    const p = toModel(e);
    if (grab) return;
    if (mode === 'move') {
      dragFrom.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (!pending) { setPending(p); return; }
    onManualChange([
      ...manual,
      { id: `manual:${Date.now()}`, a: pending, b: p, width: 1.1, kind: 'manual' },
    ]);
    setPending(null);
  };

  const move = (e: React.PointerEvent): void => {
    setHover(toModel(e));
    const d = dragFrom.current;
    const el = svg.current;
    if (!d || !el) return;
    const ctm = el.getScreenCTM();
    if (!ctm) return;
    // Convert the drag in screen pixels to millimetres through the same
    // matrix, so it tracks the cursor at any zoom or aspect.
    const scale = Math.hypot(ctm.a, ctm.b) || 1;
    onOffsetChange({
      x: d.ox + (e.clientX - d.x) / scale,
      y: d.oy - (e.clientY - d.y) / scale,
    });
  };

  const up = (): void => { dragFrom.current = null; };

  return (
    <div className="editor">
      <div className="etoolbar">
        <div className="seg">
          <button className={mode === 'link' ? 'on' : ''} onClick={() => { setMode('link'); setPending(null); }}>
            Add link
          </button>
          <button className={mode === 'move' ? 'on' : ''} onClick={() => { setMode('move'); setPending(null); }}>
            Move surname
          </button>
        </div>
        <span className="ehint">
          {mode === 'link'
            ? pending ? 'click the second point' : 'click two points to join them'
            : 'drag to reposition the second line'}
        </span>
        {(manual.length > 0 || suppressed.length > 0) && (
          <button className="link" onClick={() => { onManualChange([]); onSuppressedChange([]); }}>
            reset {manual.length + suppressed.length} edit{manual.length + suppressed.length === 1 ? '' : 's'}
          </button>
        )}
        <button className="link" onClick={onClose}>done</button>
      </div>

      <svg ref={svg} className="ecanvas"
        viewBox={`${view.x0} ${-view.y0 - view.h} ${view.w} ${view.h}`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}>
        <path className="eshape" fillRule="evenodd" d={outline.map(path).join(' ')} />

        {bridges.map((b) => (
          <g key={b.id}>
            <line className={`ebridge ${b.kind}`}
              x1={b.a.x} y1={-b.a.y} x2={b.b.x} y2={-b.b.y} strokeWidth={b.width} />
            {/* fat invisible hit area: a 1mm line is unclickable */}
            <line className="ehit"
              x1={b.a.x} y1={-b.a.y} x2={b.b.x} y2={-b.b.y} strokeWidth={Math.max(b.width, 2.4)}
              onClick={(e) => { e.stopPropagation(); remove(b.id); }} />
            {(['a', 'b'] as const).map((end) => (
              <circle key={end} className="ehandle" r={1.0}
                cx={b[end].x} cy={-b[end].y}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.currentTarget as Element).setPointerCapture(e.pointerId);
                  setGrab({ id: b.id, a: b.a, b: b.b, end });
                }}
                onPointerMove={(e) => {
                  if (grab?.id !== b.id) return;
                  const p = toModel(e);
                  setGrab({ ...grab, [grab.end]: p } as typeof grab);
                }}
                onPointerUp={(e) => {
                  if (grab?.id !== b.id) return;
                  e.stopPropagation();
                  rehome(grab.id, grab.a, grab.b);
                  setGrab(null);
                }} />
            ))}
          </g>
        ))}

        {grab && (
          <line className="eghost" x1={grab.a.x} y1={-grab.a.y} x2={grab.b.x} y2={-grab.b.y} strokeWidth={1.1} />
        )}

        {pending && <circle className="epending" cx={pending.x} cy={-pending.y} r={1.1} />}
        {pending && hover && (
          <line className="eghost" x1={pending.x} y1={-pending.y} x2={hover.x} y2={-hover.y} strokeWidth={1.1} />
        )}
      </svg>

      <p className="elegend">
        <i className="sw stem" /> accent stems
        <i className="sw auto" /> automatic
        <i className="sw manual" /> yours
        <span>click a link to remove it · drag its ends to move it</span>
      </p>
    </div>
  );
};
