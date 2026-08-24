# NamR

Browser-based generator of 3D-printable script name tags for wedding tables,
parties and desks. Type a name or import a CSV, get STL/3MF files — one per
tag, or packed into printer-bed batches.

Everything runs client-side, so guest names never leave the browser and the
whole thing hosts as a static site on GitHub Pages.

## Status

| Stage | State |
|---|---|
| Font → outlines, Polish diacritics | done |
| Mark detection (tittles, accents) | done |
| Line overlap solve | done |
| Welding + bridging → one piece | done |
| Profile decimation | done |
| 3D mesh (60° revolve) | done |
| STL / 3MF export | done |
| Bed packing / batches | not started |
| CSV bulk import | not started |
| Web UI + 3D preview | not started |

Validated on 12 Polish names: all resolve to a single watertight, correctly
oriented component at ~67ms each.

```
ok   Ryszard Jasiński           comp=1 br=3 56x32x30mm 41Ktri 1.95MB
ok   Łukasz Ćwikliński          comp=1 br=5 69x34x32mm 45Ktri 2.16MB
ok   Krzysztof Wojciechowski    comp=1 br=6 91x32x30mm 57Ktri 2.72MB
...
12/12 ok, 67ms/name
```

## The geometry, confirmed

`ref/AsiaJ.step` settles it. Parsing that B-rep's 462 circles:

- every one shares a single axis, direction `(1,0,0)` — parallel to the baseline
- all centred on one line at `Y = -11.906, Z = 0`
- radii run `5.000` to `46.534`; the minimum is exactly the 5mm offset
- `max Z / max radius = 40.30 / 46.534 = sin 60°` exactly

So the tag is the merged profile **revolved 60° about an axis parallel to the
baseline, 5mm past the lowest ink**. The `R50.00` in `angle.png` is
construction geometry for the sweep path and never reaches the solid, which is
why it looked inconsistent with the 5mm offset: a sweep along an arc whose
centre lies in the profile plane *is* a revolve, so the path radius drops out.

The name reads off the `alpha = 0` face. `mode: 'extrude'` is kept as a flat
plate variant.

## Architecture

Pure client-side. Vite + TypeScript + React, Three.js preview, Web Worker pool
for the geometry so a large CSV never blocks the UI.

```
src/geom/
  types.ts      Pt / Ring / Poly, shoelace area (CCW positive)
  clipper.ts    WASM Clipper wrapper: union, offset, closing, erosion
  text.ts       font → tagged contours, Polish fallback, mark detection
  connect.ts    line overlap, mark stems, MST bridging
  simplify.ts   Douglas-Peucker decimation
  sweep.ts      profile → watertight mesh (60° revolve)
  export.ts     binary STL, 3MF, manifold check
  tag.ts        the whole pipeline for one tag
```

### How a tag is built

1. **Outlines.** opentype.js, with pair kerning. Missing Polish glyphs fall
   back to the base letter and are reported.
2. **Mark detection.** A glyph whose rings form more than one island — `i` and
   its tittle, `ń` and its acute — yields marks for every island but the
   largest. Provenance is kept per contour.
3. **Line overlap.** Binary search the vertical offset until the two lines
   share a weld at least `minWeldWidth` across. The predicate is monotone, so
   the first offset that welds is the shallowest one that does.
4. **Stems.** Each mark is tied to *its own* letter. Proximity alone would
   graft an `i` tittle onto whichever letter happens to be nearest, which on a
   tight script is often the wrong one.
5. **Closing.** Morphological closing (dilate then erode by `weldRadius`)
   welds gaps up to `2 × weldRadius` without fattening the letterforms.
6. **Bridging.** Islands that survive are joined by a minimum spanning tree
   over inter-island distance: n islands need exactly n−1 bridges, each placed
   where the letters already almost touch.
7. **Decimate.** Douglas-Peucker at 0.02mm. Cuts points ~3× for 0.07% area
   error, and clears the slivers that make ear-clipping drop a triangle.
8. **Mesh.** Earcut caps plus a quad band per boundary edge. No 3D booleans.
   Checked watertight before export.

### Two library findings

**`clipper2-js` is not usable.** Its negative offsets return garbage and miter
joins drop an edge. Erosion is load-bearing here for both welding and the
minimum-feature check. `js-angusj-clipper` (WASM Clipper 6.4.2) is exact on
every case tested; its wasm is a base64 data URI, so it needs no asset
plumbing in a worker or on Pages.

**Angular is a phantom dependency.** `clipper2-js` declares `@angular/*` as
peers purely because it is packaged with ng-packagr — 42MB and three
advisories for code that imports neither. `.npmrc` sets `legacy-peer-deps`.

## Fonts

Brush Script MT is Monotype-licensed and cannot ship in a web app. The plan is
open script faces bundled as defaults plus drag-and-drop for your own TTF/OTF,
processed locally. Brush Script has full Polish coverage and is used for local
validation via `FONT=`.

## Development

```sh
npm install
npm run spike -- Ryszard Jasiński     # one tag -> out/tag.stl, out/tag.3mf
FONT=/path/to/font.ttf npm run spike  # try another face
```

`scripts/render_stl.py` software-renders an STL with a z-buffer for eyeballing
geometry without a browser.
