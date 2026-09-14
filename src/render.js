// src/render.js — TURBO CIRCUIT: the presentation layer (Three.js r169, vendored).
//
// This file owns the SCENE and the CAMERA, nothing else:
//   · karts come from karts.js        (createKart / updateKartVisual)
//   · thrown items come from item-visuals.js (createItemVisuals)
//   · particles come from fx.js       (createFX) — render.js owns its lifecycle
//   · game rules live in sim.js — draw() READS state and never writes to it
//
// It also owns interpolation. The sim ticks at a fixed 60 Hz while the display may run at 30,
// 60, 120 or an erratic 57; draw(state, alpha) blends the previous tick into the current one by
// `alpha`. Without that, the karts visibly stutter on any display that is not exactly 60 Hz.
import * as THREE from '../vendor/three.module.js';
import { PALETTE, ITEMS, SIM, CHARS, KARTS } from './content.js';
import { createKart, updateKartVisual } from './karts.js';
import { createItemVisuals } from './item-visuals.js';
import { createFX } from './fx.js';

const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
const hex = (c) => new THREE.Color(c);

// Merge a list of BufferGeometries that share the same attribute set. three.js ships
// BufferGeometryUtils in an addon we deliberately do not vendor, and this is all we need.
function mergeGeometries(list) {
  let vCount = 0, iCount = 0;
  for (const g of list) { vCount += g.attributes.position.count; iCount += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position.array, n = g.attributes.normal ? g.attributes.normal.array : null;
    const c = g.attributes.color ? g.attributes.color.array : null;
    pos.set(p, vo * 3);
    if (n) nor.set(n, vo * 3);
    if (c) col.set(c, vo * 3); else for (let i = 0; i < g.attributes.position.count; i++) col[(vo + i) * 3] = 1;
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo; io += g.index.count; }
    else { for (let i = 0; i < g.attributes.position.count; i++) idx[io + i] = vo + i; io += g.attributes.position.count; }
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// A box, positioned and coloured — the atom every piece of scenery is built from.
function box(w, h, d, x, y, z, colour, rotY = 0, rotZ = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  if (rotZ) g.rotateZ(rotZ);
  if (rotY) g.rotateY(rotY);
  const c = hex(colour);
  const arr = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < g.attributes.position.count; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
function cyl(rTop, rBot, h, seg, x, y, z, colour, rotX = 0, rotZ = 0) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  const c = hex(colour);
  const arr = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < g.attributes.position.count; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// ── one geometry per scenery kind, then InstancedMesh per kind (a few draw calls, not 500) ──
function sceneryGeometry(kind, theme) {
  switch (kind) {
    case 'palm':
      return mergeGeometries([
        cyl(0.22, 0.34, 5.2, 6, 0, 2.6, 0, '#6b4f2a', 0, 0.12),
        box(3.4, 0.18, 0.7, 0, 5.3, 0, '#2f7a3a', 0.5),
        box(3.2, 0.18, 0.7, 0, 5.4, 0, '#357f3f', -0.7),
        box(2.8, 0.18, 0.7, 0, 5.2, 0, '#2b6f35', 1.6),
      ]);
    case 'rock':
      return mergeGeometries([
        box(1.7, 1.1, 1.5, 0, 0.5, 0, '#7b7468', 0.4),
        box(1.0, 0.8, 1.1, 0.7, 0.35, 0.3, '#8b8478', 1.1),
      ]);
    case 'buoy':
      return mergeGeometries([
        cyl(0.35, 0.5, 1.4, 8, 0, 0.7, 0, PALETTE.warn),
        cyl(0.12, 0.12, 1.1, 6, 0, 1.9, 0, '#dddddd'),
      ]);
    case 'lighthouse':
      return mergeGeometries([
        cyl(1.1, 1.7, 9, 10, 0, 4.5, 0, '#f2f2f2'),
        cyl(1.25, 1.25, 1.6, 10, 0, 9.6, 0, PALETTE.kerbB),
        cyl(0.9, 0.9, 0.9, 10, 0, 10.7, 0, '#ffe9a8'),
      ]);
    case 'grandstand':
      return mergeGeometries([
        box(14, 1.2, 7, 0, 0.6, 0, '#b9b9c4'),
        box(14, 3.4, 1.0, 0, 2.6, -3.2, '#a9a9b6'),
        box(14, 0.9, 6, 0, 1.7, 0.4, PALETTE.grandstand),
        box(13, 1.0, 1.1, 0, 4.3, -3.1, '#8f8f9c'),
      ]);
    case 'crane':
      return mergeGeometries([
        box(1.2, 12, 1.2, 0, 6, 0, '#e0a52a'),
        box(11, 1.0, 1.0, 4.5, 11.6, 0, '#e0a52a'),
        box(1.0, 1.0, 1.0, 9.4, 10.6, 0, '#9a9a9a'),
        box(2.4, 1.6, 2.4, 0, 0.8, 0, '#3a3a44'),
      ]);
    case 'container':
      return mergeGeometries([
        box(6.1, 2.6, 2.44, 0, 1.3, 0, '#c0392b'),
        box(6.1, 2.6, 2.44, 0, 3.95, 0, '#2b7bbf'),
        box(6.1, 2.6, 2.44, 0, 6.6, 0, '#e0a52a'),
      ]);
    case 'neon':
      return mergeGeometries([
        box(0.9, 7.5, 0.9, 0, 3.75, 0, '#2a2a35'),
        box(0.7, 3.4, 0.7, 0, 7.6, 0, '#c06bff'),
        box(2.6, 0.5, 0.5, 0, 7.0, 0, '#7cf9ff'),
      ]);
    case 'pylon':
      return mergeGeometries([
        box(0.8, 9, 0.8, 0, 4.5, 0, '#9aa0a6'),
        box(3.2, 0.4, 0.4, 0, 8.6, 0, '#c6ccd2'),
        box(2.4, 0.4, 0.4, 0, 7.4, 0, '#c6ccd2'),
      ]);
    case 'pine':
      return mergeGeometries([
        cyl(0.2, 0.32, 1.6, 6, 0, 0.8, 0, '#4a3520'),
        cyl(0.02, 1.7, 3.4, 8, 0, 3.2, 0, '#1d5c35'),
        cyl(0.02, 1.3, 2.6, 8, 0, 5.1, 0, '#226b3d'),
      ]);
    case 'chalet':
      return mergeGeometries([
        box(6, 3.4, 5, 0, 1.7, 0, '#8a6a44'),
        box(7, 0.5, 6, 0, 3.7, 0, '#5c4026'),
        box(1.6, 2.2, 1.6, 0, 4.6, 0, '#7a5a3a'),
        box(5.2, 1.6, 0.3, 0, 1.6, 2.6, '#e8dfc9'),
      ]);
    case 'banner':
      return mergeGeometries([
        box(0.4, 6, 0.4, -3, 3, 0, '#8c8c96'),
        box(0.4, 6, 0.4, 3, 3, 0, '#8c8c96'),
        box(7.2, 1.8, 0.25, 0, 5, 0, theme === 'alpine' ? '#2a6dd6' : '#c0392b'),
      ]);
    case 'cablecar':
      return mergeGeometries([
        box(0.5, 14, 0.5, 0, 7, 0, '#8c8c96'),
        box(4, 0.35, 0.35, 2, 13.2, 0, '#6b6b76'),
        box(2.2, 1.8, 1.8, 3.2, 11.9, 0, '#d64545'),
      ]);
    default:
      return mergeGeometries([cyl(0.02, 1.5, 3.2, 7, 0, 2.4, 0, '#2f6f3a')]);
  }
}

export function createRenderer(canvas, opts = {}) {
  let quality = opts.quality || 'high';
  let renderer = null, scene = null, camera = null;
  let track = null, builtFor = -1;
  let fx = null, itemVisuals = null;
  const kartMeshes = [];
  let kartRig = [];
  let sunLight = null, hemi = null, dirTarget = null;
  const disposables = [];
  const camState = { pos: new THREE.Vector3(0, 6, -12), look: new THREE.Vector3(), fov: 62, shake: 0, orbit: 0 };
  const W = { w: 1, h: 1 };

  const info = { calls: 0, triangles: 0, fps: 0 };

  // ── WebGL. If the context cannot be created the game must still boot and report honestly
  //    rather than throwing on frame one (headless Chrome without SwiftShader is a real case).
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'high', powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, quality === 'high' ? 2 : 1.25));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = quality === 'high';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  } catch (e) {
    renderer = null;
    if (typeof console !== 'undefined') console.error('WebGL unavailable:', e && e.message);
  }

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(camState.fov, 16 / 9, 0.3, 2600);
  camera.position.set(0, 8, -16);

  // ── lights (built once, re-aimed per track)
  hemi = new THREE.HemisphereLight(0xbcd7ff, 0x4a4a38, 0.85);
  scene.add(hemi);
  sunLight = new THREE.DirectionalLight(0xfff3c4, 2.1);
  sunLight.position.set(120, 180, 90);
  sunLight.castShadow = quality === 'high';
  if (sunLight.castShadow) {
    sunLight.shadow.mapSize.set(2048, 2048);
    const d = 90;
    sunLight.shadow.camera.left = -d; sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d; sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.camera.near = 1; sunLight.shadow.camera.far = 620;
    sunLight.shadow.bias = -0.0012;
    sunLight.shadow.normalBias = 0.05;
  }
  scene.add(sunLight);
  dirTarget = new THREE.Object3D();
  scene.add(dirTarget);
  sunLight.target = dirTarget;

  const trackGroup = new THREE.Group(); scene.add(trackGroup);
  const kartGroup = new THREE.Group(); scene.add(kartGroup);
  const padGroup = new THREE.Group(); scene.add(padGroup);
  const coinGroup = new THREE.Group(); scene.add(coinGroup);

  function clearGroup(g) {
    for (let i = g.children.length - 1; i >= 0; i--) g.remove(g.children[i]);
  }
  function killGroup(g) {
    for (const c of g.children) {
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (Array.isArray(c.material)) c.material.forEach(m => m.dispose()); else c.material.dispose(); }
    }
    clearGroup(g);
  }

  // ── sky dome: a vertical gradient matched to the track theme
  function buildSky(theme) {
    const cols = theme === 'city' ? PALETTE.skyNight : theme === 'alpine' ? PALETTE.skyAlpine : PALETTE.sky;
    const g = new THREE.SphereGeometry(1900, 32, 20);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: hex(cols[2]) }, mid: { value: hex(cols[1]) }, bot: { value: hex(cols[0]) },
      },
      vertexShader: `varying float vH; void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vH = normalize(wp.xyz).y; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying float vH;
        void main(){ float h = clamp(vH*0.5+0.5, 0.0, 1.0);
          vec3 c = h < 0.5 ? mix(bot, mid, h*2.0) : mix(mid, top, (h-0.5)*2.0);
          gl_FragColor = vec4(c, 1.0); }`,
    });
    const sky = new THREE.Mesh(g, m);
    sky.frustumCulled = false;
    disposables.push(g, m);
    return sky;
  }

  function init(t, roster) {
    track = t;
    builtFor = t.index;
    killGroup(trackGroup); killGroup(kartGroup); killGroup(padGroup); killGroup(coinGroup);
    kartMeshes.length = 0;
    if (fx) { fx.dispose(); fx = null; }
    if (itemVisuals) { itemVisuals.dispose(); itemVisuals = null; }

    const theme = t.theme;
    // sky + fog
    const cols = theme === 'city' ? PALETTE.skyNight : theme === 'alpine' ? PALETTE.skyAlpine : PALETTE.sky;
    scene.add(buildSky(theme));
    scene.background = null;
    scene.fog = new THREE.Fog(hex(theme === 'city' ? '#0a0e26' : theme === 'alpine' ? '#bcd9f2' : PALETTE.fog), 260, 1500);
    hemi.color = hex(theme === 'city' ? '#3a4a7a' : '#bcd7ff');
    hemi.groundColor = hex(theme === 'alpine' ? '#8fa3b8' : theme === 'city' ? '#1a1a26' : '#5a6b45');
    hemi.intensity = theme === 'city' ? 0.55 : 0.95;
    sunLight.color = hex(theme === 'city' ? '#cfe0ff' : PALETTE.sun);
    sunLight.intensity = theme === 'city' ? 1.1 : 2.1;

    // ground plane, so the world does not end at the road
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4200, 4200, 1, 1),
      new THREE.MeshStandardMaterial({
        color: hex(theme === 'alpine' ? PALETTE.grassSnow : theme === 'city' ? PALETTE.grassNight : PALETTE.grass),
        roughness: 1, metalness: 0,
      }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.6;
    ground.receiveShadow = false;
    trackGroup.add(ground);

    const ms = t.meshSpec;
    // road
    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(ms.verts, 3));
    roadGeo.setIndex(ms.idx);
    roadGeo.computeVertexNormals();
    const roadMat = new THREE.MeshStandardMaterial({
      color: hex(theme === 'city' ? PALETTE.roadWet : PALETTE.road), roughness: 0.85, metalness: theme === 'city' ? 0.25 : 0.03,
    });
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.receiveShadow = quality === 'high';
    trackGroup.add(road);

    // kerbs, with alternating red/white banding driven by vertex colours
    const kv = ms.kerbs.verts, ki = ms.kerbs.idx;
    const kGeo = new THREE.BufferGeometry();
    kGeo.setAttribute('position', new THREE.Float32BufferAttribute(kv, 3));
    const kcol = new Float32Array(kv.length);
    const cA = hex(PALETTE.kerbA), cB = hex(PALETTE.kerbB);
    for (let i = 0; i < kv.length / 3; i++) {
      const band = Math.floor(i / 4) % 2;
      const c = band ? cB : cA;
      kcol[i * 3] = c.r; kcol[i * 3 + 1] = c.g; kcol[i * 3 + 2] = c.b;
    }
    kGeo.setAttribute('color', new THREE.BufferAttribute(kcol, 3));
    kGeo.setIndex(ki);
    kGeo.computeVertexNormals();
    const kerb = new THREE.Mesh(kGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    kerb.receiveShadow = false;
    trackGroup.add(kerb);

    // walls: one InstancedMesh for the whole circuit
    if (ms.walls.length) {
      const wGeo = new THREE.BoxGeometry(1, 1.5, 1);
      const wMat = new THREE.MeshStandardMaterial({ color: hex(PALETTE.wall), roughness: 0.75, metalness: 0.1 });
      const inst = new THREE.InstancedMesh(wGeo, wMat, ms.walls.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3();
      ms.walls.forEach((w, i) => {
        p3.set(w.x, w.y + 0.75, w.z);
        q.setFromEuler(new THREE.Euler(0, w.rot, 0));
        s3.set(0.45, 1, w.len);
        m4.compose(p3, q, s3);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = quality === 'high';
      trackGroup.add(inst);
    }

    // boost pads: emissive chevrons on the road
    for (const b of t.boostPads) {
      const g = new THREE.PlaneGeometry(b.halfWidth * 2, 4.4, 1, 1);
      const m = new THREE.MeshStandardMaterial({ color: hex(PALETTE.boost), emissive: hex(PALETTE.boost), emissiveIntensity: 0.85, transparent: true, opacity: 0.9 });
      const mesh = new THREE.Mesh(g, m);
      const p = t.pointAt(b.s0 + 2.2);
      mesh.position.set(p.x, t.y(p.x, p.z) + 0.06, p.z);
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -Math.atan2(p.tx, p.tz);
      padGroup.add(mesh);
    }

    // coins
    const coinGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.1, 12);
    const coinMat = new THREE.MeshStandardMaterial({ color: hex(PALETTE.hudWarm), emissive: hex('#6b5200'), roughness: 0.3, metalness: 0.8 });
    for (let i = 0; i < t.coins.length; i++) {
      const mesh = new THREE.Mesh(coinGeo, coinMat);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(t.coins[i].x, t.coins[i].y, t.coins[i].z);
      coinGroup.add(mesh);
    }

    // scenery: one InstancedMesh per kind
    const byKind = new Map();
    for (const s of ms.scenery) {
      if (!byKind.has(s.kind)) byKind.set(s.kind, []);
      byKind.get(s.kind).push(s);
    }
    const maxPer = quality === 'high' ? Infinity : 26;
    for (const [kind, list] of byKind) {
      const geo = sceneryGeometry(kind, theme);
      disposables.push(geo);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });
      const inst = new THREE.InstancedMesh(geo, mat, Math.min(list.length, maxPer));
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s3 = new THREE.Vector3(), p3 = new THREE.Vector3();
      let n = 0;
      for (const s of list) {
        if (n >= inst.count) break;
        p3.set(s.x, s.y, s.z);
        q.setFromEuler(new THREE.Euler(0, s.rot, 0));
        s3.set(s.scale, s.scale, s.scale);
        m4.compose(p3, q, s3);
        inst.setMatrixAt(n++, m4);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = quality === 'high' && kind !== 'container' && kind !== 'grandstand';
      inst.receiveShadow = false;
      trackGroup.add(inst);
    }

    // start / finish gate
    {
      const g = ms.gate;
      const grp = new THREE.Group();
      const postMat = new THREE.MeshStandardMaterial({ color: hex(PALETTE.startGate), roughness: 0.6 });
      const post = new THREE.BoxGeometry(0.7, 8.5, 0.7);
      const w = t.halfWidth + 2.5;
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(post, postMat);
        p.position.set(side * w, 4.25, 0);
        p.castShadow = quality === 'high';
        grp.add(p);
      }
      const gantry = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 1.4, 1.15, 0.9),
        new THREE.MeshStandardMaterial({ color: hex(PALETTE.hudEdge), emissive: hex('#0d4a55'), emissiveIntensity: 0.5 }));
      gantry.position.set(0, 8.2, 0);
      grp.add(gantry);
      grp.position.set(g.x, g.y, g.z);
      grp.rotation.y = -Math.atan2(Math.sin(g.rot), Math.cos(g.rot));
      trackGroup.add(grp);

      // painted start line
      const line = new THREE.Mesh(new THREE.PlaneGeometry(t.width, 2.2),
        new THREE.MeshStandardMaterial({ color: hex('#f2f2f2'), roughness: 0.9 }));
      const p0 = t.pointAt(0);
      line.position.set(p0.x, t.y(p0.x, p0.z) + 0.05, p0.z);
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -Math.atan2(p0.tx, p0.tz);
      trackGroup.add(line);
    }

    // karts — resolved from the roster by id, so the colours and silhouettes the player picked
    // are the ones on the grid (not a hardcoded palette indexed by slot)
    const rosterChars = (roster && roster.chars) || [];
    const rosterKarts = (roster && roster.karts) || [];
    kartRig = [];
    for (let i = 0; i < rosterChars.length; i++) {
      const charDef = CHARS.find(c => c.id === rosterChars[i]) || CHARS[i % CHARS.length];
      const kartDef = KARTS.find(k => k.id === rosterKarts[i]) || KARTS[i % KARTS.length];
      const mesh = createKart(kartDef, charDef);
      mesh.traverse((o) => { if (o.isMesh) { o.castShadow = quality === 'high'; o.receiveShadow = false; } });
      kartGroup.add(mesh);
      kartMeshes.push(mesh);
      kartRig.push(i);
    }

    fx = createFX(scene);
    itemVisuals = createItemVisuals(scene);
    const c = t.pointAt(0);
    camState.pos.set(c.x - c.tx * 14, 7, c.z - c.tz * 14);
    camState.look.set(c.x, 1, c.z);
    builtFor = t.index;
  }

  function setQuality(q) {
    quality = q;
    if (renderer) {
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q === 'high' ? 2 : 1.25));
      renderer.shadowMap.enabled = q === 'high';
      if (sunLight) sunLight.castShadow = q === 'high';
    }
  }

  function onResize(w, h) {
    W.w = Math.max(2, Math.floor(w || 1));
    W.h = Math.max(2, Math.floor(h || 1));
    camera.aspect = W.w / W.h;
    camera.updateProjectionMatrix();
    if (renderer) renderer.setSize(W.w, W.h, false);
  }

  // ── the chase camera: trails the player, leads into the corner, tightens with speed
  function updateCamera(state, alpha, o) {
    const p = state.racers[o.playerIndex] || state.racers[0];
    if (!p) return;
    const mode = o.camera || 'chase';
    const px = lerp(p._px ?? p.x, p.x, alpha);
    const pz = lerp(p._pz ?? p.z, p.z, alpha);
    const py = lerp(p._py ?? p.y, p.y, alpha);
    const ph = lerpAngle(p._ph ?? p.heading, p.heading, alpha);
    const speed = Math.abs(p.speed);
    const k = 1 - Math.pow(0.0001, o.dt || SIM.STEP);   // frame-rate independent smoothing

    let back, up, lead;
    if (mode === 'far') { back = 26; up = 15; lead = 8; }
    else if (mode === 'orbit') { back = 20; up = 10; lead = 0; }
    else { back = 8.6 + speed * 0.075; up = 3.9 + speed * 0.03; lead = 4.5 + speed * 0.075; }

    const fx2 = Math.sin(ph), fz2 = Math.cos(ph);
    let camAlpha = ph;
    if (mode === 'orbit') { camState.orbit += (o.dt || 0) * 0.35; camAlpha = ph + camState.orbit; }

    const want = new THREE.Vector3(
      px - Math.sin(camAlpha) * back,
      py + up,
      pz - Math.cos(camAlpha) * back,
    );
    camState.pos.lerp(want, Math.min(1, k * (mode === 'chase' ? 1.5 : 2.4)));

    // look slightly ahead of the kart so the corner is visible before the apex
    const look = new THREE.Vector3(px + fx2 * lead, py + (mode === 'chase' ? 1.5 : 1.0), pz + fz2 * lead);
    camState.look.lerp(look, Math.min(1, k * 2.2));
    camera.position.copy(camState.pos);
    camera.lookAt(camState.look);

    // speed FOV and a touch of shake at the top end — cheap, and it sells the speed
    const targetFov = (mode === 'chase' ? 60 : 66) + Math.min(18, speed * 0.55);
    camState.fov = lerp(camState.fov, targetFov, Math.min(1, (o.dt || 0) * 3));
    if (camera.fov !== camState.fov) { camera.fov = camState.fov; camera.updateProjectionMatrix(); }
    if (speed > 18) {
      const amp = (speed - 18) * 0.004 * (p.offTrack ? 2.1 : 1);
      camera.position.x += (Math.sin(o.t * 61) + Math.sin(o.t * 37)) * amp;
      camera.position.y += Math.sin(o.t * 71) * amp * 0.7;
    }
    // keep the road under the camera so it never sinks through a hill
    const gy = track ? track.y(camera.position.x, camera.position.z) : 0;
    if (camera.position.y < gy + 1.6) camera.position.y = gy + 1.6;
  }

  let t = 0;
  function draw(state, alpha = 0, o = {}) {
    if (!renderer || !scene || !track) return;
    t += o.dt || 0;
    const playerIndex = o.playerIndex ?? state.playerIndex ?? 0;

    // karts: interpolated between the last two sim ticks
    for (let i = 0; i < kartMeshes.length && i < state.racers.length; i++) {
      const r = state.racers[i];
      const mesh = kartMeshes[i];
      mesh.position.set(lerp(r._px ?? r.x, r.x, alpha), lerp(r._py ?? r.y, r.y, alpha), lerp(r._pz ?? r.z, r.z, alpha));
      mesh.rotation.y = lerpAngle(r._ph ?? r.heading, r.heading, alpha);
      updateKartVisual(mesh, r, state, t, { dt: o.dt || 0, place: r.place, offTrack: r.offTrack });
    }

    // coins disappear for the racer who took them (the sim tracks that per racer)
    if (coinGroup.children.length) {
      const p = state.racers[playerIndex];
      coinGroup.children.forEach((mesh, i) => {
        const c = state.coins[i];
        mesh.visible = !!c && state.tick >= c.taken[playerIndex];
        if (mesh.visible) { mesh.rotation.z += 0.06; mesh.position.y = c.y + Math.sin(t * 2 + i) * 0.08; }
      });
      void p;
    }

    if (itemVisuals) itemVisuals.sync(state, o.dt || 0);
    if (fx) { fx.emit(o.events || [], state, 1); fx.update(o.dt || 0, state); }

    updateCamera(state, alpha, { ...o, playerIndex, t });

    // keep the sun (and therefore the shadow frustum) near the player
    if (sunLight) {
      const p = state.racers[playerIndex] || state.racers[0];
      if (p) {
        dirTarget.position.set(p.x, p.y, p.z);
        dirTarget.updateMatrixWorld();
        sunLight.position.set(p.x + 120, p.y + 180, p.z + 90);
      }
    }

    renderer.render(scene, camera);
    info.calls = renderer.info.render.calls;
    info.triangles = renderer.info.render.triangles;
  }

  function dispose() {
    if (fx) { fx.dispose(); fx = null; }
    if (itemVisuals) { itemVisuals.dispose(); itemVisuals = null; }
    killGroup(trackGroup); killGroup(kartGroup); killGroup(padGroup); killGroup(coinGroup);
    for (const d of disposables) { try { d.dispose(); } catch (e) { void e; } }
    disposables.length = 0;
    if (renderer) renderer.dispose();
  }

  return {
    init, draw, onResize, setQuality, dispose,
    get info() { return info; },
    get scene() { return scene; },
    get camera() { return camera; },
    get webgl() { return !!renderer; },
    get builtFor() { return builtFor; },
    get kartCount() { return kartMeshes.length; },
  };
}

export default createRenderer;
