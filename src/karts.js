// src/karts.js — TURBO CIRCUIT: KARTS team.
//
// Procedural karts and drivers. No art assets, no loaders, no textures — everything in this
// file is built out of Three.js primitives and measured by test/render.test.mjs as GEOMETRY.
//
// Frozen interface (CONTRACTS.md §6):
//   createKart(kartDef, charDef) -> THREE.Group          userData = { rig, wheels[], body, charRig, kartDef, charDef }
//   updateKartVisual(group, racer, state, t, opts)       opts = { dt, place, offTrack, steer? }
//   solveLegIK(hip, foot, thigh, shin) -> { knee, angle, reachable }
//   kartDimensions(kartDef) -> { wheelBase, track, wheelR, bodyLen, bodyH, charH }
//
// Frame conventions (must stay consistent with content.js/CONTRACTS):
//   +Z is the kart's forward, +Y is up, +X is the kart's LEFT (right-handed: up x forward).
//   updateKartVisual NEVER touches the root group's transform — render.js owns position and
//   heading (root.rotation.y = racer.heading). Everything the visual does happens on child
//   groups: kartYaw (slide / spin-out) -> chassisPivot (roll+pitch) -> chassisSquash (scale).
//   Wheels hang off kartYaw, NOT off the chassis, so suspension/squash/roll can never lift a
//   tyre off the road: a wheel's contact is exactly wheelR below its own pivot, always.
//
// Steering sign convention: opts.steer > 0 turns the kart toward +X (its left). If no steer is
// supplied it is derived from the racer's heading delta (racer.heading - racer._ph), so the
// renderer does not have to pass anything for the wheels to steer.
import * as THREE from '../vendor/three.module.js';
import { SIM, PHYSICS, PALETTE } from './content.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const EPS = 1e-9;
const XAXIS = new THREE.Vector3(1, 0, 0);

const num = (v, d) => (Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ─────────────────────────────────────────────────────────────────────────────── shapes
export const SHAPES = ['wedge', 'teardrop', 'boxy'];

// Per-silhouette proportions, metres. bodyH = moulded body height, charH = seated driver
// height including helmet, measured from the road.
const DIMS = {
  wedge:    { wheelBase: 1.86, track: 1.32, wheelR: 0.27, bodyLen: 2.36, bodyH: 0.44, charH: 1.28 },
  teardrop: { wheelBase: 1.74, track: 1.26, wheelR: 0.28, bodyLen: 2.24, bodyH: 0.56, charH: 1.24 },
  boxy:     { wheelBase: 1.94, track: 1.42, wheelR: 0.31, bodyLen: 2.16, bodyH: 0.58, charH: 1.34 },
};

export function kartDimensions(kartDef) {
  const shape = typeof kartDef === 'string' ? kartDef : (kartDef && kartDef.shape);
  const d = DIMS[shape] || DIMS.wedge;
  return { wheelBase: d.wheelBase, track: d.track, wheelR: d.wheelR, bodyLen: d.bodyLen, bodyH: d.bodyH, charH: d.charH };
}

// ─────────────────────────────────────────────────────────────────────────────── two-bone IK
// One solver, used for BOTH arms and legs (CONTRACTS §6). The knee/elbow is always placed on
// the side of the hip→foot line that the pole vector points to, which makes a backwards-
// bending knee structurally impossible: the solver can only ever return the solution whose
// joint offset has a positive dot product with the pole.
//
//   angle     = INTERIOR joint angle in radians. PI = fully straight, small = fully folded.
//               (flexion = PI - angle; a reversed knee would show up here as angle > PI.)
//   reachable = false when the target is further away than thigh+shin (bones clamp, never
//               stretch) or closer than |thigh-shin|.
const _h2f = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _pl = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _bnd = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const FALLBACK_A = new THREE.Vector3(1, 0, 0);
const FALLBACK_B = new THREE.Vector3(0, 0, 1);

export function solveTwoBoneIK(hip, foot, thigh, shin, pole) {
  const t = Math.max(1e-3, num(thigh, 1e-3));
  const s = Math.max(1e-3, num(shin, 1e-3));
  const hx = num(hip && hip.x, 0), hy = num(hip && hip.y, 0), hz = num(hip && hip.z, 0);
  const fx = num(foot && foot.x, 0), fy = num(foot && foot.y, 0), fz = num(foot && foot.z, 0);

  _h2f.set(fx - hx, fy - hy, fz - hz);
  let L = _h2f.length();
  const maxReach = t + s;
  const minReach = Math.abs(t - s);
  const reachable = L <= maxReach + 1e-7 && L >= minReach - 1e-7;
  // clamp the chain length: bones keep their length, the joint just lands on the line
  const Lc = clamp(L, Math.max(1e-4, minReach + 1e-5), Math.max(1e-4, maxReach - 1e-5));
  if (L < 1e-6) { _h2f.set(0, -1, 0); L = 1e-6; } else { _h2f.multiplyScalar(1 / L); }

  // knee sits at along = a from the hip, offset h perpendicular to the hip→foot line
  const a = (t * t - s * s + Lc * Lc) / (2 * Lc);
  const h = Math.sqrt(Math.max(0, t * t - a * a));

  // bend plane: contains the hip→foot line and the pole
  _pl.set(num(pole && pole.x, 0), num(pole && pole.y, 0), num(pole && pole.z, 1));
  if (_pl.lengthSq() < EPS) _pl.copy(FWD);
  _pl.normalize();
  _nrm.crossVectors(_h2f, _pl);
  if (_nrm.lengthSq() < 1e-8) { // pole parallel to the bone — pick any stable plane
    _nrm.crossVectors(_h2f, UP);
    if (_nrm.lengthSq() < 1e-8) _nrm.crossVectors(_h2f, FALLBACK_A);
    if (_nrm.lengthSq() < 1e-8) _nrm.crossVectors(_h2f, FALLBACK_B);
  }
  _nrm.normalize();
  _bnd.crossVectors(_nrm, _h2f).normalize();     // in-plane, perpendicular to the line
  if (_bnd.dot(_pl) < 0) _bnd.negate();          // ...always the pole side. Never behind.

  // guard against pathological input (NaN in, finite out)
  const ax = _h2f.x, ay = _h2f.y, az = _h2f.z;
  const bx = _bnd.x, by = _bnd.y, bz = _bnd.z;
  const knee = {
    x: hx + ax * a + bx * h,
    y: hy + ay * a + by * h,
    z: hz + az * a + bz * h,
  };
  const cosA = (t * t + s * s - Lc * Lc) / (2 * t * s);
  const angle = Math.acos(clamp(cosA, -1, 1));
  if (!Number.isFinite(knee.x) || !Number.isFinite(knee.y) || !Number.isFinite(knee.z)) {
    knee.x = hx; knee.y = hy; knee.z = hz;
    return { knee, angle: Math.PI, reachable: false };
  }
  return { knee, angle, reachable };
}

// Legs bend forward (knee in front of the hip→foot line, never behind it).
const LEG_POLE = new THREE.Vector3(0, 0, 1);
export function solveLegIK(hip, foot, thigh, shin) {
  return solveTwoBoneIK(hip, foot, thigh, shin, LEG_POLE);
}

// ─────────────────────────────────────────────────────────────────────────────── caches
const geoCache = new Map();
function geo(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}
function boxGeo(w, h, d) { return geo(`b|${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}`, () => new THREE.BoxGeometry(w, h, d)); }
function cylGeo(rt, rb, h, seg, open) { return geo(`c|${rt.toFixed(4)}|${rb.toFixed(4)}|${h.toFixed(4)}|${seg}|${open ? 1 : 0}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, !!open)); }
function sphGeo(r, ws, hs, ps, pl, ts, tl) {
  const k = `s|${r.toFixed(4)}|${ws}|${hs}|${ps.toFixed(4)}|${pl.toFixed(4)}|${ts.toFixed(4)}|${tl.toFixed(4)}`;
  return geo(k, () => new THREE.SphereGeometry(r, ws, hs, ps, pl, ts, tl));
}
function coneGeo(r, h, seg) { return geo(`k|${r.toFixed(4)}|${h.toFixed(4)}|${seg}`, () => new THREE.ConeGeometry(r, h, seg)); }
function torusGeo(r, tube, rs, ts, arc) { return geo(`t|${r.toFixed(4)}|${tube.toFixed(4)}|${rs}|${ts}|${arc.toFixed(4)}`, () => new THREE.TorusGeometry(r, tube, rs, ts, arc)); }
function capGeo(r, len, seg) { return geo(`p|${r.toFixed(4)}|${len.toFixed(4)}|${seg}`, () => new THREE.CapsuleGeometry(r, len, 3, seg)); }

// Body shell extruded from a side profile: profile points are [length, height] in metres with
// the front at +length. The shape's X axis maps to world +Z and its extrusion depth to +-X,
// which is checked (not assumed) by test/render.test.mjs.
function profileGeo(key, pts, width, bevel) {
  return geo(`x|${key}|${width.toFixed(3)}|${bevel.toFixed(3)}`, () => {
    const sh = new THREE.Shape();
    sh.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, {
      depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
      bevelSegments: 2, curveSegments: 4, steps: 1,
    });
    g.translate(0, 0, -(width - bevel * 2) / 2);
    g.rotateY(-Math.PI / 2);
    g.computeVertexNormals();
    return g;
  });
}

function mesh(geometry, material, x = 0, y = 0, z = 0, parent = null) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = false;
  if (parent) parent.add(m);
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────── materials
function makeMats(kartDef, charDef) {
  const body = (kartDef && kartDef.body) || (charDef && charDef.colour) || PALETTE.wall;
  const accent = (kartDef && kartDef.accent) || PALETTE.startGate;
  const colour = (charDef && charDef.colour) || PALETTE.hudEdge;
  const trim = (charDef && charDef.accent) || PALETTE.hudText;
  const skin = (charDef && charDef.skin) || '#d79a63';
  const paint = (c, rough = 0.38, metal = 0.35) => new THREE.MeshStandardMaterial({ color: new THREE.Color(c), roughness: rough, metalness: metal });
  return {
    paint: paint(body),
    paint2: paint(accent, 0.55, 0.25),
    colour: paint(colour, 0.42, 0.3),
    trim: paint(trim, 0.5, 0.2),
    dark: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.startGate), roughness: 0.72, metalness: 0.18 }),
    metal: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.wall), roughness: 0.28, metalness: 0.9 }),
    chrome: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.kerbA), roughness: 0.16, metalness: 0.95 }),
    rubber: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.startGate), roughness: 0.94, metalness: 0.02 }),
    rim: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.kerbA), roughness: 0.24, metalness: 0.85 }),
    glass: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.skyNight[2]), roughness: 0.06, metalness: 0.3, transparent: true, opacity: 0.66 }),
    skin: paint(skin, 0.66, 0.02),
    eyeWhite: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hudText), roughness: 0.35, metalness: 0.05 }),
    pupil: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.startGate), roughness: 0.3, metalness: 0.1 }),
    mouth: new THREE.MeshStandardMaterial({ color: new THREE.Color('#8c3a3a'), roughness: 0.6, metalness: 0.05 }),
    // per-kart so emissive state can be driven per racer without bleeding between karts
    head: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.sun), emissive: new THREE.Color(PALETTE.sun), emissiveIntensity: 1.1, roughness: 0.2, metalness: 0.1 }),
    brake: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.warn), emissive: new THREE.Color(PALETTE.warn), emissiveIntensity: 0.55, roughness: 0.3, metalness: 0.1 }),
    flame: new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.boost), transparent: true, opacity: 0.92 }),
    flameCore: new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.sun), transparent: true, opacity: 0.95 }),
    antenna: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.warn), roughness: 0.5, metalness: 0.1 }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────── layout
// Every rig number in one place, in the KART frame (+Z forward, y measured from the road).
// The character's own IK runs in the PELVIS frame (origin at the seat), so anchors below are
// listed as pelvis-relative where it matters.
function layout(dim, shape, charDef) {
  const cs = dim.charH / 1.28;                                  // driver build scale
  const bulk = 0.94 + clamp(num(charDef && charDef.weight, 3), 1, 5) * 0.03;
  const podX = shape === 'boxy' ? 0.52 : shape === 'teardrop' ? 0.42 : 0.46;
  return {
    cs, bulk, shape,
    frontZ: dim.wheelBase / 2, rearZ: -dim.wheelBase / 2,
    wheelWFront: 0.17, wheelWRear: 0.20,
    floorY: 0.12, chassisW: shape === 'boxy' ? 0.96 : shape === 'teardrop' ? 0.82 : 0.84,
    podX,
    // driver station (kart frame)
    pelvis: { x: 0, y: 0.41, z: -0.28 },
    seatPanY: 0.34, seatPanZ: -0.26, seatBackZ: -0.46,
    // steering column: centre of the rim + the wheel-plane normal (tilted back toward driver)
    column: { x: 0, y: 0.68, z: 0.26, tilt: 0.60, rim: 0.125, tube: 0.018 },
    pedal: { x: 0.155 * cs, y: 0.16, z: 0.42 },
    footTuck: { x: 0.17 * cs, y: 0.36, z: 0.16 },
    // character (pelvis frame: +y up from the seat, +z forward)
    hip: { x: 0.16 * cs * bulk, y: 0.0, z: 0.0 },
    shoulder: { x: 0.20 * cs * bulk, y: 0.52 * cs, z: 0.10 * cs },
    thigh: 0.44 * cs, shin: 0.46 * cs,
    upperArm: 0.305 * cs, foreArm: 0.295 * cs,
    torsoH: 0.50 * cs,
    headR: 0.115 * cs, helmetR: 0.148 * cs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────── body
const PROFILES = {
  wedge: [
    [1.18, 0.26], [1.08, 0.15], [0.72, 0.12], [-0.52, 0.12], [-1.06, 0.15], [-1.18, 0.24],
    [-1.16, 0.40], [-0.86, 0.44], [-0.30, 0.40], [0.28, 0.32], [0.80, 0.27], [1.10, 0.27],
  ],
  teardrop: [
    [1.10, 0.30], [1.02, 0.17], [0.58, 0.12], [-0.44, 0.12], [-0.98, 0.16], [-1.10, 0.27],
    [-1.06, 0.47], [-0.66, 0.56], [-0.10, 0.55], [0.34, 0.45], [0.78, 0.35], [1.06, 0.31],
  ],
  boxy: [
    [1.06, 0.16], [1.06, 0.42], [0.96, 0.52], [0.50, 0.58], [-0.74, 0.58], [-1.02, 0.52],
    [-1.06, 0.16], [-0.96, 0.12], [0.60, 0.12],
  ],
};

function buildBody(shape, dim, L, M, out) {
  const g = new THREE.Group();
  g.name = 'body';
  const prof = PROFILES[shape] || PROFILES.wedge;

  // ── main moulded shell
  const shell = mesh(profileGeo(shape, prof, L.chassisW, shape === 'boxy' ? 0.012 : shape === 'teardrop' ? 0.035 : 0.026), M.paint, 0, 0, 0, g);
  out.shell = shell;

  // ── floor pan + side rails (every kart has a chassis under the shell)
  mesh(boxGeo(L.chassisW * 0.94, 0.045, dim.bodyLen * 0.84), M.dark, 0, L.floorY - 0.03, -0.02, g);
  for (const sx of [-1, 1]) {
    mesh(boxGeo(0.05, 0.07, dim.bodyLen * 0.78), M.metal, sx * (L.chassisW * 0.5 + 0.03), L.floorY + 0.03, -0.04, g);
  }

  // ── front: nose cone / splitter / grille / number plate
  if (shape === 'wedge') {
    const nose = mesh(coneGeo(0.20, 0.46, 8), M.paint2, 0, 0.27, dim.bodyLen * 0.5 - 0.06, g);
    nose.rotation.x = Math.PI / 2;                     // cone axis along +Z, pointing forward
    const splitter = mesh(boxGeo(L.chassisW * 1.24, 0.028, 0.34), M.paint2, 0, 0.13, dim.bodyLen * 0.5 - 0.28, g);
    splitter.rotation.x = -0.07;
    out.nose = nose;
    out.splitter = splitter;
  } else if (shape === 'teardrop') {
    const nose = mesh(sphGeo(0.19, 14, 10, 0, TAU, 0, Math.PI), M.paint, 0, 0.30, dim.bodyLen * 0.5 - 0.10, g);
    nose.scale.set(0.86, 0.86, 1.05);
    const lip = mesh(torusGeo(0.19, 0.022, 6, 18, TAU), M.trim, 0, 0.30, dim.bodyLen * 0.5 - 0.12, g);
    lip.scale.set(0.86, 0.86, 1.0);
    out.nose = nose; out.lip = lip;
  } else {
    const bumper = mesh(boxGeo(L.chassisW * 0.82, 0.24, 0.16), M.trim, 0, 0.28, dim.bodyLen * 0.5 + 0.02, g);
    const grille = mesh(boxGeo(L.chassisW * 0.5, 0.16, 0.06), M.dark, 0, 0.28, dim.bodyLen * 0.5 + 0.10, g);
    out.nose = bumper; out.grille = grille;
  }
  // grille + plate common to all three
  mesh(boxGeo(0.30, 0.10, 0.05), M.dark, 0, 0.19, dim.bodyLen * 0.5 - 0.02, g);
  mesh(boxGeo(0.16, 0.11, 0.03), M.trim, 0.0, 0.36, dim.bodyLen * 0.5 - 0.05, g);

  // ── side pods: the clearest silhouette difference between the three shapes
  for (const sx of [-1, 1]) {
    if (shape === 'boxy') {
      mesh(boxGeo(0.26, 0.26, 1.20), M.paint, sx * L.podX, 0.26, -0.05, g);
      mesh(boxGeo(0.28, 0.05, 1.22), M.paint2, sx * L.podX, 0.40, -0.05, g);
      mesh(boxGeo(0.10, 0.16, 0.9), M.dark, sx * (L.podX - 0.14), 0.24, -0.05, g);
    } else if (shape === 'teardrop') {
      const pod = mesh(cylGeo(0.115, 0.135, 0.92, 12), M.paint, sx * L.podX, 0.25, -0.05, g);
      pod.rotation.x = Math.PI / 2;
      pod.scale.set(1, 1, 0.72);
      mesh(sphGeo(0.115, 10, 8, 0, TAU, 0, Math.PI), M.paint, sx * L.podX, 0.25, -0.52, g);
    } else {
      const pod = mesh(boxGeo(0.22, 0.20, 1.10), M.paint, sx * L.podX, 0.23, -0.05, g);
      pod.rotation.z = sx * 0.12;
      const canard = mesh(boxGeo(0.30, 0.02, 0.20), M.paint2, sx * (L.podX + 0.03), 0.30, 0.42, g);
      canard.rotation.z = sx * -0.18;
    }
  }

  // ── driver seat: pan, backrest, side wings, headrest
  const seat = new THREE.Group(); seat.name = 'seat'; g.add(seat);
  mesh(boxGeo(0.46, 0.06, 0.44), M.dark, 0, L.seatPanY, L.seatPanZ, seat);
  const back = mesh(boxGeo(0.46, 0.50, 0.07), M.dark, 0, L.seatPanY + 0.26, L.seatBackZ + 0.02, seat);
  back.rotation.x = 0.16;
  mesh(boxGeo(0.30, 0.11, 0.09), M.dark, 0, L.seatPanY + 0.50, L.seatBackZ + 0.06, seat);
  for (const sx of [-1, 1]) {
    const wing = mesh(boxGeo(0.06, 0.26, 0.34), M.dark, sx * 0.22, L.seatPanY + 0.12, L.seatPanZ - 0.06, seat);
    wing.rotation.z = sx * 0.10;
  }
  out.seat = seat;

  // ── steering column + rim (rim spins; grips are solved from its plane)
  const col = new THREE.Group(); col.name = 'column'; g.add(col);
  const a = new THREE.Vector3(0, Math.cos(L.column.tilt), -Math.sin(L.column.tilt));
  col.position.set(L.column.x, L.column.y, L.column.z);
  col.quaternion.setFromUnitVectors(FWD, a);            // rim plane normal = column axis
  const shaftMid = new THREE.Vector3(L.column.x, L.column.y, L.column.z).addScaledVector(a, -0.20);
  const shaft = mesh(cylGeo(0.026, 0.032, 0.40, 8), M.chrome, shaftMid.x, shaftMid.y, shaftMid.z, g);
  shaft.quaternion.copy(col.quaternion);
  const rim = new THREE.Group(); rim.name = 'rim'; col.add(rim);
  mesh(torusGeo(L.column.rim, L.column.tube, 8, 22, TAU), M.dark, 0, 0, 0, rim);
  mesh(cylGeo(0.045, 0.045, 0.035, 10), M.chrome, 0, 0, 0, rim);
  for (let i = 0; i < 3; i++) {
    const sp = mesh(boxGeo(0.018, 0.10, 0.012), M.chrome, 0, 0, 0, rim);
    sp.position.set(Math.cos(i * TAU / 3) * 0.055, Math.sin(i * TAU / 3) * 0.055, 0);
    sp.rotation.z = i * TAU / 3 - Math.PI / 2;
  }
  out.column = col; out.rim = rim; out.columnAxis = a;

  // ── pedals (the boots land on these)
  out.pedals = [];
  for (const sx of [-1, 1]) {
    const pd = mesh(boxGeo(0.12, 0.03, 0.16), M.metal, sx * L.pedal.x, L.pedal.y - 0.03, L.pedal.z, g);
    pd.rotation.x = -0.35;
    out.pedals.push(pd);
  }

  // ── rear: spoiler, exhausts, bumper, brake lights
  const wingY = L.shape === 'boxy' ? 0.72 : L.shape === 'teardrop' ? 0.66 : 0.60;
  const wing = new THREE.Group(); wing.name = 'spoiler'; g.add(wing);
  if (L.shape === 'boxy') {
    for (const sx of [-1, 1]) mesh(boxGeo(0.05, 0.30, 0.05), M.metal, sx * 0.30, wingY - 0.15, -1.00, wing);
    const plate = mesh(boxGeo(0.86, 0.035, 0.30), M.paint2, 0, wingY, -1.02, wing);
    plate.rotation.x = 0.16;
  } else if (L.shape === 'teardrop') {
    const blade = mesh(torusGeo(0.42, 0.035, 6, 16, Math.PI * 0.85), M.paint2, 0, wingY - 0.42, -1.00, wing);
    blade.rotation.set(0, Math.PI * 0.5, 0.0);
    blade.rotation.z = Math.PI * 0.0;
    for (const sx of [-1, 1]) mesh(boxGeo(0.04, 0.26, 0.04), M.metal, sx * 0.30, wingY - 0.13, -1.00, wing);
  } else {
    for (const sx of [-1, 1]) mesh(boxGeo(0.04, 0.28, 0.06), M.metal, sx * 0.32, wingY - 0.14, -1.02, wing);
    const lower = mesh(boxGeo(0.90, 0.03, 0.26), M.paint2, 0, wingY, -1.04, wing);
    lower.rotation.x = 0.20;
    const upper = mesh(boxGeo(0.74, 0.03, 0.16), M.paint, 0, wingY + 0.10, -1.06, wing);
    upper.rotation.x = 0.24;
  }
  out.spoiler = wing;

  mesh(boxGeo(L.chassisW * 1.06, 0.09, 0.08), M.metal, 0, 0.20, -dim.bodyLen * 0.5 + 0.02, g);
  out.exhausts = [];
  const pipes = L.shape === 'boxy' ? [-0.34, -0.20, 0.20, 0.34] : [-0.26, 0.26];
  for (const px of pipes) {
    const pipe = mesh(cylGeo(0.042, 0.052, 0.34, 8), M.chrome, px, 0.30, -dim.bodyLen * 0.5 + 0.06, g);
    pipe.rotation.x = -1.15;
    const bore = mesh(cylGeo(0.033, 0.033, 0.03, 8), M.dark, px, 0.30 + 0.28 * Math.cos(-1.15), -dim.bodyLen * 0.5 + 0.06 + 0.28 * Math.sin(-1.15), g);
    out.exhausts.push(pipe);
    const flame = mesh(coneGeo(0.06, 0.34, 7), M.flame, px, 0.30 + 0.44 * Math.cos(-1.15), -dim.bodyLen * 0.5 + 0.06 + 0.44 * Math.sin(-1.15), g);
    flame.rotation.x = -1.15 + Math.PI / 2 + Math.PI;
    flame.scale.set(0.001, 0.001, 0.001);
    flame.visible = false;
    out.flames = out.flames || [];
    out.flames.push(flame);
    out.bore = out.bore || [];
    out.bore.push(bore);
  }

  // ── lights
  out.headlights = [];
  for (const sx of [-1, 1]) {
    const hl = mesh(sphGeo(0.045, 8, 6, 0, TAU, 0, Math.PI), M.head, sx * 0.19, 0.27, dim.bodyLen * 0.5 - 0.03, g);
    hl.scale.set(1.5, 0.9, 0.7);
    out.headlights.push(hl);
  }
  out.brakelights = [];
  for (const sx of [-1, 1]) {
    const bl = mesh(boxGeo(0.09, 0.055, 0.04), M.brake, sx * 0.30, 0.34, -dim.bodyLen * 0.5 + 0.05, g);
    out.brakelights.push(bl);
  }

  // ── antenna (bends with speed)
  const ant = new THREE.Group(); ant.name = 'antenna'; g.add(ant);
  ant.position.set(0.30, 0.44, -dim.bodyLen * 0.5 + 0.34);
  const mast = mesh(cylGeo(0.008, 0.011, 0.36, 6), M.metal, 0, 0.18, 0, ant);
  mesh(sphGeo(0.028, 8, 6, 0, TAU, 0, Math.PI), M.antenna, 0, 0.37, 0, ant);
  out.antenna = ant; out.mast = mast;

  // ── paint stripe down the middle (all shapes) — reads as a livery, not a plain box
  mesh(boxGeo(0.16, 0.012, dim.bodyLen * 0.62), M.trim, 0, L.shape === 'boxy' ? 0.60 : L.shape === 'teardrop' ? 0.575 : 0.455, -0.20, g);

  return g;
}

// ─────────────────────────────────────────────────────────────────────────────── wheels
function buildWheels(dim, L, M, out) {
  const set = new THREE.Group();
  set.name = 'wheels';
  const wheels = [];
  const defs = [
    { x: dim.track / 2, z: L.frontZ, w: L.wheelWFront, front: true, name: 'wheelFrontL' },
    { x: -dim.track / 2, z: L.frontZ, w: L.wheelWFront, front: true, name: 'wheelFrontR' },
    { x: dim.track / 2, z: L.rearZ, w: L.wheelWRear, front: false, name: 'wheelRearL' },
    { x: -dim.track / 2, z: L.rearZ, w: L.wheelWRear, front: false, name: 'wheelRearR' },
  ];
  const rimR = dim.wheelR * 0.60;
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const pivot = new THREE.Group();
    pivot.name = d.name;                                    // steer lives here (rotation.y)
    pivot.position.set(d.x, dim.wheelR, d.z);               // contact = pivot.y - wheelR = 0
    set.add(pivot);
    const roll = new THREE.Group();                         // roll lives here (rotation.x)
    roll.name = 'roll';
    pivot.add(roll);
    const tyre = mesh(cylGeo(dim.wheelR, dim.wheelR, d.w, 32), M.rubber, 0, 0, 0, roll);
    tyre.rotation.z = Math.PI / 2;                          // axis along X: it rolls about X
    const rim = mesh(cylGeo(rimR, rimR, d.w + 0.012, 20), M.rim, 0, 0, 0, roll);
    rim.rotation.z = Math.PI / 2;
    for (let k = 0; k < 6; k++) {                           // visible spokes across the rim
      const sp = mesh(boxGeo(0.03, rimR * 1.94, d.w * 0.42), M.chrome, 0, 0, 0, roll);
      sp.rotation.x = k * Math.PI / 6;
    }
    const hub = mesh(cylGeo(0.055, 0.055, d.w + 0.03, 10), M.chrome, 0, 0, 0, roll);
    hub.rotation.z = Math.PI / 2;
    const disc = mesh(cylGeo(rimR * 0.8, rimR * 0.8, 0.016, 18), M.metal, 0, 0, 0, roll);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = -Math.sign(d.x) * d.w * 0.30;
    const nut = mesh(boxGeo(0.02, 0.045, 0.045), M.metal, 0, 0, 0, roll);
    nut.position.set(Math.sign(d.x) * (d.w * 0.5 + 0.02), 0, 0);
    pivot.userData = { index: i, front: !!d.front, roll, tyre, rim, radius: dim.wheelR, width: d.w, side: Math.sign(d.x) };
    wheels.push(pivot);
  }
  out.wheels = wheels;
  return set;
}

// ─────────────────────────────────────────────────────────────────────────────── driver
// A real rig: pelvis, hinged torso, neck+head with helmet/visor/face, two two-bone arms with
// elbows and gloves, two two-bone legs with knees and boots. Every joint angle in the limbs
// comes out of solveTwoBoneIK — nothing here is authored as a raw joint angle.
function buildRider(L, M, charDef, out) {
  const cs = L.cs, bw = L.bulk;
  const root = new THREE.Group();
  root.name = 'driver';
  root.position.set(L.pelvis.x, L.pelvis.y, L.pelvis.z);

  const suit = M.colour, trim = M.trim;
  const hipX = L.hip.x, shX = L.shoulder.x, shY = L.shoulder.y, shZ = L.shoulder.z;

  // pelvis / hips
  mesh(boxGeo(0.30 * cs * bw, 0.16 * cs, 0.22 * cs), M.dark, 0, 0.01, 0, root);
  mesh(boxGeo(0.32 * cs * bw, 0.04 * cs, 0.24 * cs), trim, 0, 0.085, 0, root);   // belt

  // torso: hinged at the pelvis so the driver can sit up, tuck and breathe
  const torso = new THREE.Group();
  torso.name = 'torso';
  torso.position.set(0, 0.06 * cs, 0);
  root.add(torso);
  const chest = mesh(cylGeo(0.205 * cs * bw, 0.175 * cs * bw, L.torsoH, 12), suit, 0, L.torsoH * 0.5, 0, torso);
  chest.scale.set(1, 1, 0.62);
  const yoke = mesh(capGeo(0.075 * cs * bw, 0.30 * cs * bw, 8), trim, 0, L.torsoH * 0.86, 0, torso);
  yoke.rotation.z = Math.PI / 2;
  mesh(boxGeo(0.05 * cs, L.torsoH * 0.8, 0.02 * cs), trim, 0, L.torsoH * 0.48, 0.135 * cs, torso);
  for (const sx of [-1, 1]) mesh(boxGeo(0.10 * cs, 0.06 * cs, 0.16 * cs), M.dark, sx * shX * 0.92, shY * 0.92, 0, torso);
  mesh(cylGeo(0.052 * cs, 0.058 * cs, 0.12 * cs, 8), M.skin, 0, L.torsoH + 0.02, 0, torso);

  // head + helmet + visor + face
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, L.torsoH + 0.10 * cs, 0);
  torso.add(head);
  const hr = L.headR, helR = L.helmetR;
  mesh(sphGeo(hr, 16, 12, 0, TAU, 0, Math.PI), M.skin, 0, hr * 0.9, 0, head);
  mesh(sphGeo(helR, 18, 14, 0, TAU, 0, Math.PI * 0.66), M.colour, 0, hr * 0.9, 0, head);
  mesh(boxGeo(helR * 1.35, 0.05 * cs, 0.10 * cs), M.trim, 0, hr * 0.9 + helR * 0.82, -helR * 0.42, head);
  const chin = mesh(boxGeo(helR * 1.2, 0.07 * cs, helR * 0.7), M.dark, 0, hr * 0.9 - 0.60 * helR, helR * 0.52, head);
  chin.rotation.x = 0.18;
  out.chinBar = chin;
  const visor = mesh(sphGeo(helR * 1.02, 20, 12, Math.PI / 2 - 0.95, 1.90, 0.66, 0.69), M.glass, 0, hr * 0.9, 0, head);
  out.visor = visor;
  // face: two eyes that blink + brows + mouth, driven per game state
  const eyes = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.Group();
    eye.name = sx < 0 ? 'eyeR' : 'eyeL';
    eye.position.set(sx * 0.045 * cs, hr * 0.9 + 0.052 * cs, 0.088 * cs);
    head.add(eye);
    mesh(sphGeo(0.030 * cs, 10, 8, 0, TAU, 0, Math.PI), M.eyeWhite, 0, 0, 0, eye);
    const pupil = mesh(sphGeo(0.016 * cs, 8, 6, 0, TAU, 0, Math.PI), M.pupil, 0, 0, 0.019 * cs, eye);
    pupil.scale.set(1, 1, 0.6);
    eyes.push(eye);
  }
  const brows = [];
  for (const sx of [-1, 1]) {
    const b = mesh(boxGeo(0.050 * cs, 0.012 * cs, 0.016 * cs), M.pupil, sx * 0.046 * cs, hr * 0.9 + 0.098 * cs, 0.084 * cs, head);
    brows.push(b);
  }
  const mouth = mesh(torusGeo(0.034 * cs, 0.008 * cs, 5, 12, Math.PI), M.mouth, 0, hr * 0.9 - 0.010 * cs, 0.086 * cs, head);
  mouth.rotation.z = Math.PI;

  // ── legs: two-bone IK, hip -> knee -> ankle
  const legs = [];
  for (const sx of [-1, 1]) {
    const hipPivot = new THREE.Group();
    hipPivot.name = sx < 0 ? 'hipR' : 'hipL';
    hipPivot.position.set(sx * hipX, L.hip.y, L.hip.z);
    root.add(hipPivot);
    const thighW = 0.072 * cs * bw;
    const thighMesh = mesh(cylGeo(thighW * 0.92, thighW, L.thigh, 8), suit, 0, L.thigh * 0.5, 0, hipPivot);
    const kneePivot = new THREE.Group();
    kneePivot.name = 'knee';
    kneePivot.position.set(0, L.thigh, 0);
    hipPivot.add(kneePivot);
    mesh(cylGeo(0.062 * cs * bw, 0.052 * cs * bw, L.shin, 8), suit, 0, L.shin * 0.5, 0, kneePivot);
    const kneePad = mesh(sphGeo(0.062 * cs * bw, 10, 8, 0, TAU, 0, Math.PI), trim, 0, 0.01, 0.045 * cs, kneePivot);
    kneePad.scale.set(1, 0.9, 0.7);
    const anklePivot = new THREE.Group();
    anklePivot.name = 'ankle';
    anklePivot.position.set(0, L.shin, 0);
    kneePivot.add(anklePivot);
    const boot = new THREE.Group();
    boot.name = 'boot';
    anklePivot.add(boot);
    mesh(boxGeo(0.105 * cs, 0.085 * cs, 0.20 * cs), M.dark, 0, -0.012 * cs, 0.045 * cs, boot);
    mesh(boxGeo(0.11 * cs, 0.03 * cs, 0.055 * cs), M.metal, 0, -0.045 * cs, 0.115 * cs, boot);
    mesh(boxGeo(0.115 * cs, 0.05 * cs, 0.09 * cs), trim, 0, 0.035 * cs, -0.01 * cs, boot);
    legs.push({
      side: sx < 0 ? -1 : 1, hipPivot, kneePivot, anklePivot, boot, thighMesh,
      thigh: L.thigh, shin: L.shin,
      hip: new THREE.Vector3(sx * hipX, L.hip.y, L.hip.z),
      knee: new THREE.Vector3(sx * hipX, L.hip.y - L.thigh, L.hip.z + 0.2),
      foot: new THREE.Vector3(sx * hipX, L.hip.y - L.thigh - L.shin, L.hip.z + 0.4),
      angle: Math.PI, reachable: true,
    });
  }
  // ── arms: same solver, elbow pole down/out/back
  const arms = [];
  for (const sx of [-1, 1]) {
    const shPivot = new THREE.Group();
    shPivot.name = sx < 0 ? 'shoulderR' : 'shoulderL';
    shPivot.position.set(sx * shX, shY, shZ);
    root.add(shPivot);
    mesh(capGeo(0.062 * cs * bw, 0.10 * cs, 8), suit, 0, 0.02 * cs, 0, shPivot);
    mesh(cylGeo(0.058 * cs * bw, 0.050 * cs * bw, L.upperArm, 8), suit, 0, L.upperArm * 0.5, 0, shPivot);
    const elbowPivot = new THREE.Group();
    elbowPivot.name = 'elbow';
    elbowPivot.position.set(0, L.upperArm, 0);
    shPivot.add(elbowPivot);
    mesh(cylGeo(0.050 * cs * bw, 0.044 * cs * bw, L.foreArm, 8), suit, 0, L.foreArm * 0.5, 0, elbowPivot);
    mesh(boxGeo(0.085 * cs, 0.05 * cs, 0.09 * cs), trim, 0, 0.01, 0, elbowPivot);
    const wristPivot = new THREE.Group();
    wristPivot.name = 'wrist';
    wristPivot.position.set(0, L.foreArm, 0);
    elbowPivot.add(wristPivot);
    const glove = new THREE.Group();
    glove.name = 'glove';
    wristPivot.add(glove);
    mesh(sphGeo(0.056 * cs, 10, 8, 0, TAU, 0, Math.PI), M.dark, 0, 0.005, 0, glove);
    mesh(boxGeo(0.075 * cs, 0.085 * cs, 0.075 * cs), trim, 0, 0.0, 0, glove);
    mesh(boxGeo(0.03 * cs, 0.05 * cs, 0.05 * cs), M.dark, sx * 0.045 * cs, 0.03 * cs, 0.02 * cs, glove);
    arms.push({
      side: sx < 0 ? -1 : 1, shPivot, elbowPivot, wristPivot, glove,
      upper: L.upperArm, fore: L.foreArm,
      shoulder: new THREE.Vector3(sx * shX, shY, shZ),
      elbow: new THREE.Vector3(sx * shX, shY - L.upperArm, shZ + 0.1),
      wrist: new THREE.Vector3(sx * shX, shY - L.upperArm - L.foreArm, shZ + 0.3),
      angle: Math.PI, reachable: true,
    });
  }

  out.rider = root;
  out.torso = torso;
  out.chest = chest;
  out.head = head;
  out.eyes = eyes;
  out.brows = brows;
  out.mouth = mouth;
  out.legs = legs;
  out.arms = arms;
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────── public: build
export function createKart(kartDef, charDef) {
  const kd = kartDef && typeof kartDef === 'object' ? kartDef : {};
  const cd = charDef && typeof charDef === 'object' ? charDef : {};
  const shape = SHAPES.indexOf(kd.shape) >= 0 ? kd.shape : 'wedge';
  const dim = kartDimensions({ ...kd, shape });
  const L = layout(dim, shape, cd);
  const M = makeMats(kd, cd);
  const P = {};

  const group = new THREE.Group();
  group.name = `kart:${kd.id || 'untitled'}:${cd.id || 'driver'}`;

  const kartYaw = new THREE.Group();       // slide yaw + spin-out + hop (whole kart)
  kartYaw.name = 'kartYaw';
  group.add(kartYaw);

  const chassisPivot = new THREE.Group();  // body roll + pitch, about a point 0.22 m up
  chassisPivot.name = 'chassisPivot';
  chassisPivot.position.set(0, 0.22, 0);
  kartYaw.add(chassisPivot);

  const chassisSquash = new THREE.Group(); // landing squash, about the road (y = 0)
  chassisSquash.name = 'chassisSquash';
  chassisSquash.position.set(0, -0.22, 0);
  chassisPivot.add(chassisSquash);

  const body = buildBody(shape, dim, L, M, P);
  chassisSquash.add(body);

  const wheelSet = buildWheels(dim, L, M, P);
  kartYaw.add(wheelSet);                   // NOT under the chassis: contact can never lift

  const rider = buildRider(L, M, cd, P);
  chassisSquash.add(rider);

  const rig = {
    dim, L, shape, mats: M, kartDef: kd, charDef: cd,
    kartYaw, chassisPivot, chassisSquash, wheelSet, body, rider,
    wheels: P.wheels || [],
    shell: P.shell, seat: P.seat, spoiler: P.spoiler, antenna: P.antenna,
    column: P.column, rim: P.rim, columnQuat: P.column ? P.column.quaternion.clone() : new THREE.Quaternion(),
    columnPos: new THREE.Vector3(L.column.x, L.column.y, L.column.z),
    columnAxis: P.columnAxis, headlights: P.headlights || [], brakelights: P.brakelights || [],
    exhausts: P.exhausts || [], flames: P.flames || [], bores: P.bore || [], pedals: P.pedals || [],
    torso: P.torso, chest: P.chest, head: P.head, chinBar: P.chinBar,
    eyes: P.eyes || [], brows: P.brows || [], mouth: P.mouth, visor: P.visor,
    legs: P.legs || [], arms: P.arms || [],
    wheelRoll: 0, lastSpeed: 0,
    state: {
      steer: 0, roll: 0, pitch: 0, yaw: 0, spinYaw: 0, wheelRoll: 0,
      squashY: 1, breathe: 0, blink: 1, expression: 'neutral', airP: 0, grip: 0,
      reachMaxArm: 0, reachMaxLeg: 0, clampArm: 0, clampLeg: 0,
    },
    ik: { minArmAngle: Math.PI, minLegAngle: Math.PI, maxFlexLeg: 0, maxFlexArm: 0 },
  };
  rig.charRig = rider;

  // one full solve at rest so the rig is never in a half-built pose, even before frame 1
  group.userData = { rig, wheels: rig.wheels, body, charRig: rider, kartDef: kd, charDef: cd };
  updateKartVisual(group, { speed: 0, place: 1, y: 0 }, null, 0, { dt: 0, place: 1 });
  return group;
}

// ─────────────────────────────────────────────────────────────────────────────── public: per-frame
const _mA = new THREE.Matrix4();
const _mB = new THREE.Matrix4();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _qC = new THREE.Quaternion();
const _qW = new THREE.Quaternion();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _vD = new THREE.Vector3();
const _vE = new THREE.Vector3();
const _vF = new THREE.Vector3();
const _vG = new THREE.Vector3();
const ARM_POLE = new THREE.Vector3();

const STEER_MAX = 0.38;         // rad of steer on the front wheels at full lock
const RIM_TURN = 1.25;          // rad the rim turns per unit of steer
const ROLL_CORNER = 0.075;      // bank into a corner
const ROLL_DRIFT = 0.055;       // extra lean while drifting (kept small so no pod clips the road)

// elbow pole per side: elbows point out, down and back, like a real driver
function armPole(side) {
  ARM_POLE.set(side * 0.35, -1, -0.25);
  return ARM_POLE;
}

// returns the reached target: clamped into [|t-s|, t+s] so bones can never stretch
function reachClamp(hip, target, maxR, minR, out, sink) {
  out.copy(target);
  _vG.subVectors(out, hip);
  let len = _vG.length();
  if (!(len > 1e-9)) { out.x = hip.x; out.y = hip.y - maxR * 0.5; out.z = hip.z; return false; }
  const hi = maxR - 2e-5, lo = Math.max(1e-4, minR + 1e-5);
  if (len <= hi && len >= lo) return true;
  _vG.multiplyScalar((len > hi ? hi : lo) / len);
  out.copy(hip).add(_vG);
  if (sink) sink.clamped = true;
  return false;
}

export function updateKartVisual(group, racer, state, t, opts) {
  if (!group || !group.userData || !group.userData.rig) return;
  const rig = group.userData.rig;
  const r = racer || {};
  const o = opts || {};
  const dim = rig.dim, L = rig.L, M = rig.mats;
  const st = rig.state;
  const dt = clamp(num(o.dt, SIM.STEP), 0, 0.25);
  const time = Number.isFinite(t) ? t : num(state && state.tick, 0) * SIM.STEP;

  const speed = num(r.speed, 0);
  const absSpeed = Math.abs(speed);
  const sn = clamp(absSpeed / Math.max(1, PHYSICS.topSpeed || 26), 0, 1.6);

  // ── steering: explicit opts.steer, else derived from the racer's heading rate (works with
  //    the frozen Racer shape, so render.js need not pass anything)
  let steer = Number.isFinite(o.steer) ? clamp(o.steer, -1, 1) : null;
  if (steer === null) {
    let d = num(r.heading, 0) - num(r._ph, num(r.heading, 0));
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    steer = dt > 1e-5 ? clamp((d / dt) / Math.max(0.2, PHYSICS.steerRate || 2), -1, 1) : 0;
  }
  // a kart that has been hit is not steering: damp the derived lock during a spin-out
  const spinTicksRaw = clamp(num(r.spinTicks, 0), 0, Math.max(1, PHYSICS.spinOut.ticks));
  if (spinTicksRaw > 0 && !Number.isFinite(o.steer)) steer *= 0.25;

  // ── state flags straight off the Racer shape
  const driftDir = clamp(num(r.driftDir, 0), -1, 1);
  const drifting = driftDir !== 0;
  const spinMax = Math.max(1, PHYSICS.spinOut.ticks);
  const spinTicks = clamp(num(r.spinTicks, 0), 0, spinMax);
  const spinning = spinTicks > 0;
  // the visual 360 completes within the spin window: at spinTicks = 1 it is exactly full
  const spinP = spinning ? clamp((spinMax - spinTicks) / Math.max(1, spinMax - 1), 0, 1) : 0;
  const recoil = spinning ? Math.max(0, 1 - spinP * 5) : 0;                 // hit impact, first ~20%
  const boosting = num(r.boostTicks, 0) > 0 || num(r.overdriveTicks, 0) > 0;
  const hopMax = Math.max(1, PHYSICS.drift.hopTicks);
  const hopTicks = clamp(num(r.hopTicks, 0), 0, hopMax);
  const hopY = hopTicks > 0 ? Math.sin((1 - hopTicks / hopMax) * Math.PI) * 0.075 : 0;
  const squashMax = Math.max(1, PHYSICS.squashTicks);
  const squashTicks = clamp(num(r.squashTicks, 0), 0, squashMax);
  const squashP = squashTicks > 0 ? squashTicks / squashMax : 0;           // 1 = just landed
  const y = num(r.y, 0);
  const airborne = y > 0.02;
  const airP = airborne ? clamp(y / 1.0, 0, 1) : 0;
  const offTrack = o.offTrack != null ? !!o.offTrack : !!r.offTrack;
  const finished = !!r.finished;
  const place = clamp(num(o.place, num(r.place, 4)), 1, 8);

  // ── wheels: roll exactly speed/wheelRadius, steer the front pair
  rig.wheelRoll += (speed / dim.wheelR) * dt;
  if (!Number.isFinite(rig.wheelRoll)) rig.wheelRoll = 0;
  for (let i = 0; i < rig.wheels.length; i++) {
    const w = rig.wheels[i];
    w.userData.roll.rotation.x = rig.wheelRoll;
    w.rotation.y = w.userData.front ? steer * STEER_MAX : 0;
  }

  // ── body attitude
  let roll = ROLL_CORNER * steer * (0.45 + 0.55 * sn);
  let pitch = 0.012 * sn;
  let slideYaw = 0;
  if (drifting) {
    const charge = clamp(num(r.driftCharge, 0) / Math.max(0.01, PHYSICS.drift.chargeCap), 0, 1);
    const tier = clamp(num(r.driftTier, 0), 0, 3);
    const slip = (PHYSICS.drift.outwardSlip || 0.26) * (0.5 + 0.5 * Math.max(charge, tier / 3));
    // driftDir > 0 = sliding with the nose out to the kart's -X (right) side
    slideYaw = -driftDir * slip;
    roll += driftDir * ROLL_DRIFT;
    pitch += 0.015;
  }
  if (boosting) pitch -= 0.035 + 0.02 * clamp(num(r.boostTicks, 0) / 60, 0, 1);
  if (airborne) pitch -= 0.12 * airP;
  pitch -= 0.30 * recoil;                       // hit recoil: nose kicks up, body thrown back
  roll += 0.05 * recoil * driftDir;
  if (spinning) roll += Math.sin(spinP * Math.PI) * 0.06;   // wobble on the chassis, not the wheels
  roll = clamp(roll, -0.16, 0.16);              // ...so no side pod can ever clip the road

  const spinYaw = spinning ? spinP * TAU * (driftDir < 0 ? -1 : 1) : 0;
  rig.kartYaw.rotation.y = slideYaw + spinYaw;
  rig.kartYaw.position.y = hopY + (offTrack ? Math.abs(Math.sin(time * 24)) * 0.012 * clamp(sn * 2, 0, 1) : 0);
  rig.kartYaw.rotation.z = 0;                   // never roll the wheel set: tyres stay planted

  // landing squash + stretch (keeps y=0 fixed: chassisSquash sits on the road)
  let sy = 1;
  if (squashTicks > 0) {
    const e = squashP;
    sy = 1 - 0.30 * e + 0.14 * Math.sin(Math.PI * (1 - e));
    sy = clamp(sy, 0.62, 1.08);
  }
  const sxz = clamp(1 / Math.sqrt(Math.max(0.3, sy)), 0.9, 1.3);
  rig.chassisSquash.scale.set(sxz, sy, sxz);
  rig.chassisPivot.rotation.z = roll;
  rig.chassisPivot.rotation.x = pitch;

  // ── rider pose
  const idleP = clamp(1 - absSpeed / 1.3, 0, 1);
  const breathe = Math.sin(time * 2.1) * idleP;
  let riderPitch = 0.08 + (boosting ? 0.14 : 0) + airP * 0.10 + 0.04 * sn;
  riderPitch -= 0.34 * recoil;
  if (finished) riderPitch -= 0.05;
  const riderRoll = -0.10 * steer - driftDir * 0.06;
  rig.rider.rotation.x = clamp(riderPitch, -0.45, 0.55);
  rig.rider.rotation.z = riderRoll;
  rig.rider.position.y = L.pelvis.y + breathe * 0.010;
  rig.torso.rotation.x = clamp(-riderPitch * 0.35, -0.2, 0.2);
  rig.torso.scale.y = 1 + 0.020 * breathe;

  // head: looks into the corner, ducks under boost, tips back on a hit
  rig.head.rotation.y = clamp(-steer * 0.18, -0.3, 0.3);
  rig.head.rotation.x = clamp(0.05 * sn + (boosting ? 0.10 : 0) - 0.20 * recoil + 0.04 * breathe, -0.3, 0.3);

  // ── IK targets, in the KART frame, then mapped into the pelvis frame
  const rimTurn = steer * RIM_TURN;
  if (rig.rim) rig.rim.rotation.z = -rimTurn;             // the rim turns with the front wheels
  const gripScale = boosting ? 0.86 : 1;
  _vA.copy(rig.columnPos);
  _vA.y += 0.02 * (boosting ? 1 : 0);
  _vA.z -= 0.06 * (boosting ? 1 : 0);
  const rimR = L.column.rim * gripScale;

  for (const arm of rig.arms) {
    const ang = arm.side > 0 ? rimTurn : rimTurn + Math.PI;
    _vB.set(Math.cos(ang) * rimR, Math.sin(ang) * rimR, 0).applyQuaternion(rig.columnQuat).add(_vA);
    if (finished && arm.side > 0) _vB.set(arm.side * 0.32, 1.20, 0.06);      // victory fist pump
    arm.targetKart = arm.targetKart || new THREE.Vector3();
    arm.targetKart.copy(_vB);
  }
  const pumpPhase = time * 6.5;
  for (const leg of rig.legs) {
    const pump = Math.sin(pumpPhase + (leg.side > 0 ? 0 : 1.7)) * 0.022 * clamp(absSpeed / 5, 0, 1);
    _vC.set(leg.side * L.pedal.x, L.pedal.y + pump * 0.4, L.pedal.z + pump);
    if (airP > 0) {                                                          // airborne tuck
      _vD.set(leg.side * L.footTuck.x, L.footTuck.y, L.footTuck.z);
      _vC.lerp(_vD, airP);
    }
    if (spinning) _vC.z -= 0.05 * Math.sin(spinP * Math.PI);                 // legs fly out
    leg.targetKart = leg.targetKart || new THREE.Vector3();
    leg.targetKart.copy(_vC);
  }

  // pelvis frame = inverse of (kartYaw * chassisPivot * chassisSquash * rider)
  rig.kartYaw.updateMatrix();
  rig.chassisPivot.updateMatrix();
  rig.chassisSquash.updateMatrix();
  rig.rider.updateMatrix();
  _mA.copy(rig.kartYaw.matrix).multiply(rig.chassisPivot.matrix).multiply(rig.chassisSquash.matrix).multiply(rig.rider.matrix);
  _mB.copy(_mA).invert();

  let maxArm = 0, maxLeg = 0, clampArm = 0, clampLeg = 0;
  let minArmAngle = Math.PI, minLegAngle = Math.PI, maxFlexLeg = 0, maxFlexArm = 0;

  for (const arm of rig.arms) {
    _vD.copy(arm.targetKart).applyMatrix4(_mB);
    const maxR = arm.upper + arm.fore;
    const ok = reachClamp(arm.shoulder, _vD, maxR, Math.abs(arm.upper - arm.fore), _vE, null);
    if (!ok) clampArm++;
    const dist = _vE.distanceTo(arm.shoulder);
    if (dist > maxArm) maxArm = dist;
    const res = solveTwoBoneIK(arm.shoulder, _vE, arm.upper, arm.fore, armPole(arm.side));
    arm.elbow.copy(res.knee);
    arm.wrist.copy(_vE);
    arm.angle = res.angle;
    arm.reachable = res.reachable;
    // bone orientations: upper arm from the shoulder, forearm composed on top of it
    _vF.subVectors(res.knee, arm.shoulder).normalize();
    _qW.setFromUnitVectors(UP, _vF);
    arm.shPivot.quaternion.copy(_qW);
    _vF.subVectors(_vE, res.knee).normalize();
    _qA.setFromUnitVectors(UP, _vF);
    _qC.copy(arm.shPivot.quaternion).invert();
    arm.elbowPivot.quaternion.multiplyQuaternions(_qC, _qA);
    if (res.angle < minArmAngle) minArmAngle = res.angle;
    const flex = (Math.PI - res.angle) * 180 / Math.PI;
    if (flex > maxFlexArm) maxFlexArm = flex;
  }

  for (const leg of rig.legs) {
    _vD.copy(leg.targetKart).applyMatrix4(_mB);
    const maxR = leg.thigh + leg.shin;
    const ok = reachClamp(leg.hip, _vD, maxR, Math.abs(leg.thigh - leg.shin), _vE, null);
    if (!ok) clampLeg++;
    const dist = _vE.distanceTo(leg.hip);
    if (dist > maxLeg) maxLeg = dist;
    const res = solveLegIK(leg.hip, _vE, leg.thigh, leg.shin);
    leg.knee.copy(res.knee);
    leg.foot.copy(_vE);
    leg.angle = res.angle;
    leg.reachable = res.reachable;
    _vF.subVectors(res.knee, leg.hip).normalize();
    _qW.setFromUnitVectors(UP, _vF);
    leg.hipPivot.quaternion.copy(_qW);
    _vF.subVectors(_vE, res.knee).normalize();
    _qA.setFromUnitVectors(UP, _vF);
    _qC.copy(leg.hipPivot.quaternion).invert();
    leg.kneePivot.quaternion.multiplyQuaternions(_qC, _qA);
    // boot: sits on the pedal, toe forward-down (independent of the shin)
    _vF.set(0, -0.34, 1).normalize();
    _qA.setFromUnitVectors(FWD, _vF);
    _qC.copy(leg.hipPivot.quaternion).multiply(leg.kneePivot.quaternion).invert();
    leg.anklePivot.quaternion.multiplyQuaternions(_qC, _qA);
    if (res.angle < minLegAngle) minLegAngle = res.angle;
    const flex = (Math.PI - res.angle) * 180 / Math.PI;
    if (flex > maxFlexLeg) maxFlexLeg = flex;
  }

  // ── face: expression from game state, blink on a personality-dependent timer
  const expr = finished ? 'happy'
    : spinning ? 'dizzy'
      : boosting ? 'boost'
        : num(r.inkTicks, 0) > 0 || num(r.respawnTicks, 0) > 0 ? 'dizzy'
          : place === 1 ? 'lead'
            : place >= 6 ? 'worried'
              : (state && state.phase === 'countdown') ? 'ready' : 'neutral';
  const pers = (rig.charDef && rig.charDef.personality) || 'x';
  const period = pers === 'nervous' ? 2.6 : pers === 'cold' ? 5.0 : pers === 'quirky' ? 3.0 : 3.6;
  const seed = ((rig.charDef && rig.charDef.name) || 'k').length * 0.37;
  const phase = ((time + seed) % period + period) % period;
  let open = 1;
  if (phase < 0.10) { const u = phase / 0.10; open = 0.08 + 0.92 * Math.abs(u * 2 - 1); }
  if (expr === 'dizzy') open = Math.min(open, 0.85);
  if (expr === 'boost') open = Math.min(open, 0.62);
  if (expr === 'lead') open = Math.min(open, 0.86);

  const eyes = rig.eyes;
  for (let i = 0; i < eyes.length; i++) {
    const baseX = (i ? 1 : -1) * 0.045 * L.cs;
    const baseY = L.headR * 0.9 + 0.052 * L.cs;
    eyes[i].scale.y = open;
    eyes[i].scale.x = expr === 'worried' ? 1.12 : 1;
    if (expr === 'dizzy') {                                  // dizzy eyes roll in circles
      eyes[i].position.x = baseX + Math.cos(time * 9) * 0.006;
      eyes[i].position.y = baseY + Math.sin(time * 9) * 0.006;
    } else {
      eyes[i].position.x = baseX;
      eyes[i].position.y = baseY;
    }
  }
  let browTilt = 0, browLift = 0, mouthRot = Math.PI, mouthSx = 0.9, mouthSy = 0.55;
  if (expr === 'happy' || expr === 'lead') { browTilt = -0.16; browLift = 0.004; mouthRot = Math.PI - 0.25; mouthSx = 1.18; mouthSy = 1.0; }
  if (expr === 'boost') { browTilt = 0.42; browLift = -0.006; mouthRot = Math.PI - 0.1; mouthSx = 1.2; mouthSy = 1.1; }
  if (expr === 'worried') { browTilt = 0.30; browLift = 0.008; mouthRot = 0; mouthSx = 0.95; mouthSy = 0.8; }
  if (expr === 'dizzy') { browTilt = 0.10; mouthRot = 0.15; mouthSx = 1.05; mouthSy = 0.55; }
  if (expr === 'ready') { browTilt = 0.18; mouthRot = Math.PI; mouthSx = 0.75; mouthSy = 0.35; }
  for (let i = 0; i < rig.brows.length; i++) {
    const sx = i === 0 ? -1 : 1;
    rig.brows[i].rotation.z = sx * browTilt;
    rig.brows[i].position.y = L.headR * 0.9 + 0.098 * L.cs + browLift;
  }
  rig.mouth.rotation.z = mouthRot;
  rig.mouth.scale.set(mouthSx, mouthSy, 1);

  // ── lights, flames, antenna
  const braking = speed < rig.lastSpeed - 0.35 && absSpeed > 0.2;
  rig.lastSpeed = speed;
  M.brake.emissiveIntensity = braking ? 2.6 : 0.55;
  M.head.emissiveIntensity = 1.0 + 0.15 * Math.sin(time * 3.1);
  const flameOn = boosting;
  for (let i = 0; i < rig.flames.length; i++) {
    const f = rig.flames[i];
    f.visible = flameOn;
    if (flameOn) {
      const k = 0.75 + 0.35 * Math.sin(time * 42 + i * 1.7);
      f.scale.set(k, 0.7 + 0.5 * k, k);
    } else {
      f.scale.set(0.001, 0.001, 0.001);
    }
  }
  if (rig.antenna) {
    rig.antenna.rotation.x = -(0.06 + 0.55 * sn) - 0.25 * recoil;
    rig.antenna.rotation.z = -steer * 0.14 * sn;
  }
  if (rig.spoiler && L.shape === 'wedge') rig.spoiler.rotation.x = -(0.05 + 0.12 * sn + (drifting ? 0.1 : 0));

  // ── record what the test (and any debug overlay) can read back
  st.steer = steer;
  st.roll = roll;
  st.pitch = pitch;
  st.yaw = rig.kartYaw.rotation.y;
  st.spinYaw = spinYaw;
  st.wheelRoll = rig.wheelRoll;
  st.squashY = sy;
  st.breathe = breathe;
  st.blink = open;
  st.expression = expr;
  st.airP = airP;
  st.reachArm = maxArm;
  st.reachLeg = maxLeg;
  st.clampArm = clampArm;
  st.clampLeg = clampLeg;
  const ik = rig.ik;
  if (minArmAngle < ik.minArmAngle) ik.minArmAngle = minArmAngle;
  if (minLegAngle < ik.minLegAngle) ik.minLegAngle = minLegAngle;
  rig.ik.lastMinArmAngle = minArmAngle;
  rig.ik.lastMinLegAngle = minLegAngle;
  rig.ik.lastMaxFlexLeg = maxFlexLeg;
  rig.ik.lastMaxFlexArm = maxFlexArm;
}

export default { createKart, updateKartVisual, solveLegIK, solveTwoBoneIK, kartDimensions, SHAPES };



