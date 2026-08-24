import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

interface Props {
  positions: Float32Array | null;
  indices: Uint32Array | null;
}

/** Below this the sweep bands shade as one smooth surface; above it stays a hard edge. */
const CREASE_DEG = 30;
const FOV_DEG = 38;
/** Breathing room around the model when framing it. */
const FIT_MARGIN = 1.12;

export const Viewer = ({ positions, indices }: Props): React.ReactElement => {
  const host = useRef<HTMLDivElement>(null);
  const mesh = useRef<THREE.Mesh | null>(null);
  const scene = useRef<THREE.Scene | null>(null);

  // Spherical camera around `target`; panning slides the target.
  // The alpha = 0 cap carries the readable text and sits at minimum z, so the
  // camera belongs below and in front of the tag. Orbiting up and behind, the
  // obvious-looking default, shows only the backs of the swept strokes.
  const HOME_AZ = -0.5;
  const HOME_EL = -0.6;

  const cam = useRef({
    az: HOME_AZ, el: HOME_EL, dist: 160,
    target: new THREE.Vector3(),
    home: 160,
    radius: 60,
  });
  const fitRef = useRef<() => void>(() => {});
  const drag = useRef<{ mode: 'orbit' | 'pan' | null; x: number; y: number }>({ mode: null, x: 0, y: 0 });

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const sc = new THREE.Scene();
    scene.current = sc;
    const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    sc.add(new THREE.HemisphereLight(0xffffff, 0x50555f, 1.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-50, 55, 95);
    sc.add(key);
    const fill = new THREE.DirectionalLight(0xffd9c0, 0.55);
    fill.position.set(70, -30, -50);
    sc.add(fill);

    const place = (): void => {
      const c = cam.current;
      camera.position.set(
        c.target.x + c.dist * Math.cos(c.el) * Math.sin(c.az),
        c.target.y + c.dist * Math.sin(c.el),
        c.target.z + c.dist * Math.cos(c.el) * Math.cos(c.az),
      );
      camera.lookAt(c.target);
    };

    /**
     * Frame the bounding sphere. A wide, shallow tag is limited by the
     * horizontal field of view long before the vertical one, so fitting on
     * vertical FOV alone crops the ends off every long name.
     */
    const fit = (): void => {
      const c = cam.current;
      const vFov = (FOV_DEG * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
      const need = c.radius / Math.sin(Math.min(vFov, hFov) / 2);
      c.home = need * FIT_MARGIN;
      c.dist = c.home;
      c.target.set(0, 0, 0);
    };
    fitRef.current = fit;

    const resize = (): void => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      fit();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    const loop = (): void => {
      place();
      renderer.render(sc, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    // Left drag orbits; middle, right or shift-left pans. Right-click menu is
    // suppressed so a right-drag pan does not open it on release.
    const down = (e: PointerEvent): void => {
      drag.current.mode = e.button === 0 && !e.shiftKey ? 'orbit' : 'pan';
      drag.current.x = e.clientX;
      drag.current.y = e.clientY;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const move = (e: PointerEvent): void => {
      const d = drag.current;
      if (!d.mode) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      const c = cam.current;

      if (d.mode === 'orbit') {
        c.az -= dx * 0.008;
        c.el = Math.max(-1.45, Math.min(1.45, c.el + dy * 0.008));
        return;
      }
      // Pan in the camera plane, scaled so the model tracks the cursor
      // regardless of zoom.
      const perPx = (2 * c.dist * Math.tan((38 * Math.PI) / 360)) / Math.max(1, el.clientHeight);
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      c.target.addScaledVector(right, -dx * perPx);
      c.target.addScaledVector(up, dy * perPx);
    };
    const up = (e: PointerEvent): void => {
      drag.current.mode = null;
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      cam.current.dist = Math.max(15, Math.min(2000, cam.current.dist * (1 + e.deltaY * 0.0012)));
    };
    const menu = (e: Event): void => e.preventDefault();
    const dbl = (): void => {
      cam.current.az = HOME_AZ;
      cam.current.el = HOME_EL;
      fitRef.current();
    };

    const cv = renderer.domElement;
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', wheel, { passive: false });
    cv.addEventListener('contextmenu', menu);
    cv.addEventListener('dblclick', dbl);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      cv.removeEventListener('wheel', wheel);
      cv.removeEventListener('contextmenu', menu);
      cv.removeEventListener('dblclick', dbl);
      renderer.dispose();
      el.removeChild(cv);
    };
  }, []);

  useEffect(() => {
    const sc = scene.current;
    if (!sc || !positions || !indices) return;

    if (mesh.current) {
      sc.remove(mesh.current);
      mesh.current.geometry.dispose();
      (mesh.current.material as THREE.Material).dispose();
    }

    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setIndex(new THREE.BufferAttribute(indices, 1));

    // Centre on the bounding *sphere*, not the box: the box centre of a fan
    // shape sits off to one side of the mass, which puts the orbit pivot
    // somewhere the model is not.
    g.computeBoundingSphere();
    const c = g.boundingSphere?.center;
    if (c) g.translate(-c.x, -c.y, -c.z);

    // The caps share vertices with the walls, so plain computeVertexNormals
    // averages a flat cap against a perpendicular wall and the flat faces
    // read as domed. Splitting on a crease angle keeps the caps flat and the
    // sweep smooth.
    g = toCreasedNormals(g, THREE.MathUtils.degToRad(CREASE_DEG));
    g.computeBoundingSphere();

    const m = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color: 0xd8664a, roughness: 0.48, metalness: 0.05 }),
    );
    sc.add(m);
    mesh.current = m;

    cam.current.radius = g.boundingSphere?.radius ?? 60;
    fitRef.current();
  }, [positions, indices]);

  return (
    <div ref={host} className="viewer">
      <div className="hint">drag orbit · right-drag or shift-drag pan · scroll zoom · double-click reset</div>
    </div>
  );
};
