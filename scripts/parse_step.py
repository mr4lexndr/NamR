"""Pull the sweep axis and radii out of a STEP B-rep by looking at its circles."""
import re, sys, math
from collections import Counter, defaultdict

src = open(sys.argv[1], encoding='utf-8', errors='replace').read()
src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
ents = {}
for stmt in src.split(';'):
    m = re.match(r'\s*#(\d+)\s*=\s*([A-Z_0-9]+)\s*\((.*)\)\s*$', stmt.strip(), re.S)
    if m:
        ents[int(m.group(1))] = (m.group(2), m.group(3))

def refs(s):
    return [int(x) for x in re.findall(r'#(\d+)', s)]
def nums(s):
    return [float(x) for x in re.findall(r'-?\d+\.\d*(?:E[-+]?\d+)?', s)]

def point(i):
    return nums(ents[i][1])[:3]
def direction(i):
    return nums(ents[i][1])[:3]

# units
for k,(t,a) in ents.items():
    if t in ('SI_UNIT','CONVERSION_BASED_UNIT') and ('METRE' in a or 'MILLI' in a):
        print('unit entity:', t, a[:80]); break

pts = [nums(a)[:3] for t,a in ents.values() if t=='CARTESIAN_POINT' and len(nums(a))>=3]
xs=[p[0] for p in pts]; ys=[p[1] for p in pts]; zs=[p[2] for p in pts]
print(f'model bbox: X[{min(xs):.2f},{max(xs):.2f}] Y[{min(ys):.2f},{max(ys):.2f}] Z[{min(zs):.2f},{max(zs):.2f}]')
print(f'            {max(xs)-min(xs):.2f} x {max(ys)-min(ys):.2f} x {max(zs)-min(zs):.2f}')

circles=[]
for k,(t,a) in ents.items():
    if t!='CIRCLE': continue
    r_ = refs(a); rad = nums(a)[-1]
    ap = ents[r_[0]]                       # AXIS2_PLACEMENT_3D
    apr = refs(ap[1])
    loc = point(apr[0]); axis = direction(apr[1])
    circles.append((rad, tuple(round(v,6) for v in axis), tuple(round(v,4) for v in loc)))

print(f'\ncircles: {len(circles)}')
axc = Counter(c[1] for c in circles)
print('axis directions (top 5):')
for ax,n in axc.most_common(5):
    print(f'  {ax}  x{n}')

# for the dominant axis, where does the axis line sit and what radii appear?
main = axc.most_common(1)[0][0]
sel = [c for c in circles if c[1]==main]
rads = sorted(c[0] for c in sel)
print(f'\ndominant axis {main}: {len(sel)} circles')
print(f'  radius min={rads[0]:.3f} max={rads[-1]:.3f}')
locs = [c[2] for c in sel]
for i,lab in enumerate('XYZ'):
    vals={round(l[i],3) for l in locs}
    print(f'  centre {lab}: {len(vals)} distinct' + (f' = {sorted(vals)[:6]}' if len(vals)<=6 else f' range [{min(vals):.2f},{max(vals):.2f}]'))
