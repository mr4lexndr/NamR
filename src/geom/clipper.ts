import * as C from 'js-angusj-clipper';
import type { Poly, Pt, Ring } from './types';

/**
 * Clipper works in integers. 1e4 units per mm puts the quantum at 0.1um,
 * far below anything a printer resolves, while keeping a 300mm bed at 3e6
 * units -- nowhere near the 2^53 that would cost us exactness.
 */
const S = 1e4;

const toClipper = (rings: Ring[]): C.Paths =>
  rings.map((r) => r.map((p) => ({ x: Math.round(p.x * S), y: Math.round(p.y * S) })));

const fromClipper = (paths: readonly C.ReadonlyPath[]): Ring[] =>
  paths.map((p) => p.map((q) => ({ x: q.x / S, y: q.y / S })));

export type Join = 'round' | 'miter' | 'square';

const JOIN: Record<Join, C.JoinType> = {
  round: C.JoinType.Round,
  miter: C.JoinType.Miter,
  square: C.JoinType.Square,
};

/**
 * Thin wrapper over the WASM build of Clipper. The pure-JS clipper2 port was
 * evaluated first and rejected: its negative offsets and miter joins are
 * wrong, and erosion is load-bearing here for both welding and the
 * minimum-feature check.
 */
export class Geom {
  private constructor(private readonly lib: C.ClipperLibWrapper) {}

  static async load(): Promise<Geom> {
    const lib = await C.loadNativeClipperLibInstanceAsync(
      C.NativeClipperLibRequestedFormat.WasmWithAsmJsFallback,
    );
    return new Geom(lib);
  }

  /** Union under non-zero winding, returned as components with their holes. */
  union(rings: Ring[]): Poly[] {
    if (rings.length === 0) return [];
    const tree = this.lib.clipToPolyTree({
      clipType: C.ClipType.Union,
      subjectFillType: C.PolyFillType.NonZero,
      subjectInputs: [{ data: toClipper(rings), closed: true }],
    });
    return tree ? treeToPolys(tree) : [];
  }

  offset(polys: Poly[], delta: number, join: Join = 'round'): Poly[] {
    if (polys.length === 0 || delta === 0) return polys;
    const data = toClipper(polys.flatMap((p) => [p.outer, ...p.holes]));
    const tree = this.lib.offsetToPolyTree({
      delta: delta * S,
      offsetInputs: [{ data, joinType: JOIN[join], endType: C.EndType.ClosedPolygon }],
      // Chord error of the round-join arcs. 2um is invisible at print scale
      // but keeps vertex counts sane on script fonts full of curves.
      arcTolerance: 0.002 * S,
    });
    return tree ? treeToPolys(tree) : [];
  }

  /**
   * Morphological closing: dilate then erode by the same radius. Welds any
   * gap narrower than 2r while leaving the outer silhouette where it was,
   * which is what separates it from simply fattening the letters.
   */
  close(polys: Poly[], r: number): Poly[] {
    if (r <= 0) return polys;
    return this.offset(this.offset(polys, r), -r);
  }

  /** True if every stroke is at least `w` wide; erosion by w/2 wipes out anything thinner. */
  survivesErosion(polys: Poly[], w: number): boolean {
    return this.offset(polys, -w / 2).length > 0;
  }

  /** The parts of `polys` thinner than `w`, recovered by an opening. */
  thinRegions(polys: Poly[], w: number): Poly[] {
    const opened = this.offset(this.offset(polys, -w / 2), w / 2);
    if (opened.length === 0) return polys;
    return this.difference(polys, opened);
  }

  difference(subject: Poly[], clip: Poly[]): Poly[] {
    const tree = this.lib.clipToPolyTree({
      clipType: C.ClipType.Difference,
      subjectFillType: C.PolyFillType.NonZero,
      clipFillType: C.PolyFillType.NonZero,
      subjectInputs: [{ data: toClipper(subject.flatMap((p) => [p.outer, ...p.holes])), closed: true }],
      clipInputs: [{ data: toClipper(clip.flatMap((p) => [p.outer, ...p.holes])) }],
    });
    return tree ? treeToPolys(tree) : [];
  }

  /**
   * A stadium of width `w` spanning a..b, used as the bridge that welds two
   * islands. Built by round-offsetting an open two-point path, so the caps
   * land inside both shapes instead of stopping flush at the surface.
   */
  capsule(a: Pt, b: Pt, w: number): Poly[] {
    const tree = this.lib.offsetToPolyTree({
      delta: (w / 2) * S,
      offsetInputs: [
        {
          data: [
            [
              { x: Math.round(a.x * S), y: Math.round(a.y * S) },
              { x: Math.round(b.x * S), y: Math.round(b.y * S) },
            ],
          ],
          joinType: C.JoinType.Round,
          endType: C.EndType.OpenRound,
        },
      ],
      arcTolerance: 0.002 * S,
    });
    return tree ? treeToPolys(tree) : [];
  }

  area(polys: Poly[]): number {
    return polys.reduce(
      (a, p) => a + Math.abs(polyArea(p.outer)) - p.holes.reduce((h, r) => h + Math.abs(polyArea(r)), 0),
      0,
    );
  }
}

const polyArea = (r: Ring): number => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]!.x + r[i]!.x) * (r[j]!.y - r[i]!.y);
  return a / 2;
};

/**
 * Flatten a PolyTree to components. A hole's children are themselves outer
 * rings of islands sitting inside that hole, so they surface as separate
 * components rather than being folded into their parent.
 */
const treeToPolys = (tree: C.PolyTree | C.PolyNode): Poly[] => {
  const out: Poly[] = [];
  const visitOuter = (node: C.PolyNode): void => {
    const holes: Ring[] = [];
    for (const child of node.childs) {
      holes.push(fromClipper([child.contour])[0]!);
      for (const island of child.childs) visitOuter(island);
    }
    out.push({ outer: fromClipper([node.contour])[0]!, holes });
  };
  for (const top of tree.childs) visitOuter(top);
  return out;
};

export { S as CLIPPER_SCALE };
