import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Geom } from '../src/geom/clipper';
import { loadFont } from '../src/geom/text';
import { DEFAULT_TAG, buildTag } from '../src/geom/tag';
import { toStl, to3mf, checkManifold } from '../src/geom/export';
import { countPoints } from '../src/geom/simplify';
import { arcSegments } from '../src/geom/sweep';

const FONT = process.env.FONT ?? '/System/Library/Fonts/Supplemental/Brush Script.ttf';
const first = process.argv[2] ?? 'Ryszard';
const last = process.argv[3] ?? 'Jasiński';

const geom = await Geom.load();
const { font } = loadFont(readFileSync(FONT).buffer.slice(0) as ArrayBuffer);
mkdirSync('out', { recursive: true });

const t0 = performance.now();
const r = buildTag(font, geom, { ...DEFAULT_TAG, first, last });
const ms = performance.now() - t0;

const man = checkManifold(r.mesh);
const b = r.bounds;
console.log(`${first} ${last}`);
console.log(`  components ${r.components} | bridges ${r.bridges.length} | overlapY ${r.overlapY.toFixed(2)}mm`);
console.log(`  em ${r.emMm.toFixed(2)}mm (front line ${DEFAULT_TAG.frontHeight}mm) | profile ${countPoints(r.polys)} pts | arc segments ${arcSegments(DEFAULT_TAG.sweep, 25)}`);
console.log(`  mesh ${(r.mesh.indices.length/3).toLocaleString()} tris`);
console.log(`  bounds ${b.dx.toFixed(1)} x ${b.dy.toFixed(1)} x ${b.dz.toFixed(1)}mm`);
console.log(`  manifold closed=${man.closed} oriented=${man.oriented} open=${man.openEdges} flipped=${man.flippedEdges}`);
console.log(`  build ${ms.toFixed(0)}ms`);
if (r.warnings.length) console.log('  warnings:', r.warnings.join('; '));

const stl = toStl(r.mesh, `NamR ${first} ${last}`);
const mf = to3mf([{ mesh: r.mesh, name: `${first} ${last}` }], [{ objectIndex: 0 }]);
writeFileSync('out/tag.stl', stl);
writeFileSync('out/tag.3mf', mf);
console.log(`  stl ${(stl.length/1024/1024).toFixed(2)}MB | 3mf ${(mf.length/1024).toFixed(0)}KB`);
