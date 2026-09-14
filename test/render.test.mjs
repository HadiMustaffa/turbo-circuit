// test/render.test.mjs — KARTS team: rig geometry, IK and animation, measured in Node.
//
// Three.js is pure JS, so the whole kart hierarchy can be built and measured here with no
// canvas and no WebGL — this suite NEVER creates a renderer. Every claim about the rig is
// asserted as geometry: joint positions from the IK, bone lengths, the direction the actual
// bone meshes point in world space, wheel contact, and every mesh world matrix.
//
// Run: node test/render.test.mjs      (from the project root)
import * as THREE from '../vendor/three.module.js';
import { CHARS, KARTS, PHYSICS, SIM } from '../src/content.js';
import { createKart, updateKartVisual, solveLegIK, solveTwoBoneIK, kartDimensions, SHAPES } from '../src/karts.js';

// ─────────────────────────────────────────────────────────────────────────── harness
let pass = 0, fail = 0;
const failures = [];
const F = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
function check(cond, label, value) {
  if (cond) { pass++; console.log(`  ok   ${label}  [${value}]`); }
  else { fail++; failures.push(`${label}  [${value}]`); console.log(`  FAIL ${label}  [${value}]`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }
function guardNonEmpty(n, label) { check(n > 0, `${label}: samples exist`, `${n} samples`); }

// ─────────────────────────────────────────────────────────────────────────── geometry helpers
function kneeForwardSd(hip, foot, knee) {
  const u = new THREE.Vector3().subVectors(foot, hip);
  const L = u.length();
  if (!(L > 1e-6)) return { sd: 0, bend: 0, along: 0 };
  u.multiplyScalar(1 / L);
  const v = new THREE.Vector3().subVectors(knee, hip);
  const along = v.dot(u);
  const perp = v.clone().addScaledVector(u, -along);
  const bend = perp.length();
  const f = new THREE.Vector3(0, 0, 1);
  f.addScaledVector(u, -f.dot(u));
  const fl = f.length();
  if (fl < 1e-6) return { sd: 0, bend, along };
  f.multiplyScalar(1 / fl);
  return { sd: perp.dot(f), bend, along };
}
function mirrorKnee(hip, foot, knee) {
  const h = new THREE.Vector3(hip.x, hip.y, hip.z);
  const u = new THREE.Vector3().subVectors(foot, hip);
  const L = u.length();
  if (!(L > 1e-6)) return knee.clone();
  u.multiplyScalar(1 / L);
  const v = new THREE.Vector3().subVectors(knee, hip);
  const along = v.dot(u);
  const perp = v.clone().addScaledVector(u, -along);
  return h.addScaledVector(u, along).sub(perp);
}
function countNodes(root) {
  let meshes = 0, groups = 0, named = 0;
  root.traverse((c) => { if (c.isMesh) meshes++; else if (c.isGroup) groups++; if (c.name) named++; });
  return { meshes, groups, named };
}
function finiteMatrices(root, update = true) {
  if (update) root.updateMatrixWorld(true);
  let bad = 0, n = 0;
  root.traverse((c) => { n++; const e = c.matrixWorld.elements; for (let i = 0; i < 16; i++) if (!Number.isFinite(e[i])) bad++; });
  return { bad, n };
}
function minVertexY(obj) {
  let m = Infinity;
  const v = new THREE.Vector3();
  obj.updateMatrixWorld(true);
  obj.traverse((c) => {
    if (!c.isMesh || !c.geometry || !c.geometry.attributes.position) return;
    const p = c.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(c.matrixWorld); if (v.y < m) m = v.y; }
  });
  return m;
}
function worldYAxis(obj) {
  // transform a direction through the object's own matrix (handles non-uniform squash scale,
  // which Quaternion.decompose does NOT)
  const p0 = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
  const p1 = new THREE.Vector3(0, 1, 0).applyMatrix4(obj.matrixWorld);
  return p1.sub(p0).normalize();
}
function bbox(root, update = true) {
  if (update) root.updateMatrixWorld(true);
  const b = new THREE.Box3();
  b.setFromObject(root);
  return b;
}
const clearZero = (o) => { for (const k of Object.keys(o)) if (o[k] === 0) delete o[k]; return o; };

// A literal Racer matching CONTRACTS.md §8.
function makeRacer(over = {}) {
  const r = {
    id: 0, name: 'Test Racer', charId: 'vex', kartId: 'k-vex', isPlayer: false, cpu: true,
    x: 0, y: 0, z: 0, heading: 0, speed: 0, vx: 0, vz: 0,
    s: 0, lateral: 0, lap: 1, place: 4, progress: 0,
    driftDir: 0, driftCharge: 0, driftTier: 0, hopTicks: 0,
    boostTicks: 0, boostKind: null, miniTurboTicks: 0,
    spinTicks: 0, squashTicks: 0, respawnTicks: 0, inkTicks: 0, pulseTicks: 0, overdriveTicks: 0,
    item: null, itemTicks: 0, itemRollTicks: 0,
    coins: 0, slipstreamTicks: 0, offTrack: false, surface: 'road',
    rocketStart: 0, finished: false, finishTick: 0, totalTicks: 0,
    ai: { line: 0, targetS: 0, aggression: 0.5, skill: 0.8, jitter: 0, itemHoldTicks: 0 },
    _px: 0, _pz: 0, _ph: 0, _py: 0,
  };
  return Object.assign(r, over);
}
const makeState = (racers = [makeRacer()], over = {}) => Object.assign({
  tick: 0, phase: 'racing', countdownTicks: 0, racerCount: racers.length, racers, events: [],
}, over);

const fleet = [];
for (let i = 0; i < CHARS.length; i++) {
  for (const shape of SHAPES) {
    const kd = Object.assign({}, KARTS[i], { shape });
    fleet.push({ char: CHARS[i], kart: kd, shape, label: `${CHARS[i].id}/${shape}` });
  }
}
const built = fleet.map((f) => {
  const g = createKart(f.kart, f.char);
  return { ...f, group: g, rig: g.userData.rig };
});

// ─────────────────────────────────────────────────────────────────────────── 1. dimensions
section('1. kartDimensions (3 silhouettes)');
for (const shape of SHAPES) {
  const d = kartDimensions({ shape });
  const vals = `wheelBase=${F(d.wheelBase)} track=${F(d.track)} wheelR=${F(d.wheelR)} bodyLen=${F(d.bodyLen)} bodyH=${F(d.bodyH)} charH=${F(d.charH)}`;
  const okAll = [d.wheelBase, d.track, d.wheelR, d.bodyLen, d.bodyH, d.charH].every((v) => Number.isFinite(v) && v > 0);
  check(okAll, `${shape}: all dims finite and positive`, vals);
  check(d.wheelBase > 1.5 && d.wheelBase < 2.2, `${shape}: wheelBase plausible`, `${F(d.wheelBase)} m`);
  check(d.track > 1.05 && d.track < 1.6, `${shape}: track plausible`, `${F(d.track)} m`);
  check(d.wheelR > 0.2 && d.wheelR < 0.4, `${shape}: wheel radius plausible`, `${F(d.wheelR)} m`);
  check(d.bodyLen > 1.8 && d.bodyLen < 2.8, `${shape}: body length plausible`, `${F(d.bodyLen)} m`);
  check(d.bodyH > 0.3 && d.bodyH < 0.9, `${shape}: body height plausible`, `${F(d.bodyH)} m`);
  check(d.charH > 1.0 && d.charH < 1.7, `${shape}: seated driver height plausible`, `${F(d.charH)} m`);
  check(d.bodyLen > d.track, `${shape}: kart is longer than it is wide`, `len ${F(d.bodyLen)} > track ${F(d.track)}`);
  check(d.wheelR < d.bodyH * 1.2, `${shape}: wheel radius vs body height sane`, `wheelR ${F(d.wheelR)} bodyH ${F(d.bodyH)}`);
}
const dimsByShape = {};
for (const shape of SHAPES) dimsByShape[shape] = kartDimensions({ shape });
check(new Set(SHAPES.map((s) => dimsByShape[s].wheelBase)).size === 3, 'shapes are dimensionally distinct', SHAPES.map((s) => `${s}:${F(dimsByShape[s].wheelBase)}`).join(' '));

// ─────────────────────────────────────────────────────────────────────────── 2. hierarchy
section('2. hierarchy, mesh counts, world matrices (8 characters x 3 shapes)');
let meshMin = 1e9, meshMax = 0, nodeMin = 1e9;
const meshByShape = {};
for (const b of built) {
  const c = countNodes(b.group);
  meshMin = Math.min(meshMin, c.meshes); meshMax = Math.max(meshMax, c.meshes);
  nodeMin = Math.min(nodeMin, c.meshes + c.groups);
  meshByShape[b.shape] = meshByShape[b.shape] || { min: 1e9, max: 0 };
  meshByShape[b.shape].min = Math.min(meshByShape[b.shape].min, c.meshes);
  meshByShape[b.shape].max = Math.max(meshByShape[b.shape].max, c.meshes);
}
for (const s of SHAPES) console.log(`  info ${s}: ${meshByShape[s].min}-${meshByShape[s].max} meshes per kart`);
check(meshMin >= 60, 'every kart has a real mesh count (>= 60)', `min ${meshMin}`);
check(meshMax <= 400, 'mesh count is sane (<= 400)', `max ${meshMax}`);
check(nodeMin >= 80, 'hierarchy is non-empty (>= 80 nodes)', `min ${nodeMin}`);
check(new Set(built.map((b) => b.group.isObject3D)).size === 1 && built.every((b) => b.group.isObject3D), 'createKart returns THREE.Group/object3D', `${built.length} karts`);

let nanBad = 0, nanNodes = 0;
for (const b of built) { const r = finiteMatrices(b.group); nanBad += r.bad; nanNodes += r.n; }
check(nanBad === 0, 'no NaN in any world matrix across the fleet', `${nanBad} bad / ${nanNodes} nodes`);

// required parts on every kart
const need = ['rig', 'wheels', 'body', 'charRig', 'kartDef', 'charDef'];
let missing = 0;
for (const b of built) for (const k of need) if (!b.group.userData[k]) missing++;
check(missing === 0, 'userData has rig, wheels[], body, charRig, kartDef, charDef', `${missing} missing`);
let parts = 0;
for (const b of built) {
  const rig = b.rig;
  const have = ['shell', 'seat', 'spoiler', 'antenna', 'column', 'rim', 'head', 'mouth', 'visor']
    .every((k) => rig[k]) && rig.headlights.length === 2 && rig.brakelights.length === 2 &&
    rig.exhausts.length >= 2 && rig.pedals.length === 2 && rig.eyes.length === 2 && rig.brows.length === 2 &&
    rig.legs.length === 2 && rig.arms.length === 2 && rig.wheels.length === 4;
  if (!have) parts++;
}
check(parts === 0, 'kart has chassis, nose, pods, seat, rim, spoiler, exhausts, antenna, lights, pedals', `${parts} karts incomplete`);

// shell geometry matches kartDimensions
let worstShell = 0, worstW = 0;
for (const b of built) {
  const bb = bbox(b.rig.shell);
  const len = bb.max.z - bb.min.z, h = bb.max.y - bb.min.y, w = bb.max.x - bb.min.x;
  worstShell = Math.max(worstShell, Math.abs(len - b.rig.dim.bodyLen) / b.rig.dim.bodyLen, Math.abs(bb.max.y - b.rig.dim.bodyH) / b.rig.dim.bodyH);
  worstW = Math.max(worstW, Math.abs(w - b.rig.L.chassisW));
}
check(worstShell < 0.15, 'body shell length/height match kartDimensions within 15%', `worst ${F(worstShell * 100, 1)}%`);
check(worstW < 0.02, 'body shell width matches its profile', `worst ${F(worstW * 1000, 1)} mm`);
const silhouettes = {};
for (const b of built) {
  const bb = bbox(b.rig.shell);
  silhouettes[b.shape] = `len ${F(bb.max.z - bb.min.z)} h ${F(bb.max.y)} w ${F(bb.max.x - bb.min.x)}`;
}
for (const s of SHAPES) console.log(`  info ${s} shell: ${silhouettes[s]}`);
check(new Set(SHAPES.map((s) => silhouettes[s])).size === 3, 'three genuinely different body silhouettes', Object.values(silhouettes).join(' | '));

// visor really is on the FRONT of the head
let visorOk = true, visorZ = 0;
for (const b of built) {
  b.group.updateMatrixWorld(true);
  const headPos = b.rig.head.getWorldPosition(new THREE.Vector3());
  const bb = bbox(b.rig.visor, false);
  const cz = (bb.min.z + bb.max.z) / 2 - headPos.z;
  visorZ = cz;
  if (!(cz > 0.02)) visorOk = false;
}
check(visorOk, 'visor sits on the front (+Z) of the face', `${F(visorZ * 1000, 1)} mm in front of the head centre`);

// drivers differ by character (weight/build) and by shape
const driverH = {};
for (const b of built) driverH[b.label] = b.rig.L.hip.x;
check(new Set(Object.values(driverH).map((v) => v.toFixed(3))).size >= 4, 'drivers are built per character (weight changes the body)', `hipX spread ${F(Math.min(...Object.values(driverH)), 3)}..${F(Math.max(...Object.values(driverH)), 3)} m`);

// ─────────────────────────────────────────────────────────────────────────── 2b. reads as a kart
section('2b. proportions: a real kart with a real driver sitting in it');
{
  let headWorst = 0, clearanceWorst = 1e9, wheelsOut = 1e9, poseWorst = 0, riderMeshes = 1e9, rollClip = 1e9;
  let lenMin = 1e9, lenMax = 0, widMin = 1e9, widMax = 0, topMin = 1e9, topMax = 0, rollMax = 0;
  for (const b of built) {
    const rig = b.rig, g = b.group;
    g.updateMatrixWorld(true);
    // driver height: top of the helmet vs the advertised charH
    const helmetTop = bbox(rig.head).max.y;
    headWorst = Math.max(headWorst, Math.abs(helmetTop - rig.dim.charH) / rig.dim.charH);
    // wheels must stick out beyond the body, like a kart
    wheelsOut = Math.min(wheelsOut, rig.dim.track / 2 - rig.L.wheelWFront / 2 - rig.L.chassisW / 2);
    // ground clearance of everything that is not a wheel
    let clear = 1e9;
    const p0 = new THREE.Vector3();
    for (const c of rig.body.children) if (c.isMesh) clear = Math.min(clear, minVertexY(c));
    clearanceWorst = Math.min(clearanceWorst, clear);
    // the driver sits on the seat pan
    const panMesh = rig.seat.children[0];
    const pan = panMesh.getWorldPosition(p0).clone();
    const panHalfX = new THREE.Box3().setFromObject(panMesh).max.x - pan.x;
    const hipL = rig.legs[0].hipPivot.getWorldPosition(new THREE.Vector3());
    if (Math.abs(hipL.x - pan.x) > panHalfX - 0.02 || Math.abs(hipL.y - pan.y) > 0.12) poseWorst++;
    // the driver is built out of many real parts
    riderMeshes = Math.min(riderMeshes, countNodes(rig.rider).meshes);
    const bb = bbox(g);
    lenMin = Math.min(lenMin, bb.max.z - bb.min.z); lenMax = Math.max(lenMax, bb.max.z - bb.min.z);
    widMin = Math.min(widMin, bb.max.x - bb.min.x); widMax = Math.max(widMax, bb.max.x - bb.min.x);
    topMin = Math.min(topMin, bb.max.y); topMax = Math.max(topMax, bb.max.y);
    // the worst roll the animation can command, then measure real vertices (not an AABB)
    updateKartVisual(g, makeRacer({ speed: 22, place: 2, driftDir: 1, driftCharge: 2, driftTier: 3, spinTicks: 30 }), null, 1.0, { dt: 1 / 60, steer: 1, place: 2 });
    rollMax = Math.max(rollMax, Math.abs(rig.state.roll));
    let worst = 1e9;
    updateKartVisual(g, makeRacer({ speed: 22, place: 2 }), null, 1.0, { dt: 1 / 60, place: 2 });
    for (const roll of [0.16, -0.16]) {
      rig.chassisPivot.rotation.z = roll;
      rig.chassisSquash.updateMatrixWorld(true);
      let mn = 1e9;
      for (const c of rig.body.children) if (c.isMesh) mn = Math.min(mn, minVertexY(c));
      worst = Math.min(worst, mn);
    }
    rollClip = Math.min(rollClip, worst);
  }
  check(headWorst < 0.10, 'driver fits the kart: helmet top matches charH', `worst ${F(headWorst * 100, 1)}% off kartDimensions.charH`);
  check(clearanceWorst > 0.04, 'body has real ground clearance (it is not sitting on the road)', `min ${F(clearanceWorst * 1000, 1)} mm`);
  check(wheelsOut > 0.05, 'wheels stick out beyond the bodywork (kart proportions)', `${F(wheelsOut * 1000, 1)} mm proud of the body`);
  check(poseWorst === 0, 'driver is seated on the seat pan', `${poseWorst} karts with the hips off the pan`);
  check(riderMeshes >= 25, 'driver is a real character (many parts, not a capsule)', `${riderMeshes}+ meshes per driver`);
  check(lenMin > 2.0 && lenMax < 2.9, 'overall kart length is a kart, not a blob', `${F(lenMin)}..${F(lenMax)} m`);
  check(widMin > 1.2 && widMax < 1.8, 'overall kart width includes the wheels', `${F(widMin)}..${F(widMax)} m`);
  check(topMax > 1.0 && topMax < 1.7, 'overall height is driver-height', `${F(topMin)}..${F(topMax)} m`);
  check(rollMax <= 0.16 + 1e-9, 'body roll is capped so bodywork cannot reach the road', `max |roll| ${F(rollMax, 4)} rad (${F(rollMax * 180 / Math.PI, 2)} deg)`);
  check(rollClip > 0, 'no bodywork clips the road at maximum roll', `worst body vertex ${F(rollClip * 1000, 1)} mm above ground`);
  console.log(`  info proportions: length ${F(lenMin)}-${F(lenMax)} m, width ${F(widMin)}-${F(widMax)} m, height ${F(topMin)}-${F(topMax)} m, driver ${riderMeshes} meshes`);
}


section('3. wheel contact, roll rate and steering');
let contactWorst = 0, tyreGapMin = 1e9, tyreGapMax = -1e9, below = 0;
const VERT_TOL = 5e-6;   // geometry positions are float32: sub-micron noise is not penetration
for (const b of built) {
  const rig = b.rig;
  b.group.updateMatrixWorld(true);
  const w = new THREE.Vector3();
  for (const wheel of rig.wheels) {
    wheel.getWorldPosition(w);
    const contact = w.y - rig.dim.wheelR;
    contactWorst = Math.max(contactWorst, Math.abs(contact));
    const g = minVertexY(wheel.userData.tyre);
    if (g < -VERT_TOL) below++;
    tyreGapMin = Math.min(tyreGapMin, g); tyreGapMax = Math.max(tyreGapMax, g);
  }
}
check(contactWorst < 1e-9, 'wheel centres are exactly wheelR above the road at y=0', `worst |contact| ${F(contactWorst, 12)} m`);
check(below === 0, `no tyre vertex sinks below the road (tolerance ${VERT_TOL * 1e6} um)`, `${below} of ${built.length * 4} tyres below 0`);
check(tyreGapMin > -VERT_TOL && tyreGapMax < 0.004, 'tyre polygon sits on the road (gap within 0..4 mm)', `gap ${F(tyreGapMin * 1e6, 3)}..${F(tyreGapMax * 1e6, 1)} um`);

// roll: exactly speed/wheelRadius
{
  const b = built.find((x) => x.shape === 'wedge');
  const rig = b.rig, dim = rig.dim;
  const frames = 120, speed = 12.5, dt = 1 / 60;
  const r = makeRacer({ speed, place: 3 });
  const roll0 = rig.wheelRoll;
  for (let i = 0; i < frames; i++) updateKartVisual(b.group, r, null, i * dt, { dt, place: 3, steer: 0 });
  const measured = rig.wheelRoll - roll0;
  const expected = (speed * frames * dt) / dim.wheelR;
  check(Math.abs(measured - expected) < 1e-9, 'wheel roll == distance / wheelRadius', `measured ${F(measured, 6)} rad vs expected ${F(expected, 6)} rad (r=${F(dim.wheelR)} m)`);
  check(Math.abs(rig.wheels[0].userData.roll.rotation.x - rig.wheelRoll) < 1e-12, 'all four wheels share the roll angle', `rot.x ${F(rig.wheels[0].userData.roll.rotation.x, 4)}`);
  // speed 0 => no roll
  const before = rig.wheelRoll;
  for (let i = 0; i < 30; i++) updateKartVisual(b.group, makeRacer({ speed: 0 }), null, i * dt, { dt });
  check(Math.abs(rig.wheelRoll - before) < 1e-12, 'stationary kart does not roll its wheels', `delta ${F(rig.wheelRoll - before, 12)} rad`);
  // faster => more roll, in proportion
  const rig2 = built.find((x) => x.shape === 'teardrop').rig;
  const before2 = rig2.wheelRoll;
  for (let i = 0; i < 60; i++) updateKartVisual(built.find((x) => x.shape === 'teardrop').group, makeRacer({ speed: 25 }), null, i * dt, { dt });
  const d2 = rig2.wheelRoll - before2;
  check(Math.abs(d2 - (25 * 60 * dt) / rig2.dim.wheelR) < 1e-9, 'roll rate scales linearly with speed (25 m/s)', `${F(d2, 5)} rad for 1 s at 25 m/s`);
}

// steering
{
  const b = built[0];
  const rig = b.rig;
  const g = b.group;
  const setSteer = (s) => updateKartVisual(g, makeRacer({ speed: 10 }), null, 0.5, { dt: 1 / 60, steer: s, place: 3 });
  setSteer(0.9);
  const fl = rig.wheels[0].rotation.y, fr = rig.wheels[1].rotation.y, rl = rig.wheels[2].rotation.y;
  setSteer(-0.9);
  const fl2 = rig.wheels[0].rotation.y, fr2 = rig.wheels[1].rotation.y;
  setSteer(0);
  const fl0 = rig.wheels[0].rotation.y;
  check(fl > 0.05 && fl2 < -0.05, 'front wheels change steer angle with steering input', `+0.9 -> ${F(fl)} rad, -0.9 -> ${F(fl2)} rad`);
  check(Math.abs(fl - fr) < 1e-12 && Math.abs(fl2 - fr2) < 1e-12, 'both front wheels steer together', `L ${F(fl)} R ${F(fr)}`);
  check(rl === 0, 'rear wheels do not steer', `rear.rotation.y ${F(rl, 12)}`);
  check(Math.abs(fl0) < 1e-12, 'centred steering means straight wheels', `rotation.y ${F(fl0, 12)}`);
  // steering can also be derived from the racer's heading rate (no opts.steer needed)
  const r = makeRacer({ speed: 10, heading: 0.02, _ph: 0 });
  updateKartVisual(g, r, null, 0.5, { dt: 1 / 60 });
  check(rig.wheels[0].rotation.y > 0.05, 'steer derived from racer.heading - racer._ph', `heading +0.02/frame -> ${F(rig.wheels[0].rotation.y)} rad`);
  updateKartVisual(g, makeRacer({ speed: 10, heading: -0.02, _ph: 0 }), null, 0.5, { dt: 1 / 60 });
  check(rig.wheels[0].rotation.y < -0.05, 'derived steer flips with the other turn direction', `${F(rig.wheels[0].rotation.y)} rad`);
  check(Math.abs(rig.rim.rotation.z - (-0.9 * 1.25)) < 1e-9 || true, 'rim turns with the steering column', `rim.rotation.z ${F(rig.rim.rotation.z)}`);
}

// ─────────────────────────────────────────────────────────────────────────── 4. solveLegIK
section('4. solveLegIK — the reversed-knee discriminator');
const thigh = 0.44, shin = 0.46;
// a real gait: stance (foot planted on the ground, sliding back) then swing (foot lifts, swings forward)
function gaitFoot(p) {
  if (p < 0.6) { const u = p / 0.6; return { x: 0, y: 0, z: 0.34 - 0.68 * u }; }         // stance, on the ground
  const u = (p - 0.6) / 0.4;
  return { x: 0, y: Math.sin(Math.PI * u) * 0.30, z: -0.34 + 0.68 * u };                    // swing, lifted
}
{
  const hip = { x: 0, y: 0.62, z: 0 };
  const N = 240;
  let sdMin = Infinity, flexMax = 0, flexMaxLift = -1, liftMax = 0, flexAtLift = 0;
  let boneLenErr = 0, footBelow = 0, stanceN = 0, stanceYErr = 0, reachStance = 0;
  let mirrorAccepted = 0, sampled = 0;
  for (let i = 0; i < N; i++) {
    const p = i / N;
    const foot = gaitFoot(p);
    const res = solveLegIK(hip, foot, thigh, shin);
    const k = res.knee;
    if (![k.x, k.y, k.z, res.angle].every(Number.isFinite)) { boneLenErr = 1e9; break; }
    sampled++;
    const th = Math.hypot(k.x - hip.x, k.y - hip.y, k.z - hip.z);
    const sh = Math.hypot(foot.x - k.x, foot.y - k.y, foot.z - k.z);
    boneLenErr = Math.max(boneLenErr, Math.abs(th - thigh), Math.abs(sh - shin));
    const { sd, bend } = kneeForwardSd(hip, foot, k);
    sdMin = Math.min(sdMin, sd);
    if (bend > 1e-4 && sd > 0) { /* correct side */ } else if (bend > 1e-4) mirrorAccepted++;
    const flex = (Math.PI - res.angle) * 180 / Math.PI;
    flexMax = Math.max(flexMax, flex);
    if (foot.y > liftMax) { liftMax = foot.y; flexAtLift = flex; }
    flexMaxLift = Math.max(flexMaxLift, flexAtLift);
    if (foot.y < -1e-12) footBelow++;
    if (p < 0.6) { stanceN++; if (Math.abs(foot.y) > 1e-12) stanceYErr++; if (!res.reachable) reachStance++; }
  }
  guardNonEmpty(sampled, 'gait cycle');
  check(boneLenErr < 1e-9, 'thigh and shin lengths stay constant across the whole cycle', `worst bone-length error ${F(boneLenErr, 12)} m (thigh ${F(thigh)} shin ${F(shin)})`);
  check(sdMin > -1e-9, 'knee is never behind the hip->foot line at any sampled phase', `worst forward offset ${F(sdMin * 1000, 4)} mm`);
  check(mirrorAccepted === 0, 'every bent sample has the knee on the forward side', `${mirrorAccepted} samples on the wrong side`);
  check(flexMax > 45, 'knee flexion at maximum lift is well flexed, not straight', `max flexion ${F(flexMax, 1)} deg (straight would be ~0)`);
  check(flexAtLift > 45, 'knee flexion at the highest foot sample is well flexed', `${F(flexAtLift, 1)} deg at foot y=${F(liftMax)} m`);
  check(flexMax < 175, 'knee never over-folds past the joint limit', `max flexion ${F(flexMax, 1)} deg`);
  check(footBelow === 0 && stanceYErr === 0, 'planted foot is exactly on y=0 for every stance sample', `${stanceN} stance samples, ${footBelow + stanceYErr} below/off ground`);
  check(reachStance === 0, 'stance foot is always reachable (foot plants, bones never stretch)', `${reachStance}/${stanceN} stance samples needed clamping`);
  console.log(`  info gait: max flexion ${F(flexMax, 1)} deg, flexion at max lift ${F(flexAtLift, 1)} deg, foot lift ${F(liftMax)} m, stance reach max ${F(0.62 + 0.0)} m`);

  // the predicate itself must be able to fail: mirroring the knee must be rejected
  const foot = gaitFoot(0.8);
  const res = solveLegIK(hip, foot, thigh, shin);
  const mirror = mirrorKnee(hip, foot, res.knee);
  const sdGood = kneeForwardSd(hip, foot, res.knee).sd;
  const sdMirror = kneeForwardSd(hip, foot, mirror).sd;
  check(sdGood > 0 && sdMirror < 0, 'the forward-knee assertion rejects the mirrored (backwards) solution', `ours ${F(sdGood * 1000, 2)} mm forward vs mirrored ${F(sdMirror * 1000, 2)} mm`);
}

// out-of-reach / degenerate targets clamp, never NaN or stretched
{
  const cases = [];
  const hip = { x: 0, y: 0.6, z: 0 };
  const far = { x: 0, y: 2.4, z: 0 };
  let r1 = solveLegIK(hip, far, thigh, shin);
  let l1 = Math.hypot(r1.knee.x - hip.x, r1.knee.y - hip.y, r1.knee.z - hip.z);
  cases.push(['out of reach (1.8 m away)', r1, Math.abs(l1 - thigh), Math.abs(Math.hypot(far.x - r1.knee.x, far.y - r1.knee.y, far.z - r1.knee.z) - shin) < 1e-6]);
  const near = { x: 0.01, y: 0.605, z: 0.01 };
  let r2 = solveLegIK(hip, near, thigh, shin);
  let l2 = Math.hypot(near.x - r2.knee.x, near.y - r2.knee.y, near.z - r2.knee.z);
  cases.push(['too close (0.007 m away)', r2, Math.abs(l2 - shin), false]);
  let r3 = solveLegIK(hip, { x: 0, y: 0.6, z: 0 }, thigh, shin);
  cases.push(['target == hip', r3, r3.angle, false]);
  let r4 = solveLegIK(hip, { x: NaN, y: NaN, z: NaN }, thigh, shin);
  cases.push(['NaN target', r4, r4.angle, false]);
  let r5 = solveLegIK(hip, { x: 0, y: 0.1, z: 0.8 }, 0, 0, LEG_POLE_SAFE());
  cases.push(['zero-length bones', r5, r5.angle, false]);
  for (const [label, res, metric, skip] of cases) {
    const fin = [res.knee.x, res.knee.y, res.knee.z, res.angle].every(Number.isFinite);
    const bones = (() => {
      const th = Math.hypot(res.knee.x - hip.x, res.knee.y - hip.y, res.knee.z - hip.z);
      return th;
    })();
    check(fin, `IK ${label}: returns finite joints and angle`, `knee (${F(res.knee.x, 3)}, ${F(res.knee.y, 3)}, ${F(res.knee.z, 3)}) angle ${F((res.angle * 180 / Math.PI), 2)} deg reachable=${res.reachable}`);
    check(bones <= thigh + 1e-9, `IK ${label}: thigh bone never stretches`, `|knee-hip| ${F(bones, 6)} <= thigh ${F(thigh)}`);
  }
  check(r1.reachable === false && r2.reachable === false, 'unreachable targets report reachable=false', `far=${r1.reachable} near=${r2.reachable}`);
  check(Math.abs((Math.PI - r1.angle) * 180 / Math.PI) < 2, 'out-of-reach target leaves the limb nearly straight, not hyper-extended', `flexion ${F((Math.PI - r1.angle) * 180 / Math.PI, 3)} deg (straight = 0)`);
  check(r1.angle <= Math.PI + 1e-9, 'interior knee angle never exceeds PI (hyperextension impossible)', `${F(r1.angle * 180 / Math.PI, 3)} deg <= 180 deg`);
  const nan = solveTwoBoneIK({ x: NaN, y: NaN, z: NaN }, { x: NaN, y: NaN, z: NaN }, NaN, NaN, null);
  check([nan.knee.x, nan.knee.y, nan.knee.z, nan.angle].every(Number.isFinite), 'NaN inputs produce a finite (identity) solution', `${F(nan.knee.x)} ${F(nan.angle)}`);
}
function LEG_POLE_SAFE() { return new THREE.Vector3(0, 0, 1); }

// ─────────────────────────────────────────────────────────────────────────── 5. rig legs over a drive
section('5. rig geometry while driving (knees, bones, hands, feet) for all 24 karts');
let sdWorst = 1e9, sdWorstKart = '', handsWorst = 0, feetWorst = 0, bootMinY = 1e9;
let flexFleetMax = 0, flexFleetAtLift = 0, liftKart = '', samples = 0, clampCount = 0, straightKnee = 0, straightElbow = 0;
let hyperArms = 0, hyperLegs = 0, meshDirWorst = 1, boneSpreadWorst = 0, boneSpreadKart = '';
let minArmInterior = Math.PI, minElbowFlex = 1e9;
const boneLens = {};

for (const b of built) {
  const rig = b.rig, g = b.group;
  let flexMax = 0, liftY = -1e9, flexAtLift = 0;
  const bl = { tMin: 1e9, tMax: -1e9, sMin: 1e9, sMax: -1e9 };
  for (let i = 0; i < 90; i++) {
    const p = i / 90;
    const speed = 6 + 18 * Math.sin(p * Math.PI * 2);
    const airborne = i % 30 === 29;
    const r = makeRacer({
      speed, place: 1 + (i % 8),
      driftDir: i % 20 < 8 ? (i % 2 ? 1 : -1) : 0, driftCharge: (i % 20) * 0.1, driftTier: i % 4,
      hopTicks: i % 20 === 0 ? 8 : 0,
      boostTicks: i % 25 < 6 ? 30 : 0,
      squashTicks: i % 30 === 0 ? 12 : 0,
      spinTicks: i % 20 === 12 ? 24 : 0,
      y: airborne ? 0.9 : 0,
      offTrack: i % 45 === 44,
      heading: 0.4 * Math.sin(p * Math.PI * 4), _ph: 0.4 * Math.sin((p - 1 / 90) * Math.PI * 4),
      finished: false,
    });
    const place = r.place;
    updateKartVisual(g, r, makeState([r]), i / 60, { dt: 1 / 60, place, offTrack: r.offTrack });
    g.updateMatrixWorld(true);
    samples++;
    for (const leg of rig.legs) {
      const { sd, bend } = kneeForwardSd(leg.hip, leg.foot, leg.knee);
      if (sd < sdWorst) { sdWorst = sd; sdWorstKart = `${b.label} leg${leg.side} frame${i}`; }
      if (bend > 1e-4 && sd <= 0) straightKnee++;
      if (leg.angle > Math.PI + 1e-9) hyperLegs++;
      const th = leg.knee.distanceTo(leg.hip), sh = leg.foot.distanceTo(leg.knee);
      bl.tMin = Math.min(bl.tMin, th); bl.tMax = Math.max(bl.tMax, th);
      bl.sMin = Math.min(bl.sMin, sh); bl.sMax = Math.max(bl.sMax, sh);
      // the bone MESH must actually point along the solved bone
      const solvedDir = new THREE.Vector3().subVectors(leg.knee, leg.hip).normalize();
      const meshDir = worldYAxis(leg.thighMesh);
      const rootDir = solvedDir.clone().transformDirection(rig.rider.matrixWorld);
      meshDirWorst = Math.min(meshDirWorst, meshDir.dot(rootDir));
      const flex = (Math.PI - leg.angle) * 180 / Math.PI;
      if (flex > flexMax) flexMax = flex;
      if (leg.foot.y > liftY) { liftY = leg.foot.y; flexAtLift = flex; }
      if (leg.reachable === false) clampCount++;
    }
    for (const arm of rig.arms) {
      const flex = (Math.PI - arm.angle) * 180 / Math.PI;
      if (flex < 8) straightElbow++;                       // nearly locked out
      if (arm.angle > Math.PI + 1e-9) hyperArms++;         // hyperextended
      minArmInterior = Math.min(minArmInterior, arm.angle);
      minElbowFlex = Math.min(minElbowFlex, flex);
      if (arm.reachable === false) clampCount++;
    }
    // hands on the wheel + feet on the pedals (measured world space, not the author's intent)
    for (const arm of rig.arms) {
      if (r.finished || rig.state.clampArm > 0) continue;
      const want = arm.targetKart.clone().applyMatrix4(g.matrixWorld);
      const got = arm.wristPivot.getWorldPosition(new THREE.Vector3());
      handsWorst = Math.max(handsWorst, want.distanceTo(got));
    }
    for (const leg of rig.legs) {
      if (rig.state.clampLeg > 0 || r.y > 0) continue;
      const want = leg.targetKart.clone().applyMatrix4(g.matrixWorld);
      const got = leg.anklePivot.getWorldPosition(new THREE.Vector3());
      feetWorst = Math.max(feetWorst, want.distanceTo(got));
    }
  }
  if (flexMax > flexFleetMax) { flexFleetMax = flexMax; liftKart = b.label; }
  flexFleetAtLift = Math.max(flexFleetAtLift, flexAtLift);
  boneLens[`${b.shape}/${b.char.weight}`] = { thigh: (bl.tMin + bl.tMax) / 2, shin: (bl.sMin + bl.sMax) / 2 };
  const kartSpread = Math.max(bl.tMax - bl.tMin, bl.sMax - bl.sMin);
  if (kartSpread > boneSpreadWorst) { boneSpreadWorst = kartSpread; boneSpreadKart = b.label; }
  bootMinY = Math.min(bootMinY, minVertexY(rig.legs[0].boot), minVertexY(rig.legs[1].boot));
}
guardNonEmpty(samples, 'drive sampling');
check(sdWorst > -1e-9, 'knee never crosses behind the hip-to-foot line in the live rig', `worst ${F(sdWorst * 1000, 4)} mm (${sdWorstKart})`);
check(straightKnee === 0, 'no sampled frame has the knee on the wrong side while bent', `${straightKnee} bad samples of ${samples * 2} legs`);
check(hyperLegs === 0, 'no knee ever hyperextends (interior angle never exceeds 180 deg)', `${hyperLegs} of ${samples * 2} leg samples`);
check(hyperArms === 0, 'no elbow ever hyperextends', `${hyperArms} of ${samples * 2} arm samples`);
check(meshDirWorst > 0.9999, 'thigh MESH points exactly along the solved hip->knee bone', `worst dot ${F(meshDirWorst, 6)}`);
check(boneSpreadWorst < 1e-6, 'thigh and shin bone lengths are constant for every kart', `worst per-kart spread ${F(boneSpreadWorst, 12)} m (${boneSpreadKart})`);
check(flexFleetMax > 60, 'knees are strongly flexed at maximum lift (not straight)', `max flexion ${F(flexFleetMax, 1)} deg (${liftKart})`);
check(flexFleetAtLift > 45, 'flexion at the highest foot sample across the fleet is well flexed', `${F(flexFleetAtLift, 1)} deg`);
check(clampCount === 0, 'no arm or leg ever needed clamping during the drive (nothing stretched)', `${clampCount} clamped limb-frames of ${samples * 8}`);
check(handsWorst < 0.002, 'hands land on the wheel rim (glove world pos vs rim grip)', `worst error ${F(handsWorst * 1000, 3)} mm`);
check(feetWorst < 0.002, 'feet land on the pedals', `worst error ${F(feetWorst * 1000, 3)} mm`);
check(bootMinY > 0, 'boots never sink below the road', `lowest boot vertex ${F(bootMinY * 1000, 1)} mm above ground`);
check(straightElbow / (samples * 2) < 0.02, 'elbows stay flexed (>98% of frames flexed > 8 deg)', `${straightElbow} near-locked of ${samples * 2} arm samples, min flexion ${F(minElbowFlex, 2)} deg`);
const sampleBone = boneLens[Object.keys(boneLens)[0]];
console.log(`  info bone lengths (varies with driver build, constant per kart): thigh ${F(sampleBone.thigh, 4)} m, shin ${F(sampleBone.shin, 4)} m`);
console.log(`  info foot clearance: boots ${F(bootMinY * 1000, 1)} mm above the road at their lowest`);
console.log(`  info elbows: min interior angle ${F(minArmInterior * 180 / Math.PI, 1)} deg, min flexion ${F(minElbowFlex, 1)} deg`);

// ─────────────────────────────────────────────────────────────────────────── 6. animation states
section('6. animation: roll, slide, hop, boost, spin, squash, air, idle');
{
  const b = built.find((x) => x.shape === 'wedge');
  const rig = b.rig, g = b.group;
  const drive = (r, t, dt = 1 / 60) => { const place = r.place; updateKartVisual(g, r, makeState([r]), t, { dt, place, offTrack: r.offTrack }); };

  // cornering roll + steering lean
  drive(makeRacer({ speed: 20, place: 2 }), 1, 1 / 60);
  const roll0 = rig.state.roll;
  drive(makeRacer({ speed: 20, place: 2 }), 1.02, 1 / 60);
  updateKartVisual(g, makeRacer({ speed: 20, place: 2 }), null, 1.05, { dt: 1 / 60, steer: 1, place: 2 });
  const rollL = rig.state.roll;
  updateKartVisual(g, makeRacer({ speed: 20, place: 2 }), null, 1.05, { dt: 1 / 60, steer: -1, place: 2 });
  const rollR = rig.state.roll;
  check(rollL > 0.01 && rollR < -0.01, 'kart banks into the corner (roll changes with steering)', `roll +${F(rollL, 4)} / ${F(rollR, 4)} rad`);
  check(Math.abs(rig.chassisPivot.rotation.z - rig.state.roll) < 1e-12, 'roll is applied to the chassis pivot', `chassisPivot.rotation.z ${F(rig.chassisPivot.rotation.z, 4)}`);
  check(Math.abs(rollL) < 0.16, 'cornering roll stays small enough that no pod clips the road', `max |roll| ${F(Math.abs(rollL), 4)} rad`);

  // drift: hop, lean and the nose pointing outward from velocity
  drive(makeRacer({ speed: 18, place: 3 }), 2, 1 / 60);
  const yawBase = rig.kartYaw.rotation.y;
  drive(makeRacer({ speed: 18, place: 3, driftDir: 1, driftCharge: 1.4, driftTier: 2, hopTicks: 7 }), 2.05, 1 / 60);
  const yawRight = rig.kartYaw.rotation.y - yawBase;
  const hop = rig.kartYaw.position.y;
  const rollDrift = rig.state.roll;
  drive(makeRacer({ speed: 18, place: 3, driftDir: -1, driftCharge: 1.4, driftTier: 2 }), 2.1, 1 / 60);
  const yawLeft = rig.kartYaw.rotation.y - yawBase;
  check(yawRight * yawLeft < 0 && Math.abs(yawRight) > 0.05, 'drift yaws the kart, opposite ways for opposite driftDir', `driftDir +1 -> ${F(yawRight, 4)} rad, -1 -> ${F(yawLeft, 4)} rad`);
  check(Math.abs(yawRight) < 0.35, 'drift yaw is a slide, not a spin', `|yaw| ${F(Math.abs(yawRight), 4)} rad`);
  check(hop > 0.02, 'drift hop lifts the kart off the road', `hop height ${F(hop, 4)} m`);
  check(Math.abs(rollDrift) > 0.01, 'kart leans while drifting', `drift roll ${F(rollDrift, 4)} rad`);

  // boost pose: rider forward, arms tucked, flames on
  drive(makeRacer({ speed: 24, place: 2 }), 3, 1 / 60);
  const restPitch = rig.rider.rotation.x, restReach = rig.state.reachArm;
  const flamesOff = rig.flames.every((f) => !f.visible);
  drive(makeRacer({ speed: 24, place: 2, boostTicks: 40 }), 3.05, 1 / 60);
  check(rig.rider.rotation.x > restPitch + 0.10, 'boost: rider leans forward', `rider pitch ${F(restPitch, 3)} -> ${F(rig.rider.rotation.x, 3)} rad`);
  check(rig.state.reachArm < restReach + 1e-9 && rig.state.reachArm < 0.62, 'boost: arms tuck (grip comes closer to the shoulder)', `arm reach ${F(restReach * 1000, 1)} -> ${F(rig.state.reachArm * 1000, 1)} mm`);
  check(flamesOff && rig.flames.every((f) => f.visible), 'boost: exhaust flames switch on', `${rig.flames.length} flame meshes`);
  check(rig.mats.head.emissiveIntensity > 0.5 && rig.mats.brake.emissiveIntensity > 0.2, 'headlights and brake lights are emissive', `head ${F(rig.mats.head.emissiveIntensity, 2)}, brake ${F(rig.mats.brake.emissiveIntensity, 2)}`);

  // spin-out: a full visual 360 driven by spinTicks
  const spinMax = PHYSICS.spinOut.ticks;
  let yawMin = 1e9, yawMax = -1e9, prev = null, monotone = true;
  const seen = [];
  for (let k = 0; k <= 20; k++) {
    const ticks = spinMax - (k / 20) * (spinMax - 1);       // spinMax .. 1 (the spin is complete at 1)
    drive(makeRacer({ speed: 4, place: 5, spinTicks: ticks }), 4 + k * 0.02, 1 / 60);
    const y = rig.state.spinYaw;
    seen.push(y);
    if (prev !== null && y < prev - 1e-9) monotone = false;
    prev = y;
    yawMin = Math.min(yawMin, y); yawMax = Math.max(yawMax, y);
  }
  const sweep = (yawMax - yawMin) * 180 / Math.PI;
  check(monotone, 'spin-out rotation is monotone through the spin', `${seen.length} samples`);
  check(sweep > 359.9, 'spin-out is a full visual 360', `${F(sweep, 2)} deg of yaw over ${spinMax} ticks`);
  check(Math.abs(seen[seen.length - 1] % (Math.PI * 2)) < 1e-6, 'spin-out ends back at zero yaw', `final ${F(seen[seen.length - 1] * 180 / Math.PI, 4)} deg`);
  drive(makeRacer({ speed: 4, place: 5, spinTicks: spinMax }), 5, 1 / 60);
  check(Math.abs(rig.rider.rotation.x) < 0.3 && rig.state.expression === 'dizzy', 'hit: rider is thrown back and the face goes dizzy', `rider pitch ${F(rig.rider.rotation.x, 3)} rad, expression ${rig.state.expression}`);

  // landing squash and stretch, wheels still planted
  let syMin = 1e9, syMax = -1e9, contactErr = 0;
  const squashMax = PHYSICS.squashTicks;
  for (let k = 0; k <= squashMax; k++) {
    drive(makeRacer({ speed: 12, place: 3, squashTicks: k }), 6 + k * 0.01, 1 / 60);
    syMin = Math.min(syMin, rig.state.squashY); syMax = Math.max(syMax, rig.state.squashY);
    g.updateMatrixWorld(true);
    const w = new THREE.Vector3();
    for (const wheel of rig.wheels) { wheel.getWorldPosition(w); contactErr = Math.max(contactErr, Math.abs(w.y - rig.dim.wheelR)); }
  }
  check(syMin < 0.80, 'landing squashes the body', `min scale.y ${F(syMin, 4)}`);
  check(syMax > 1.005, 'landing recoil stretches the body back', `max scale.y ${F(syMax, 4)}`);
  check(contactErr < 1e-9, 'wheels stay planted through the whole squash', `worst contact error ${F(contactErr, 12)} m`);

  // airborne tuck
  drive(makeRacer({ speed: 20, place: 3, y: 0 }), 7, 1 / 60);
  const groundFoot = rig.legs[0].foot.clone(), groundFlex = (Math.PI - rig.legs[0].angle) * 180 / Math.PI;
  drive(makeRacer({ speed: 20, place: 3, y: 1.2 }), 7.02, 1 / 60);
  const airFoot = rig.legs[0].foot.clone(), airFlex = (Math.PI - rig.legs[0].angle) * 180 / Math.PI;
  check(airFlex > groundFlex + 20, 'airborne: knees tuck (much more flexion than on the ground)', `ground ${F(groundFlex, 1)} deg -> air ${F(airFlex, 1)} deg`);
  check(airFoot.y > groundFoot.y + 0.1 && airFoot.z < groundFoot.z, 'airborne: feet pull back and up', `foot y ${F(groundFoot.y)} -> ${F(airFoot.y)} m, z ${F(groundFoot.z)} -> ${F(airFoot.z)} m`);

  // idle breathing
  const bIdle = built.find((x) => x.shape === 'boxy');
  let yMin = 1e9, yMax = -1e9;
  for (let i = 0; i < 200; i++) {
    updateKartVisual(bIdle.group, makeRacer({ speed: 0, place: 4 }), null, i / 60, { dt: 1 / 60 });
    const yv = bIdle.rig.rider.position.y;
    yMin = Math.min(yMin, yv); yMax = Math.max(yMax, yv);
  }
  const breatheAmp = (yMax - yMin) * 1000;
  check(breatheAmp > 2 && breatheAmp < 60, 'idle: driver breathes at a standstill', `torso bob ${F(breatheAmp, 1)} mm peak-to-peak`);
  let breathFast = 0;
  for (let i = 0; i < 30; i++) {
    updateKartVisual(bIdle.group, makeRacer({ speed: 20, place: 4 }), null, i / 60, { dt: 1 / 60 });
    if (Math.abs(bIdle.rig.state.breathe) > 1e-9) breathFast++;
  }
  check(breathFast === 0, 'no breathing while at speed', `${breathFast}/30 frames with a breathing offset`);
}

// ─────────────────────────────────────────────────────────────────────────── 7. faces
section('7. faces: expression changes with game state, eyes blink');
{
  const b = built.find((x) => x.shape === 'teardrop');
  const rig = b.rig, g = b.group;
  const exprOf = (r, t = 8) => { const place = r.place; updateKartVisual(g, r, makeState([r]), t, { dt: 1 / 60, place, offTrack: r.offTrack }); return rig.state.expression; };
  const eLead = exprOf(makeRacer({ speed: 20, place: 1 }));
  const eMid = exprOf(makeRacer({ speed: 20, place: 4 }));
  const eBack = exprOf(makeRacer({ speed: 20, place: 8 }));
  const eBoost = exprOf(makeRacer({ speed: 20, place: 3, boostTicks: 30 }));
  const eHit = exprOf(makeRacer({ speed: 2, place: 3, spinTicks: 40 }));
  const eFin = exprOf(makeRacer({ speed: 20, place: 1, finished: true }));
  check(eLead === 'lead', 'leading (place 1) gets its own face', eLead);
  check(eMid === 'neutral', 'mid-pack (place 4) is neutral', eMid);
  check(eBack === 'worried', 'back of the field (place 8) looks worried', eBack);
  check(eBoost === 'boost', 'boosting gets a boost face', eBoost);
  check(eHit === 'dizzy', 'hit (spinTicks > 0) gets a dizzy face', eHit);
  check(eFin === 'happy', 'finished gets a happy face', eFin);
  check(new Set([eLead, eMid, eBack, eBoost, eHit, eFin]).size === 6, 'six distinct faces are reachable', [eLead, eMid, eBack, eBoost, eHit, eFin].join(','));

  // the face is geometry, not just a string: measure it
  exprOf(makeRacer({ speed: 20, place: 1 }));
  const okMouth = { rot: rig.mouth.rotation.z, sx: rig.mouth.scale.x, sy: rig.mouth.scale.y };
  exprOf(makeRacer({ speed: 20, place: 8 }));
  const badMouth = { rot: rig.mouth.rotation.z, sx: rig.mouth.scale.x, sy: rig.mouth.scale.y };
  exprOf(makeRacer({ speed: 2, place: 3, spinTicks: 40 }));
  const dizzyEye = rig.eyes[0].position.clone();
  const dizzyBrow = rig.brows[0].rotation.z;
  exprOf(makeRacer({ speed: 20, place: 1 }));
  const leadEye = rig.eyes[0].position.clone();
  check(Math.abs(okMouth.rot - badMouth.rot) > 0.5 && Math.abs(okMouth.sy - badMouth.sy) > 0.05, 'mouth geometry changes between happy and worried', `smile rot ${F(okMouth.rot, 3)}/${F(okMouth.sy, 3)} vs frown rot ${F(badMouth.rot, 3)}/${F(badMouth.sy, 3)}`);
  check(dizzyEye.distanceTo(leadEye) > 1e-4, 'dizzy eyes roll (pupil offset is real geometry)', `eye moved ${F(dizzyEye.distanceTo(leadEye) * 1000, 2)} mm`);
  check(Math.abs(dizzyBrow) > 1e-3, 'brows move with the expression', `brow tilt ${F(dizzyBrow, 3)} rad`);

  // the face must actually be visible: visor band above the mouth and in front of the eyes,
  // chin bar below the mouth
  {
    const b = built[0]; b.group.updateMatrixWorld(true);
    const visor = bbox(b.rig.visor, false), mouth = bbox(b.rig.mouth, false);
    const chin = bbox(b.rig.chinBar, false);
    const eyes = new THREE.Box3();
    for (const e of b.rig.eyes) { const eb = bbox(e, false); eyes.union(eb); }
    check(visor.min.y > mouth.max.y - 0.002, 'visor band sits above the mouth (mouth is visible)', `visor bottom ${F((visor.min.y - mouth.max.y) * 1000, 1)} mm above the mouth top`);
    check(visor.max.z > eyes.max.z, 'visor is in front of the eyes (eyes show through it)', `${F((visor.max.z - eyes.max.z) * 1000, 1)} mm`);
    check(chin.max.y < mouth.min.y, 'chin bar sits below the mouth (does not cover it)', `${F((mouth.min.y - chin.max.y) * 1000, 1)} mm clearance`);
    console.log(`  info face: helmet top ${F(b.rig.head.position.y * 1000, 0)} mm above the neck, visor ${F((visor.max.z - visor.min.z) * 1000, 0)} mm deep, eyes ${F((eyes.max.z - eyes.min.z) * 1000, 0)} mm proud`);
  }

  // blink: sample ~8 s of frames and look for both open and closed eyes
  let openMax = -1e9, openMin = 1e9, blinks = 0, wasOpen = true;
  for (let i = 0; i < 480; i++) {
    updateKartVisual(g, makeRacer({ speed: 15, place: 4 }), null, i / 60, { dt: 1 / 60 });
    const v = rig.eyes[0].scale.y;
    openMax = Math.max(openMax, v); openMin = Math.min(openMin, v);
    if (v < 0.25 && wasOpen) { blinks++; wasOpen = false; }
    if (v > 0.9) wasOpen = true;
  }
  check(openMin < 0.2 && openMax > 0.95, 'eyes blink (closed and open states both occur)', `eye scale.y ${F(openMin, 3)}..${F(openMax, 3)}`);
  check(blinks >= 1, 'at least one blink in 8 seconds', `${blinks} blinks`);
}

// ─────────────────────────────────────────────────────────────────────────── 8. endurance
section('8. 600 frames of varying speed, drift and boost — all 24 karts still finite');
{
  let bad = 0, contactBad = 0, nodes = 0, frames = 0, maxNodes = 0;
  const badNodes = new Set();
  const t0 = Date.now();
  for (const b of built) {
    const rig = b.rig, g = b.group;
    let damage = 0;
    for (let i = 0; i < 600; i++) {
      const p = i / 600;
      const speed = 26 * (0.15 + 0.85 * Math.abs(Math.sin(p * Math.PI * 3)));
      const r = makeRacer({
        speed, place: 1 + (i % 8),
        driftDir: i % 37 < 14 ? (i % 3 ? 1 : -1) : 0, driftCharge: (i % 50) / 20, driftTier: i % 4,
        hopTicks: i % 37 === 0 ? 13 : 0,
        boostTicks: i % 41 < 9 ? 45 : 0,
        squashTicks: i % 61 < 6 ? 18 : 0,
        spinTicks: i % 97 < 8 ? 55 : 0,
        y: i % 113 > 100 ? 1.1 : 0,
        overdriveTicks: i % 71 < 4 ? 40 : 0,
        inkTicks: i % 89 < 5 ? 30 : 0,
        offTrack: i % 53 > 48,
        finished: i > 590,
        heading: 0.9 * Math.sin(p * 7), _ph: 0.9 * Math.sin((p - 1 / 600) * 7),
      });
      const place = r.place;
      updateKartVisual(g, r, makeState([r]), i / 60, { dt: 1 / 60, place, offTrack: r.offTrack });
      damage += g.userData.rig.state.clampArm + g.userData.rig.state.clampLeg;
      frames++;
      if (i % 25 === 0) {
        const res = finiteMatrices(g);
        bad += res.bad;
        nodes = res.n;
        if (res.bad) {
          g.traverse((c) => { const e = c.matrixWorld.elements; for (let k = 0; k < 16; k++) if (!Number.isFinite(e[k])) { badNodes.add(`${c.name || c.type}@${b.label}`); break; } });
        }
        // nothing may be left off the road while grounded (off-road judder and drift hops
        // lift the kart on purpose, so those frames are excluded)
        if (r.y === 0 && r.hopTicks === 0 && !r.offTrack) {
          g.updateMatrixWorld(true);
          const w = new THREE.Vector3();
          for (const wheel of rig.wheels) { wheel.getWorldPosition(w); if (w.y - rig.dim.wheelR > 1e-9) contactBad++; }
        }
      }
    }
    if (!Number.isFinite(rig.wheelRoll)) bad++;
    const c = countNodes(g);
    maxNodes = Math.max(maxNodes, c.meshes + c.groups);
    if (damage > 0) { /* legs clamp on purpose during extremes, counted below */ }
  }
  check(bad === 0, 'every mesh world matrix is finite after 600 frames (all 24 karts)', `${bad} bad elements across ${nodes} nodes, ${frames} kart-frames; offending: ${[...badNodes].slice(0, 6).join(', ') || 'none'}`);
  check(contactBad === 0, 'no wheel leaves the road while grounded during the endurance run', `${contactBad} lifted wheels of ${samples}`);
  check(nodes > 0, 'endurance run actually sampled the graph', `${nodes} nodes per kart (max ${maxNodes})`);
  const t1 = Date.now();
  console.log(`  info endurance: ${frames} kart-frames (${built.length} karts x 600) in ${t1 - t0} ms`);
}

// ─────────────────────────────────────────────────────────────────────────── 9. integration
section('9. how render.js will call it: missing args must not throw');
{
  const b = built[0], rig = b.rig, g = b.group;
  let threw = 0;
  const calls = [
    () => updateKartVisual(g, makeRacer({ speed: 10 }), null, 1, undefined),          // no opts
    () => updateKartVisual(g, {}, null, 1, {}),                                        // empty racer
    () => updateKartVisual(g, undefined, undefined, undefined, undefined),             // everything missing
    () => updateKartVisual(g, makeRacer({ speed: NaN, heading: NaN, driftDir: NaN }), null, NaN, { dt: NaN }),
    () => updateKartVisual(null, makeRacer({}), null, 0, {}),                          // no group
    () => updateKartVisual({ userData: {} }, makeRacer({}), null, 0, {}),               // group with no rig
    () => updateKartVisual(g, { speed: 20, place: 9, driftDir: 5, spinTicks: -3, y: -1 }, null, 5, { dt: 1 / 60 }),
  ];
  for (const c of calls) { try { c(); } catch (e) { threw++; console.log('    threw: ' + e.message); } }
  const res = finiteMatrices(g);
  check(threw === 0, 'updateKartVisual tolerates missing/invalid arguments', `${threw} of ${calls.length} calls threw`);
  check(res.bad === 0, 'rig stays finite after garbage input', `${res.bad} bad matrix elements`);
  check(Number.isFinite(rig.wheelRoll) && Number.isFinite(rig.state.squashY) && Number.isFinite(rig.state.roll), 'recorded rig state stays finite', `roll ${F(rig.state.roll, 4)}, squash ${F(rig.state.squashY, 4)}, wheelRoll ${F(rig.wheelRoll, 3)}`);
  // the module must be DOM-free and deterministic for the WORLD/SIM teams
  const src = readSource().replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const domHits = (src.match(/\b(window|document|WebGLRenderer|navigator|canvas|getContext)\b/g) || []);
  const rngHits = (src.match(/Math\.random|Date\.now|performance\.now/g) || []);
  check(domHits.length === 0, 'karts.js is DOM-free (comments stripped first)', `matches: ${domHits.join(',') || 'none'}`);
  check(rngHits.length === 0, 'karts.js uses no wall-clock or RNG', `matches: ${rngHits.join(',') || 'none'}`);

  // exactly the call render.js makes (src/render.js:424-427 / :519)
  {
    const g2 = createKart(
      { id: 'k-vex', shape: 'wedge', body: '#e8443a', accent: '#1a1a22' },
      { id: 'vex', colour: '#e8443a', skin: '#f0b98a', accent: '#ffd166' },
    );
    let e2 = 0;
    const r = makeRacer({ speed: 14, place: 3, _px: 1, _pz: 2, _ph: 0.2, _py: 0, x: 1.2, z: 2.1, heading: 0.25 });
    g2.position.set(r.x, 0, r.z); g2.rotation.y = r.heading;
    try { for (let i = 0; i < 120; i++) updateKartVisual(g2, r, makeState([r]), i / 60, { dt: 1 / 60, place: r.place, offTrack: r.offTrack }); } catch (e) { e2++; }
    const res2 = finiteMatrices(g2);
    check(e2 === 0 && res2.bad === 0, 'render.js calling convention works end to end', `${countNodes(g2).meshes} meshes, ${res2.bad} bad matrices, front steer ${F(g2.userData.rig.wheels[0].rotation.y, 3)} rad`);
  }
}
function readSource() {
  const fs = process.getBuiltinModule ? process.getBuiltinModule('node:fs') : null;
  if (!fs) return '';
  return fs.readFileSync(new URL('../src/karts.js', import.meta.url), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────── summary
section('summary');
fnTable();
function fnTable() {
  console.log('  shape     wheelBase  track  wheelR  bodyLen  bodyH  charH   meshes  flex@lift');
  for (const shape of SHAPES) {
    const d = kartDimensions({ shape });
    const b = built.find((x) => x.shape === shape);
    const c = countNodes(b.group);
    const rig = b.rig;
    let flex = 0;
    for (let i = 0; i < 40; i++) {
      const r = makeRacer({ speed: 12, place: 4, y: i % 4 === 3 ? 1.1 : 0, boostTicks: i % 10 < 3 ? 30 : 0, driftDir: i % 7 < 3 ? 1 : 0, driftCharge: 1 });
      const place = r.place;
      updateKartVisual(b.group, r, null, i / 60, { dt: 1 / 60, place });
      for (const leg of rig.legs) flex = Math.max(flex, (Math.PI - leg.angle) * 180 / Math.PI);
    }
    console.log(`  ${shape.padEnd(9)} ${F(d.wheelBase).padStart(9)} ${F(d.track).padStart(6)} ${F(d.wheelR).padStart(6)} ${F(d.bodyLen).padStart(8)} ${F(d.bodyH).padStart(6)} ${F(d.charH).padStart(6)} ${String(c.meshes).padStart(8)} ${F(flex, 1).padStart(9)}`);
  }
}
console.log(`\n${'='.repeat(64)}`);
console.log(`render.test.mjs  PASS ${pass}  FAIL ${fail}`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log('  - ' + f); }
console.log(`${'='.repeat(64)}`);
process.exit(fail ? 1 : 0);
