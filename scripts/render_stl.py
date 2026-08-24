"""Software render a binary STL with a z-buffer. Used to eyeball geometry
without spinning up a browser."""
import sys, struct
import numpy as np
from PIL import Image

def load(path):
    with open(path,'rb') as f:
        f.read(80); n = struct.unpack('<I', f.read(4))[0]
        data = np.frombuffer(f.read(n*50), dtype=np.uint8).reshape(n,50)
    tri = data[:, 12:48].copy().view(np.float32).reshape(n,3,3)
    return tri

def render(tri, out, size=(1100,760), elev=22, azim=-38, roll=0):
    c = tri.reshape(-1,3)
    center = (c.min(0)+c.max(0))/2
    tri = tri - center
    a, e = np.radians(azim), np.radians(elev)
    Ry = np.array([[ np.cos(a),0,np.sin(a)],[0,1,0],[-np.sin(a),0,np.cos(a)]])
    Rx = np.array([[1,0,0],[0,np.cos(e),-np.sin(e)],[0,np.sin(e),np.cos(e)]])
    # model: x along the name, y in the flat text plane, z = height above bed.
    S  = np.array([[1,0,0],[0,0,1],[0,1,0]])
    r  = np.radians(roll)
    Rz = np.array([[np.cos(r),-np.sin(r),0],[np.sin(r),np.cos(r),0],[0,0,1]])
    M = Rz @ Rx @ Ry @ S
    v = tri @ M.T

    W,H = size
    ext = np.abs(v[:,:,:2]).max()*2.15
    s = min(W,H)/ext
    px = v[:,:,0]*s + W/2
    py = -v[:,:,1]*s + H/2
    pz = v[:,:,2]

    n = np.cross(v[:,1]-v[:,0], v[:,2]-v[:,0])
    ln = np.linalg.norm(n,axis=1,keepdims=True); ln[ln==0]=1
    n = n/ln
    light = np.array([0.35,0.55,0.76]); light/=np.linalg.norm(light)
    lam = np.clip(n @ light, 0, 1)
    shade = (0.22 + 0.78*lam)

    zbuf = np.full((H,W), -1e30); col = np.zeros((H,W))
    order = np.argsort(pz.mean(1))
    for i in order:
        x0,x1,x2 = px[i]; y0,y1,y2 = py[i]
        minx=int(max(0,np.floor(min(x0,x1,x2)))); maxx=int(min(W-1,np.ceil(max(x0,x1,x2))))
        miny=int(max(0,np.floor(min(y0,y1,y2)))); maxy=int(min(H-1,np.ceil(max(y0,y1,y2))))
        if minx>maxx or miny>maxy: continue
        xs=np.arange(minx,maxx+1); ys=np.arange(miny,maxy+1)
        X,Y=np.meshgrid(xs,ys)
        d=(y1-y2)*(x0-x2)+(x2-x1)*(y0-y2)
        if abs(d)<1e-12: continue
        w0=((y1-y2)*(X-x2)+(x2-x1)*(Y-y2))/d
        w1=((y2-y0)*(X-x2)+(x0-x2)*(Y-y2))/d
        w2=1-w0-w1
        m=(w0>=-1e-6)&(w1>=-1e-6)&(w2>=-1e-6)
        if not m.any(): continue
        z=w0*pz[i,0]+w1*pz[i,1]+w2*pz[i,2]
        sub=zbuf[miny:maxy+1,minx:maxx+1]
        upd=m&(z>sub)
        sub[upd]=z[upd]
        col[miny:maxy+1,minx:maxx+1][upd]=shade[i]

    img=np.full((H,W,3),245,dtype=np.uint8)
    hit=zbuf>-1e29
    base=np.array([214,88,64])
    img[hit]=np.clip(col[hit][:,None]*base[None,:],0,255).astype(np.uint8)
    Image.fromarray(img).save(out); print(out, f"{tri.shape[0]} tris")

t=load(sys.argv[1])
render(t, sys.argv[2],
       elev=float(sys.argv[3]) if len(sys.argv)>3 else 22,
       azim=float(sys.argv[4]) if len(sys.argv)>4 else -38)
