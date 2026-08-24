import type { Poly, Ring } from './types';
import { bboxOf } from './types';

const d = (r: Ring): string =>
  `M ${r.map((p) => `${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(' L ')} Z`;

export interface SvgLayer {
  polys?: Poly[];
  rings?: Ring[];
  fill?: string;
  stroke?: string;
  width?: number;
  opacity?: number;
}

/** Debug rendering. Y is negated so y-up geometry reads the right way round. */
export const toSvg = (layers: SvgLayer[], pad = 4): string => {
  const all = layers.flatMap((l) => [
    ...(l.rings ?? []),
    ...(l.polys ?? []).flatMap((p) => [p.outer, ...p.holes]),
  ]);
  const b = bboxOf(all);
  const w = b.x1 - b.x0 + pad * 2;
  const h = b.y1 - b.y0 + pad * 2;

  const body = layers
    .map((l) => {
      const paths = [
        ...(l.polys ?? []).map((p) => [p.outer, ...p.holes].map(d).join(' ')),
        ...(l.rings ?? []).map(d),
      ];
      return paths
        .map(
          (pd) =>
            `<path d="${pd}" fill="${l.fill ?? 'none'}" fill-rule="nonzero" ` +
            `stroke="${l.stroke ?? 'none'}" stroke-width="${l.width ?? 0.15}" ` +
            `opacity="${l.opacity ?? 1}"/>`,
        )
        .join('\n');
    })
    .join('\n');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${(w * 4).toFixed(0)}" height="${(h * 4).toFixed(0)}" ` +
    `viewBox="${(b.x0 - pad).toFixed(2)} ${(-b.y1 - pad).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}">\n` +
    `<g transform="scale(1,-1)">\n${body}\n</g>\n</svg>\n`
  );
};
