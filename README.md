# NamR

**[mr4lexndr.github.io/NamR](https://mr4lexndr.github.io/NamR/)**

![Three finished tags, in Yellowtail, Pacifico and Lobster](docs/hero.png)

Turn a name — or a whole guest list — into 3D printable script name tags for
wedding tables, parties and desks. Type it, see it, download STL or 3MF.

The hard part is not drawing the letters, it is making them hold together.
Joined script is full of gaps: a capital that never quite reaches the next
letter, an i-tittle floating free, two lines that only touch if you nudge them
into each other. Left alone that prints as a heap of loose pieces. NamR closes
those gaps the way a signwriter would — tightening the spacing, sliding the
surname to where the two lines interlock, stemming each accent to its own
letter — and only bridges what is genuinely too far apart. Every tag comes out
as **one connected solid**: no supports, no glue, no assembly.

- **Batch the whole list.** Paste names or drop in a CSV, and every tag is
  packed onto printer beds and zipped up with a manifest, ready to slice.
- **Reads face-down on the glass**, so the visible side comes off smooth.
- **Polish and Latin Extended** throughout — ą ć ę ł ń ó ś ź ż keep their
  accents, joined to the letter they belong to.
- **Eight script faces bundled**, Savoye LET and Brush Script from your own
  computer, or load any font file; it is parsed in the browser.
- **Nothing is uploaded.** No account, no server. It is a static site, so guest
  names never leave your machine.

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

Leaving the surname empty gives a one-line tag.

`npm run check` builds 16 randomly generated Polish names and three one-line
tags in every bundled face, plus Savoye LET and Brush Script where the
machine has them. All 190 come out as a single watertight, correctly oriented
piece, and every two-line tag is held together on at least two different pairs
of letters.

```
face          pass   strut-free  longest strut
AlexBrush     19/19  10/16       3.2mm
Damion        19/19  10/16       3.5mm
GreatVibes    19/19  14/16       4.2mm
Lobster       19/19  14/16       6.8mm
Norican       19/19  15/16       5.4mm
Pacifico      19/19  12/16       9.6mm
Sacramento    19/19  9/16        9.1mm
Yellowtail    19/19  14/16       4.1mm
SavoyeLET     19/19  12/16       3.2mm
BrushScript   19/19  15/16       1.5mm

190/190 pass · 125/160 two-line tags strut-free · 170ms/tag
```

Whether the lines have been pushed so far into each other that the name stops
reading is not scored: shared ink area misses a thin swash cutting through a
bowl, and so does the share of each letter's footprint the other line covers.
`npm run check -- --sheets` draws every tag flat into `out/check/` to be judged
by eye.

## The geometry, confirmed

A STEP export of the original CAD model settles it. Parsing that B-rep's 462
circles:

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
  pack.ts       maximal-rectangles packing onto printer beds
  batch.ts      many names -> plates -> zip + manifest
```

### How a tag is built

1. **Outlines.** opentype.js, with pair kerning. Missing Polish glyphs fall
   back to the base letter and are reported.
2. **Mark detection.** A glyph whose rings form more than one island — `i` and
   its tittle, `ń` and its acute — yields marks for every island but the
   largest. Provenance is kept per contour.
3. **Stems.** Each mark is tied to *its own* letter. Proximity alone would
   graft an `i` tittle onto whichever letter happens to be nearest, which on a
   tight script is often the wrong one.
4. **Tightening.** A script is meant to join up, so a gap between letters is
   closed by pulling them together rather than bridging across it — the result
   reads as handwriting instead of two letters wired together. Each letter may
   travel `letterTighten`; anything still apart is left to bridging. It stops
   at contact and leaves the join to the weld: pulling further makes strokes
   that meet at a shallow angle cross, and the lens between the crossings
   prints as a slit through the stroke. A shift is rejected if it pushes a
   letter into a neighbour's counter, and the finished word is compared against
   the untightened one, so it can never make things worse.
5. **Line placement.** Sliding the surname straight up is the wrong single
   degree of freedom: two lines of script interlock at particular horizontal
   offsets, where a descender drops into the gap between two ascenders. Depth
   has to be searched too — the shallowest overlap that welds is often not the
   one that reads best, and pushing the lines further into each other
   frequently removes a strut altogether.

   Placements are costed by the strut they would still need, as the minimum
   spanning tree over whatever islands remain. Counting welds alone accepts a
   position that welds twice and then strands a letter across half the tag,
   and the strut spanning that gap is the thing that looks wrong. What keeps
   deeper overlaps honest is the *mutual overlap area*: a weld costs a few
   square millimetres, two lines marching through each other cost hundreds,
   which is where the name stops being readable.

   A coarse sweep of both axes on heavily decimated outlines, then a local
   refinement at finer resolution. 117 of 135 test tags need no strut at all;
   the mean longest strut is 0.4mm. The two lines must still meet in at least
   two places, because one contact is a hinge that snaps.
6. **Closing.** Morphological closing (dilate then erode by `weldRadius`)
   welds gaps up to `2 × weldRadius` without fattening the letterforms.
7. **Bridging.** Islands that survive are joined by a minimum spanning tree
   over inter-island distance: n islands need exactly n−1 bridges, each placed
   where the letters already almost touch. A second pass runs after filleting,
   because two strokes meeting at a single point come back from the union as
   one self-touching ring and only fall apart once the pinch is resolved — a
   contact with no width was never a connection worth counting.
8. **Fillet and tidy.** A small closing rounds where connectors meet strokes,
   then trapped slivers are filled. A hole has to fail two tests before it
   goes. *Provenance:* a counter is enclosed by one glyph on its own, so an
   open bowl that welding seals still counts — Yellowtail's R is one, and
   judging by the raw outline alone filled it into a blob. *Size:* the gap
   between two adjacent letters belongs to neither of them, but it is the eye
   of the script, and filling it turns the word solid. Only a hole that is
   both foreign and tiny is an artifact.
9. **Decimate.** Douglas-Peucker at 0.02mm. Cuts points ~3× for 0.07% area
   error, and clears the slivers that make ear-clipping drop a triangle.
10. **Mesh.** Earcut caps plus a quad band per boundary edge. No 3D booleans.
   Checked watertight before export.

Every step above is editable by hand afterwards: any link can be removed or
dragged, and the surname can be repositioned directly, with the solver
respecting those choices on the next rebuild.

### Orbiting

The preview orbits in the readable face's own frame, not the world's. That
face is tilted by the sweep angle, so orbiting about world-up merely rolls the
name diagonally across the screen instead of walking around it — the writing
never sits level and there is no way to get a side view. Building the basis
from the face itself (baseline right, its own up, its normal out) makes a
horizontal drag mean "look from the side" and keeps the name level throughout.
Home is that face, a fraction off-axis so the depth reads.

### Print orientation

The face you read is the one at the far end of the sweep, whose normal is
`(0, -sin a, cos a)`. Exports rotate the tag by `180 - a` about X so that
normal becomes `-Z` and the readable face beds against the glass, coming off
with the smooth finish. The preview keeps the as-built pose, which reads
better on screen.

### Batches

A guest list goes in as CSV or pasted text. The delimiter is sniffed rather
than assumed — Polish Excel writes semicolons — the BOM is stripped, a header
row is detected if present, and a single-column file is split on the last
space so multi-part given names survive.

Tags are packed longest-first, each on the earliest plate it fits, filling
from the top-left. Name tags are long and shallow, so they settle into rows,
and every row ends in a strip too narrow for another tag lying flat but deep
enough, across two rows, for one turned a quarter. Tracking every free
rectangle rather than a shelf finds those strips; turning is about Z, so the
reading face stays on the glass. On random 82-name lists this averages 5.0
plates on a 256mm bed where shelf packing needed 5.9, and 7 on a 220mm bed
where it needed 8, with only the tags at the ends of rows turned.

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

Eight open-licensed connected scripts are bundled — Yellowtail, Pacifico,
Lobster, Damion, Norican, Sacramento, Alex Brush and Great Vibes. All have
complete Polish coverage and all solve to a single piece across the test
names. They are fetched on demand, so only the chosen one is downloaded.

Savoye LET and Brush Script belong to Monotype and cannot be served from here,
but nearly every Mac already has both. The picker reads the visitor's own
installed copy through the Local Font Access API, which needs a Chromium
browser (Chrome or Edge) and the visitor's permission when it asks. macOS
keeps Savoye LET in a `.ttc` collection and the browser hands over the whole
file, so `src/geom/sfnt.ts` cuts out the one face by its PostScript name;
opentype.js reads single fonts only.

Anything else can be loaded from disk, `.ttc` collections included. It is
parsed in the browser, kept in IndexedDB so it survives a reload, and never
transmitted — which is also how to use a licensed face you already own, and
how Savoye LET and Brush Script work in Safari and Firefox. Using either
yourself is fine; serving the file from the site would be redistributing
Monotype's font to every visitor, which no licence here covers.

## Development

```sh
npm install
npm run dev                           # the app, at localhost:5173/NamR/
npm run build                         # production build into dist/

npm run spike -- Bożena Dąbrowa       # headless: one tag -> out/tag.stl, .3mf
FONT=/path/to/font.ttf npm run spike  # try another face
npm run check                         # every face against the test names
npm run check -- --sheets             # ...and draw them into out/check/
```

Pushing to `main` deploys to GitHub Pages. Enable it once under
Settings -> Pages -> Source: GitHub Actions.

`scripts/render_stl.py` software-renders an STL with a z-buffer for eyeballing
geometry without a browser.
