import * as OT from 'opentype.js';
import type { Font } from 'opentype.js';

/**
 * opentype.js v2 ships an ESM bundle with only named exports and a UMD bundle
 * without an `exports` map, so Vite resolves the former and Node the latter.
 * A namespace import is the one form both agree on: from CJS it yields
 * module.exports, from ESM the named exports. The `default` hop covers
 * bundlers that wrap the UMD build.
 */
type ParseFn = (data: ArrayBuffer) => Font;
const ns = OT as unknown as { parse?: ParseFn; default?: { parse?: ParseFn } };
const fn = ns.parse ?? ns.default?.parse;
if (!fn) throw new Error('opentype.js: no parse export found');

export const parseFont: ParseFn = fn;
export type { Font, Path } from 'opentype.js';
