"""Render an STL with the same spherical camera the web viewer uses, so a
default (azimuth, elevation) can be chosen by looking rather than guessing."""
import sys, struct
import numpy as np
from PIL import Image

def load(path):
    with open(path,'rb') as f:
        f.read(80); n=struct.unpack('<I', f.read(4))[0]
        d=np.frombuffer(f.read(n*50), dtype=np.uint8).reshape(n,50)
    return d[:,12:48].copy().view(np.float32).reshape(n,3,3)

def render(tri, out, az, el, size=(760,520), fov=38.0, margin=1.12, sweep=60.0):
    v = tri.reshape(-1,3)
    c = (v.min(0)+v.max(0))/2
    tri = tri - c
    r = np.linalg.norm(tri.reshape(-1,3), axis=1).max()
    W,H = size; aspect = W/H
    vf = np.radians(fov); hf = 2*np.arctan(np.tan(vf/2)*aspect)
    dist = r/np.sin(min(vf,hf)/2)*margin
    # same face-relative basis the web viewer orbits in
    a = np.radians(sweep)
    fR = np.array([1.0,0,0]); fU = np.array([0,np.cos(a),np.sin(a)]); fN = np.array([0,-np.sin(a),np.cos(a)])
    d = fN*np.cos(el)*np.cos(az) + fR*np.cos(el)*np.sin(az) + fU*np.sin(el)
    eye = d*dist
    fwd = -d/np.linalg.norm(d)
    right = np.cross(fwd,fU); right/=np.linalg.norm(right)
    up = np.cross(right,fwd)
    M = np.stack([right,up,-fwd])
    p = (tri - eye) @ M.T
    z = -p[:,:,2]; z[z<1e-6]=1e-6
    f = (H/2)/np.tan(vf/2)
    px = p[:,:,0]/z*f + W/2; py = -p[:,:,1]/z*f + H/2
    n = np.cross(tri[:,1]-tri[:,0], tri[:,2]-tri[:,0])
    ln = np.linalg.norm(n,axis=1,keepdims=True); ln[ln==0]=1; n=n/ln
    # headlight, offset a little so faces at grazing angles still separate
    L = -fwd + right*0.35 + up*0.45; L/=np.linalg.norm(L)
    sh = 0.25+0.75*np.clip(n@L,0,1)
    zb = np.full((H,W),1e30); col=np.zeros((H,W))
    for i in np.argsort(-z.mean(1)):
        x0,x1,x2=px[i]; y0,y1,y2=py[i]
        mnx=int(max(0,np.floor(min(x0,x1,x2)))); mxx=int(min(W-1,np.ceil(max(x0,x1,x2))))
        mny=int(max(0,np.floor(min(y0,y1,y2)))); mxy=int(min(H-1,np.ceil(max(y0,y1,y2))))
        if mnx>mxx or mny>mxy: continue
        X,Y=np.meshgrid(np.arange(mnx,mxx+1),np.arange(mny,mxy+1))
        d=(y1-y2)*(x0-x2)+(x2-x1)*(y0-y2)
        if abs(d)<1e-12: continue
        w0=((y1-y2)*(X-x2)+(x2-x1)*(Y-y2))/d; w1=((y2-y0)*(X-x2)+(x0-x2)*(Y-y2))/d; w2=1-w0-w1
        m=(w0>=-1e-6)&(w1>=-1e-6)&(w2>=-1e-6)
        if not m.any(): continue
        zz=w0*z[i,0]+w1*z[i,1]+w2*z[i,2]
        sub=zb[mny:mxy+1,mnx:mxx+1]; upd=m&(zz<sub)
        sub[upd]=zz[upd]; col[mny:mxy+1,mnx:mxx+1][upd]=sh[i]
    img=np.full((H,W,3),22,dtype=np.uint8)
    hit=zb<1e29
    img[hit]=np.clip(col[hit][:,None]*np.array([216,102,74])[None,:],0,255).astype(np.uint8)
    Image.fromarray(img).save(out)

t=load(sys.argv[1])
render(t, sys.argv[2], float(sys.argv[3]), float(sys.argv[4]))
