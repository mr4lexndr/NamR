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
| Web UI + 3D preview | done |
| CSV bulk import | done |
| Bed packing / batches | done |
| Bridge editor | not started |

Validated on 12 Polish names across all nine faces (108 combinations): every
one resolves to a single watertight, correctly oriented component with its
text face on z = 0 and at least two links between the lines.

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
  csv.ts        guest list parsing, delimiter sniffing
  pack.ts       shelf packing onto printer beds
  batch.ts      many names -> plates -> zip + manifest
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
8. **Fillet and tidy.** A small closing rounds where connectors meet strokes,
   then holes under `minHoleArea` are dropped — welding two strokes that pass
   close together traps slivers of background that read as defects, while real
   counters in a 20mm script run 5mm² and up.
9. **Decimate.** Douglas-Peucker at 0.02mm. Cuts points ~3× for 0.07% area
   error, and clears the slivers that make ear-clipping drop a triangle.
10. **Mesh.** Earcut caps plus a quad band per boundary edge. No 3D booleans.
   Checked watertight before export.

### Print orientation

The `alpha = 0` face lies exactly on `z = 0`, so a tag lands text-face-down on
the bed. The first layer is the whole name outline — maximum adhesion, no
supports, and the visible face is the one against the glass.

### Batches

A guest list goes in as CSV or pasted text. The delimiter is sniffed rather
than assumed — Polish Excel writes semicolons — the BOM is stripped, a header
row is detected if present, and a single-column file is split on the last
space so multi-part given names survive.

Tags are packed tallest-first onto shelves. Name tags are long and shallow
with widths that vary a lot and depths that barely do, so they form full rows
naturally; a shelf gets close to optimal on that shape while staying
predictable, which matters when you have to recognise the plate in a slicer.
16 names land on two 220mm plates at 55% coverage.

The download is a zip of either one file per plate or one per tag, plus a
`manifest.csv` naming every tag, its plate and any warning.

### A closing that could not be trusted

Morphological closing is extensive — the result always contains the input — so
it can never split a shape. The polygonal approximation of its round joins can,
though: the erosion cuts marginally deeper than the dilation grew, and on a
weld only as wide as the radius that severs the piece. `Geom.close` unions the
input back in to enforce the guarantee the maths already promised.

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

Brush Script MT belongs to Monotype and cannot be redistributed, so the app
bundles eight open-licensed connected scripts instead — Yellowtail, Pacifico,
Lobster, Damion, Norican, Sacramento, Alex Brush and Great Vibes. All have
complete Polish coverage and all solve to a single piece across the test
names. They are fetched on demand, so only the chosen one is downloaded.

Anything else can be loaded from disk; it is parsed in the browser and never
uploaded, which is also how to use a licensed face you already own.
Brush Script is used for local validation via `FONT=`.

## Development

```sh
npm install
npm run dev                           # the app, at localhost:5173/NamR/
npm run build                         # production build into dist/

npm run spike -- Ryszard Jasiński     # headless: one tag -> out/tag.stl, .3mf
FONT=/path/to/font.ttf npm run spike  # try another face
```

Pushing to `main` deploys to GitHub Pages. Enable it once under
Settings -> Pages -> Source: GitHub Actions.

`scripts/render_stl.py` software-renders an STL with a z-buffer for eyeballing
geometry without a browser.
