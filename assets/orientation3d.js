/**
 * orientation3d.js
 * Live 3D attitude viewers (rocket + CanSat) driven by the BNO08x roll/pitch/yaw.
 *
 * script.js's updateCube() stores the latest angles in window.__orientLatest[id];
 * this module reads them every frame, so there is no load-order dependency.
 *
 * DEFAULT POSE: roll = pitch = 0 (avionics board flat/horizontal) -> model stands UP.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// CONFIG  -- the only part you should ever need to edit
// ---------------------------------------------------------------------------
// modelUp   : which axis of the .glb file is the model's "top / nose" direction.
// boardNose : which axis of the avionics board runs along the vehicle body ('x'|'y'|'z').
//             Board frame assumed: X forward, Y left, Z up when the board lies flat.
// sign      : flip a value to -1 if that angle rotates the wrong way on your hardware.
const CONFIG = {
  'rkt-orientation-model': {
    url: 'assets/models/rocket.glb',
    modelUp: [0, 1, 0],        // rocket.glb: nose at +Y, fins at -Y
    boardNose: 'x',
    sign: { roll: 1, pitch: 1, yaw: 1 },
  },
  'cs-orientation-model': {
    url: 'assets/models/cansat.glb',
    modelUp: [0, 0, 1],        // cansat.glb: long axis is Z. Use [0,0,-1] if it appears upside-down.
    boardNose: 'x',
    sign: { roll: 1, pitch: 1, yaw: 1 },
  },
};

const SMOOTHING = 0.25;       // 0..1, higher = snappier, lower = smoother
const MODEL_SIZE = 2.6;       // largest model dimension in scene units
const DEG = Math.PI / 180;

// Where each board axis points on screen (x right, y up, z toward viewer) when the
// vehicle is in its neutral pose (nose up on screen, board "up" toward the viewer).
const BASIS = {
  x: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],
  y: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  z: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
};

window.__orientLatest = window.__orientLatest || {};

// ---------------------------------------------------------------------------

function robustBounds(root) {
  // Ignore stray outlier vertices (the rocket file has a few far-away points).
  root.updateMatrixWorld(true);
  const xs = [], ys = [], zs = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      xs.push(v.x); ys.push(v.y); zs.push(v.z);
    }
  });
  const pick = (a, q) => { const s = Float32Array.from(a).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]; };
  const lo = new THREE.Vector3(pick(xs, 0.01), pick(ys, 0.01), pick(zs, 0.01));
  const hi = new THREE.Vector3(pick(xs, 0.99), pick(ys, 0.99), pick(zs, 0.99));
  return { lo, hi };
}

function makeViewer(id, cfg) {
  const img = document.getElementById(id);
  if (!img) return null;
  const host = img.parentElement;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = 'orientation-3d';
  renderer.domElement.title = 'Double-click to zero heading (yaw)';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 6.5);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 5, 6);
  scene.add(sun);

  const pivot = new THREE.Group();   // receives the live attitude
  scene.add(pivot);

  // sensor frame -> screen frame change of basis
  const b = BASIS[cfg.boardNose];
  const qS = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...b[0]), new THREE.Vector3(...b[1]), new THREE.Vector3(...b[2]))
  );
  const qSinv = qS.clone().invert();

  const state = { ready: false, yaw0: null, lastYaw: 0, target: new THREE.Quaternion() };

  const resize = () => {
    const w = host.clientWidth || 180, h = host.clientHeight || 170;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  resize();

  renderer.domElement.addEventListener('dblclick', () => { state.yaw0 = state.lastYaw; });

  new GLTFLoader().load(
    cfg.url,
    (gltf) => {
      const model = gltf.scene;
      const { lo, hi } = robustBounds(model);
      const centre = lo.clone().add(hi).multiplyScalar(0.5);
      const size = hi.clone().sub(lo);
      model.position.sub(centre);                       // centre on origin

      const fit = new THREE.Group();                    // orient model's "up" to screen up + scale
      fit.add(model);
      fit.quaternion.setFromUnitVectors(new THREE.Vector3(...cfg.modelUp).normalize(), new THREE.Vector3(0, 1, 0));
      fit.scale.setScalar(MODEL_SIZE / Math.max(size.x, size.y, size.z));
      pivot.add(fit);

      state.ready = true;
      img.style.display = 'none';                       // hide the old 2D fallback image
    },
    undefined,
    (err) => console.error(`[orientation3d] failed to load ${cfg.url}`, err)
  );

  const euler = new THREE.Euler(0, 0, 0, 'ZYX');
  const qAtt = new THREE.Quaternion();

  return {
    frame() {
      if (!state.ready) return;
      const a = window.__orientLatest[id] || { pitch: 0, roll: 0, yaw: 0 };
      state.lastYaw = a.yaw;
      // Zero the heading on the first real sample (yaw has no gravity reference).
      if (state.yaw0 === null && (a.pitch || a.roll || a.yaw)) state.yaw0 = a.yaw;
      const yaw = a.yaw - (state.yaw0 || 0);

      euler.set(a.roll * cfg.sign.roll * DEG, a.pitch * cfg.sign.pitch * DEG, yaw * cfg.sign.yaw * DEG, 'ZYX');
      qAtt.setFromEuler(euler);
      state.target.copy(qS).multiply(qAtt).multiply(qSinv);   // attitude expressed in screen axes
      pivot.quaternion.slerp(state.target, SMOOTHING);
      renderer.render(scene, camera);
    },
  };
}

const viewers = Object.entries(CONFIG).map(([id, cfg]) => makeViewer(id, cfg)).filter(Boolean);
(function loop() {
  if (!document.hidden) viewers.forEach((v) => v.frame());
  requestAnimationFrame(loop);
})();
