import json, sys
from PIL import Image, ImageDraw

def render(polys_layers, path, px_per_mm=12, pad=3, bg=(255,255,255)):
    pts=[p for layer in polys_layers for poly in layer["polys"] for ring in [poly["outer"]]+poly["holes"] for p in ring]
    x0=min(p["x"] for p in pts)-pad; x1=max(p["x"] for p in pts)+pad
    y0=min(p["y"] for p in pts)-pad; y1=max(p["y"] for p in pts)+pad
    W=int((x1-x0)*px_per_mm); H=int((y1-y0)*px_per_mm)
    img=Image.new("RGB",(W,H),bg); d=ImageDraw.Draw(img)
    def xf(r): return [((p["x"]-x0)*px_per_mm, H-(p["y"]-y0)*px_per_mm) for p in r]
    for layer in polys_layers:
        col=tuple(layer["color"])
        for poly in layer["polys"]:
            d.polygon(xf(poly["outer"]), fill=col)
            for h in poly["holes"]: d.polygon(xf(h), fill=bg)
    img.save(path); print(f"{path} {W}x{H}")

data=json.load(open(sys.argv[1]))
render(data["layers"], sys.argv[2], data.get("ppmm",12))
