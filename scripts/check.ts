import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Geom } from '../src/geom/clipper';
import { loadFont } from '../src/geom/text';
import { DEFAULT_TAG, buildTag } from '../src/geom/tag';
import type { TagResult } from '../src/geom/tag';
import { checkManifold } from '../src/geom/export';
import { toSvg } from '../src/geom/svg';
import type { SvgLayer } from '../src/geom/svg';
import { bboxOf } from '../src/geom/types';
import type { Poly, Ring } from '../src/geom/types';

/**
 * Every bundled face against a spread of names.
 *
 * A tag fails if it is not one piece, is not watertight, has its two lines
 * tied on fewer than two different letter pairs, or is missing a glyph. Long
 * struts and pipeline warnings are listed as worth a look.
 *
 * Whether the lines have been driven so far into each other that the name
 * stops reading is not scored. Shared ink area, and each letter's footprint
 * covered by the other line, were both tried and neither separates crowded
 * tags from clean ones: a thin swash through a bowl is barely any area. So
 * `--sheets` writes every tag flat to out/check/ to be judged by eye.
 */

/**
 * Randomly generated, not anyone's real guest list. Between them they cover
 * every Polish diacritic including the capitals, two- and three-letter first
 * names, a long pair, and first lines with no descenders to interlock with.
 */
const NAMES: [string, string][] = [
  ['Stanisław', 'Żółtowski'], ['Bogumiła', 'Kołodziej'], ['Bożena', 'Dąbrowa'],
  ['Ala', 'Łęcka'], ['Mikołaj', 'Ślusarczyk'], ['Ula', 'Gąsiorowska'],
  ['Jarosław', 'Śliwińska'], ['Władysław', 'Żak'], ['Leon', 'Źródłowska'],
  ['Witold', 'Jóźwiak'], ['Teodor', 'Ćmielowska'], ['Felicja', 'Kościelniak'],
  ['Józef', 'Pająk'], ['Mirosław', 'Bieńkowski'], ['Ida', 'Pleć'], ['Edyta', 'Grzęda'],
];
const SINGLE = ['Ula', 'Bożena', 'Władysław'];

/** A strut this long reads as a wire across the name rather than part of the script. */
const LONG_STRUT_MM = 5;
const SHORT_LINK_MM = 2;

/** The faces the app reads from the visitor's computer, where this machine has them. */
const SYSTEM_FONTS: [string, string][] = [
  ['/System/Library/Fonts/Supplemental/Savoye LET.ttc', 'SavoyeLET'],
  ['/System/Library/Fonts/Supplemental/Brush Script.ttf', 'BrushScript'],
];
const sheets = process.argv.includes('--sheets');
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
/** `--weight=0.8` checks with thickened strokes; `--font=SavoyeLET` checks one face. */
const params = { ...DEFAULT_TAG, weight: Number(arg('weight') ?? DEFAULT_TAG.weight) };
const only = arg('font');

const fonts: [string, string][] = [
  ...readdirSync('public/fonts')
    .filter((n) => n.endsWith('.ttf'))
    .map((n): [string, string] => [`public/fonts/${n}`, n.replace('-Regular.ttf', '')]),
  ...SYSTEM_FONTS.filter(([path]) => existsSync(path)),
];

interface Cell { polys: Poly[]; struts: Ring[]; fill: string }

const struts = (r: TagResult): Ring[] =>
  r.bridges.filter((b) => b.kind === 'auto').map((b) => [b.a, b.b]);
const lengthOf = ([a, b]: Ring): number => Math.hypot(a!.x - b!.x, a!.y - b!.y);

/** Rows of four, each strut traced so a long one stands out. */
const gridLayers = (cells: Cell[]): SvgLayer[] => {
  const COLS = 4, GAP = 10;
  const boxes = cells.map((c) => bboxOf(c.polys.map((p) => p.outer)));
  const colW = Math.max(...boxes.map((b) => b.x1 - b.x0)) + GAP;
  const layers: SvgLayer[] = [];
  let top = 0;
  for (let row = 0; row * COLS < cells.length; row++) {
    const inRow = boxes.slice(row * COLS, (row + 1) * COLS);
    inRow.forEach((b, col) => {
      const cell = cells[row * COLS + col]!;
      const dx = col * colW - b.x0, dy = top - b.y1;
      const move = (ring: Ring): Ring => ring.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      layers.push({ polys: cell.polys.map((p) => ({ outer: move(p.outer), holes: p.holes.map(move) })), fill: cell.fill });
      layers.push({ rings: cell.struts.map(move), stroke: '#1a73e8', width: 0.4 });
    });
    top -= Math.max(...inRow.map((b) => b.y1 - b.y0)) + GAP;
  }
  return layers;
};

const geom = await Geom.load();
let tags = 0, failed = 0, shortOnly = 0, ms = 0;
const listed: string[] = [];
if (sheets) mkdirSync('out/check', { recursive: true });

console.log('face          pass   short-link longest link');
for (const [path, label] of fonts) {
  if (only && label !== only) continue;
  const { font } = loadFont(readFileSync(path).buffer.slice(0) as ArrayBuffer);
  let pass = 0, clean = 0, longest = 0;
  const cells: Cell[] = [];

  const judge = (name: string, r: TagResult, twoLines: boolean): void => {
    const m = checkManifold(r.mesh);
    const fails: string[] = [];
    if (r.components !== 1) fails.push(`${r.components} pieces`);
    if (!m.closed || !m.oriented) fails.push('not watertight');
    if (twoLines && r.lineLinks < 2) fails.push(`lines tied on ${r.lineLinks} letter pair(s)`);
    if (r.substituted.length) fails.push(`missing glyphs ${r.substituted.join('')}`);

    const s = struts(r);
    const worst = Math.max(0, ...s.map(lengthOf));
    const notes = [...r.warnings];
    if (worst > LONG_STRUT_MM) notes.push(`strut ${worst.toFixed(1)}mm`);

    tags++;
    if (fails.length) failed++;
    else pass++;
    if (fails.length || notes.length) {
      listed.push(`  ${fails.length ? 'FAIL' : 'look'} ${label.padEnd(12)} ${name.padEnd(24)} ${[...fails, ...notes].join(', ')}`);
    }
    if (twoLines) {
      // A join of a millimetre or two reads as part of the stroke; past that it
      // reads as something added.
      if (worst <= SHORT_LINK_MM) { clean++; shortOnly++; }
      longest = Math.max(longest, worst);
    }
    if (sheets) {
      cells.push({ polys: r.polys, struts: s, fill: fails.length ? '#b3261e' : notes.length ? '#b26a00' : '#222' });
    }
  };

  for (const [first, last] of NAMES) {
    const t0 = performance.now();
    const r = buildTag(font, geom, { ...params, first, last });
    ms += performance.now() - t0;
    judge(`${first} ${last}`, r, true);
  }
  for (const first of SINGLE) {
    judge(`${first} (one line)`, buildTag(font, geom, { ...params, first, last: '' }), false);
  }

  console.log(
    `${label.padEnd(13)} ${`${pass}/${NAMES.length + SINGLE.length}`.padEnd(6)} ` +
    `${`${clean}/${NAMES.length}`.padEnd(11)} ${longest.toFixed(1)}mm`,
  );
  if (sheets) writeFileSync(`out/check/${label}.svg`, toSvg(gridLayers(cells)));
}

const twoLine = NAMES.length * (only ? 1 : fonts.length);
console.log(
  `\n${tags - failed}/${tags} pass · ${shortOnly}/${twoLine} two-line tags with every link ≤${SHORT_LINK_MM}mm · ` +
  `${(ms / twoLine).toFixed(0)}ms/tag`,
);
if (listed.length) console.log(`\n${listed.join('\n')}`);
if (sheets) console.log('\nsheets in out/check/: red fails, amber worth a look, struts in blue');
process.exit(failed ? 1 : 0);
