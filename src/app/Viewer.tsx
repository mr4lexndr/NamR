import { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface Props {
  positions: Float32Array | null;
  indices: Uint32Array | null;
}

/**
 * Orbit preview. The tag is built with the alpha = 0 face on z = 0, so the
 * camera starts in front of that face -- looking from the other side shows
 * only the backs of the swept strokes and reads as an unrecognisable slab.
 */
export const Viewer = ({ positions, indices }: Props): React.ReactElement => {
  const host = useRef<HTMLDivElement>(null);
  const mesh = useRef<THREE.Mesh | null>(null);
  const scene = useRef<THREE.Scene | null>(null);
  const drag = useRef({ on: false, x: 0, y: 0, az: -0.5, el: 0.5, dist: 160 });

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const sc = new THREE.Scene();
    scene.current = sc;
    const cam = new THREE.PerspectiveCamera(38, 1, 1, 2000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    sc.add(new THREE.HemisphereLight(0xffffff, 0x606070, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(-40, 40, 90);
    sc.add(key);
    const rim = new THREE.DirectionalLight(0xffd9c0, 0.7);
    rim.position.set(60, -20, -60);
    sc.add(rim);

    const place = (): void => {
      const d = drag.current;
      cam.position.set(
        d.dist * Math.cos(d.el) * Math.sin(d.az),
        d.dist * Math.sin(d.el),
        d.dist * Math.cos(d.el) * Math.cos(d.az),
      );
      cam.lookAt(0, 0, 0);
    };

    const resize = (): void => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      cam.aspect = w / Math.max(1, h);
      cam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    const loop = (): void => {
      place();
      renderer.render(sc, cam);
      raf = requestAnimationFrame(loop);
    };
    loop();

    const down = (e: PointerEvent): void => {
      drag.current.on = true;
      drag.current.x = e.clientX;
      drag.current.y = e.clientY;
      (e.target as Element).setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent): void => {
      const d = drag.current;
      if (!d.on) return;
      d.az -= (e.clientX - d.x) * 0.008;
      d.el = Math.max(-1.45, Math.min(1.45, d.el + (e.clientY - d.y) * 0.008));
      d.x = e.clientX;
      d.y = e.clientY;
    };
    const up = (): void => { drag.current.on = false; };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      drag.current.dist = Math.max(40, Math.min(600, drag.current.dist * (1 + e.deltaY * 0.0012)));
    };
    el.addEventListener('pointerdown', down);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointerdown', down);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const sc = scene.current;
    if (!sc || !positions || !indices) return;

    if (mesh.current) {
      sc.remove(mesh.current);
      mesh.current.geometry.dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.center();

    const m = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color: 0xd8664a, roughness: 0.52, metalness: 0.04 }),
    );
    sc.add(m);
    mesh.current = m;

    const r = g.boundingSphere?.radius ?? 60;
    drag.current.dist = r * 2.9;
  }, [positions, indices]);

  return <div ref={host} className="viewer" />;
};
