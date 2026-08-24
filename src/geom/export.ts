import { zipSync, strToU8 } from 'fflate';
import type { Mesh } from './sweep';

/** Binary STL. Normals are computed per facet; slicers ignore them but some viewers do not. */
export const toStl = (mesh: Mesh, header = 'NamR'): Uint8Array => {
  const nTri = mesh.indices.length / 3;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const view = new DataView(buf);
  // Truncate after encoding: the header is a fixed 80 *bytes*, and a name
  // like "Jasinski" with diacritics encodes to more bytes than characters.
  const head = strToU8(header).slice(0, 80);
  new Uint8Array(buf, 0, 80).set(head);
  view.setUint32(80, nTri, true);

  const p = mesh.positions;
  let o = 84;
  for (let t = 0; t < nTri; t++) {
    const a = mesh.indices[t * 3]! * 3, b = mesh.indices[t * 3 + 1]! * 3, c = mesh.indices[t * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const i of [a, b, c]) {
      view.setFloat32(o, p[i]!, true);
      view.setFloat32(o + 4, p[i + 1]!, true);
      view.setFloat32(o + 8, p[i + 2]!, true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
};

const xmlEscape = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

export interface ThreeMfObject {
  mesh: Mesh;
  name: string;
}

export interface ThreeMfItem {
  objectIndex: number;
  /** Column-major 3x4 as 3MF wants it: 12 numbers, row-major rows of 3 then translation. */
  transform?: [number, number, number, number, number, number, number, number, number, number, number, number];
}

/**
 * 3MF. Preferred over STL for plates: the geometry is stored once and each
 * placement is an item with a transform, so a 30-tag plate is not 30 copies
 * of the same triangles, and the file declares millimetres rather than
 * leaving the slicer to guess.
 */
export const to3mf = (objects: ThreeMfObject[], items: ThreeMfItem[]): Uint8Array => {
  const objXml = objects
    .map((o, i) => {
      const p = o.mesh.positions;
      const verts: string[] = [];
      for (let v = 0; v < p.length; v += 3) {
        verts.push(`<vertex x="${p[v]!.toFixed(4)}" y="${p[v + 1]!.toFixed(4)}" z="${p[v + 2]!.toFixed(4)}"/>`);
      }
      const tris: string[] = [];
      for (let t = 0; t < o.mesh.indices.length; t += 3) {
        tris.push(`<triangle v1="${o.mesh.indices[t]}" v2="${o.mesh.indices[t + 1]}" v3="${o.mesh.indices[t + 2]}"/>`);
      }
      return (
        `<object id="${i + 1}" type="model" name="${xmlEscape(o.name)}">` +
        `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh>` +
        `</object>`
      );
    })
    .join('');

  const itemXml = items
    .map((it) => {
      const t = it.transform ? ` transform="${it.transform.map((n) => n.toFixed(6)).join(' ')}"` : '';
      return `<item objectid="${it.objectIndex + 1}"${t}/>`;
    })
    .join('');

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Application">NamR</metadata>` +
    `<resources>${objXml}</resources>` +
    `<build>${itemXml}</build>` +
    `</model>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rel0" Target="/3D/3dmodel.model" ` +
    `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(model),
  });
};

/** Translation-only 3MF transform. */
export const translateTransform = (
  dx: number,
  dy: number,
  dz: number,
): NonNullable<ThreeMfItem['transform']> => [1, 0, 0, 0, 1, 0, 0, 0, 1, dx, dy, dz];

/**
 * A mesh is closed iff every undirected edge is used by exactly two
 * triangles, and consistently oriented iff those two traverse it in opposite
 * directions. The two failures are tracked apart because they mean different
 * things: an open edge is a hole, a flipped one is an inside-out facet.
 * Slicers accept both silently and then produce nonsense.
 */
export const checkManifold = (
  mesh: Mesh,
): { closed: boolean; oriented: boolean; openEdges: number; flippedEdges: number } => {
  const count = new Map<string, number>();
  const net = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
    for (let i = 0; i < 3; i++) {
      const a = v[i]!, b = v[(i + 1) % 3]!;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
      net.set(key, (net.get(key) ?? 0) + (a < b ? 1 : -1));
    }
  }
  let openEdges = 0, flippedEdges = 0;
  for (const [key, c] of count) {
    if (c !== 2) openEdges++;
    else if (net.get(key) !== 0) flippedEdges++;
  }
  return { closed: openEdges === 0, oriented: flippedEdges === 0, openEdges, flippedEdges };
};
