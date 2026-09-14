// src/item-visuals.js — TURBO CIRCUIT: everything you SEE for items.
//
// Pooled and reconciled by item id every frame: the sim owns `state.items`, this file owns the
// meshes. Nothing here allocates per frame — a mesh is created once, reused forever, and
// returned to the pool when its item goes away. `activeCount` is exposed so a test can prove
// the pool actually drains instead of leaking a mesh per throw.
import * as THREE from '../vendor/three.module.js';
import { ITEMS, PALETTE } from './content.js';

const hex = (c) => new THREE.Color(c);

function hashBox(colour, glow) {
  const g = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  const m = new THREE.MeshStandardMaterial({
    color: hex(colour), emissive: hex(glow), emissiveIntensity: 0.75,
    transparent: true, opacity: 0.82, roughness: 0.25, metalness: 0.35,
  });
  return [g, m];
}

// Each thrown-item kind gets a distinct silhouette so it is readable at speed at 200m.
function buildItemMesh(kind) {
  const grp = new THREE.Group();
  const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); grp.add(m); return m; };

  switch (kind) {
    case 'oil':
      add(new THREE.CircleGeometry(1.5, 18),
        new THREE.MeshStandardMaterial({ color: hex('#0b0b12'), roughness: 0.15, metalness: 0.55 }))
        .rotation.x = -Math.PI / 2;
      add(new THREE.TorusGeometry(1.45, 0.09, 6, 18),
        new THREE.MeshStandardMaterial({ color: hex('#2a2a3a'), emissive: hex('#101020') }))
        .rotation.x = -Math.PI / 2;
      break;

    case 'cannonball':
      add(new THREE.SphereGeometry(0.85, 14, 10),
        new THREE.MeshStandardMaterial({ color: hex('#2f3238'), roughness: 0.35, metalness: 0.7 }));
      add(new THREE.TorusGeometry(0.86, 0.08, 6, 14),
        new THREE.MeshStandardMaterial({ color: hex('#e8e8ee'), emissive: hex('#555') }));
      break;

    case 'seeker':
      add(new THREE.ConeGeometry(0.62, 1.7, 12),
        new THREE.MeshStandardMaterial({ color: hex(PALETTE.warn), emissive: hex('#5a0d1c'), roughness: 0.4 }))
        .rotation.x = Math.PI / 2;
      add(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 10),
        new THREE.MeshStandardMaterial({ color: hex('#ffd166'), emissive: hex('#6b5200') }))
        .rotation.x = Math.PI / 2;
      break;

    case 'mine':
      add(new THREE.IcosahedronGeometry(0.95, 1),
        new THREE.MeshStandardMaterial({ color: hex('#3a3a44'), emissive: hex('#4a0d0d'), emissiveIntensity: 0.5, flatShading: true }));
      for (let i = 0; i < 6; i++) {
        const s = add(new THREE.ConeGeometry(0.18, 0.5, 6),
          new THREE.MeshStandardMaterial({ color: hex('#8c8c96') }));
        const a = (i / 6) * Math.PI * 2;
        s.position.set(Math.cos(a) * 0.85, Math.sin(a) * 0.85, 0);
        s.rotation.z = a - Math.PI / 2;
      }
      break;

    case 'pulse':
      add(new THREE.TorusGeometry(1.0, 0.22, 8, 26),
        new THREE.MeshStandardMaterial({ color: hex(PALETTE.hudEdge), emissive: hex('#1d6f7a'), emissiveIntensity: 1.1, transparent: true, opacity: 0.9 }))
        .rotation.x = -Math.PI / 2;
      add(new THREE.SphereGeometry(0.7, 12, 8),
        new THREE.MeshStandardMaterial({ color: hex('#ffffff'), emissive: hex(PALETTE.hudEdge), emissiveIntensity: 1.2, transparent: true, opacity: 0.7 }));
      break;

    case 'ink':
      add(new THREE.SphereGeometry(1.1, 12, 10),
        new THREE.MeshStandardMaterial({ color: hex('#0a0816'), emissive: hex('#1a0f3a'), emissiveIntensity: 0.4, roughness: 0.2, transparent: true, opacity: 0.92 }));
      break;

    default:
      add(new THREE.SphereGeometry(0.6, 10, 8),
        new THREE.MeshStandardMaterial({ color: hex(PALETTE.hudWarm), emissive: hex('#6b5200') }));
  }
  return grp;
}

export function createItemVisuals(scene) {
  const boxes = [];                        // one mesh per item box (about 16 per circuit)
  const boxGeo = new THREE.OctahedronGeometry(0.85, 0);
  const boxMat = new THREE.MeshStandardMaterial({
    color: hex('#ffffff'), emissive: hex(PALETTE.hudEdge), emissiveIntensity: 0.55,
    transparent: true, opacity: 0.72, roughness: 0.15, metalness: 0.3,
  });
  const boxMatSpent = new THREE.MeshStandardMaterial({
    color: hex('#555566'), transparent: true, opacity: 0.14, roughness: 0.5,
  });
  const boxGeo2 = new THREE.OctahedronGeometry(0.55, 0);
  const boxInnerMat = new THREE.MeshStandardMaterial({ color: hex(PALETTE.hudWarm), emissive: hex('#8a6a00'), emissiveIntensity: 0.7 });

  const pools = new Map();                 // kind -> [group, ...] free list
  const active = new Map();                // item id -> { group, kind }
  let activeCount = 0;

  function take(kind) {
    let list = pools.get(kind);
    if (!list) { list = []; pools.set(kind, list); }
    if (list.length) {
      const g = list.pop();
      g.visible = true;
      return g;
    }
    const g = buildItemMesh(kind);
    g.userData.kind = kind;
    scene.add(g);
    return g;
  }

  function release(id) {
    const rec = active.get(id);
    if (!rec) return;
    rec.group.visible = false;
    const list = pools.get(rec.kind) || [];
    list.push(rec.group);
    pools.set(rec.kind, list);
    active.delete(id);
    activeCount--;
  }

  function buildBoxes(state) {
    for (const b of boxes) scene.remove(b);
    boxes.length = 0;
    if (!state.pickups) return;
    for (const p of state.pickups) {
      const outer = new THREE.Mesh(boxGeo, boxMat);
      const inner = new THREE.Mesh(boxGeo2, boxInnerMat);
      outer.add(inner);
      outer.position.set(p.x, p.y, p.z);
      scene.add(outer);
      boxes.push(outer);
    }
  }

  function sync(state, dt) {
    if (!state) return;
    // the box set only changes when a different circuit is loaded
    const want = (state.pickups || []).length;
    if (boxes.length !== want) buildBoxes(state);

    // item boxes: spin, and go dark for the racer who just used them
    const playerIndex = state.playerIndex ?? 0;
    for (let i = 0; i < boxes.length && i < state.pickups.length; i++) {
      const p = state.pickups[i];
      const b = boxes[i];
      b.rotation.y += 0.012 + dt * 0.6;
      b.rotation.x = Math.sin(performanceNowFree(state, i)) * 0.18;
      b.position.y = p.y + Math.sin(state.tick * 0.04 + i) * 0.12;
      const spent = state.tick < p.cooldowns[playerIndex];
      b.material = spent ? boxMatSpent : boxMat;
      b.children[0].visible = !spent;
    }

    // thrown items
    const seen = new Set();
    for (const it of state.items) {
      seen.add(it.id);
      let rec = active.get(it.id);
      if (!rec) {
        const g = take(it.kind);
        rec = { group: g, kind: it.kind };
        active.set(it.id, rec);
        activeCount++;
      }
      const g = rec.group;
      g.position.set(it.x, it.y, it.z);
      g.rotation.y += 0.08 + dt * 1.4;
      const def = ITEMS[it.kind] || {};
      if (it.kind === 'seeker' || it.kind === 'cannonball') {
        g.rotation.y = Math.atan2(it.vx, it.vz);
        g.rotation.x = 0;
      }
      if (it.kind === 'mine') {
        const fuse = 1 - Math.max(0, it.ticksLeft) / Math.max(1, def.lifeTicks || 1);
        g.scale.setScalar(1 + Math.sin(state.tick * (0.1 + fuse * 0.6)) * 0.12);
        const m = g.children[0].material;
        m.emissiveIntensity = fuse > 0.75 ? (state.tick % 8 < 4 ? 2.2 : 0.2) : 0.5;
      }
      if (it.kind === 'pulse') {
        const grow = 1 + (1 - Math.max(0, it.ticksLeft) / Math.max(1, (ITEMS.pulse.delayTicks || 34))) * 8;
        g.scale.setScalar(grow);
      }
      if (it.kind === 'oil') {
        g.rotation.x = 0;
        g.children[0].rotation.x = -Math.PI / 2;
      }
    }
    for (const id of [...active.keys()]) if (!seen.has(id)) release(id);
  }

  // deterministic per-box bob that does not depend on any clock
  function performanceNowFree(state, i) { return state.tick * 0.05 + i * 1.3; }

  function dispose() {
    for (const id of [...active.keys()]) release(id);
    for (const [, list] of pools) for (const g of list) scene.remove(g);
    pools.clear();
    for (const b of boxes) scene.remove(b);
    boxes.length = 0;
    boxGeo.dispose(); boxGeo2.dispose(); boxMat.dispose(); boxMatSpent.dispose(); boxInnerMat.dispose();
  }

  return {
    sync, dispose,
    get activeCount() { return activeCount; },
    get pooledCount() { let n = 0; for (const [, l] of pools) n += l.length; return n; },
    get boxCount() { return boxes.length; },
  };
}

export default createItemVisuals;
