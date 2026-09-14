// src/input.js — keyboard + touch + gamepad → one integer bitmask.
//
// Input is a bitmask rather than a set of booleans because a bitmask is exactly what you
// later put on the wire: multiplayer is "ship bitmasks to a server". Bit 0 is the low bit.

export const BIT = {
  ACCEL: 1 << 0,
  BRAKE: 1 << 1,
  LEFT:  1 << 2,
  RIGHT: 1 << 3,
  DRIFT: 1 << 4,
  ITEM:  1 << 5,
  LOOK:  1 << 6,
};
export const NO_INPUT = 0;

// Default bindings. Arrow keys and WASD both drive; one key can set more than one bit.
const KEYMAP = {
  ArrowUp: BIT.ACCEL, KeyW: BIT.ACCEL,
  ArrowDown: BIT.BRAKE, KeyS: BIT.BRAKE,
  ArrowLeft: BIT.LEFT, KeyA: BIT.LEFT,
  ArrowRight: BIT.RIGHT, KeyD: BIT.RIGHT,
  ShiftLeft: BIT.DRIFT, ShiftRight: BIT.DRIFT, Space: BIT.DRIFT,
  KeyE: BIT.ITEM, Enter: BIT.ITEM,
  KeyQ: BIT.LOOK, KeyC: BIT.LOOK,
};

export function createInput() {
  let bits = 0;
  let touch = 0;
  let pad = 0;
  let enabled = true;
  const held = new Set();          // codes currently down, so releasing one of two ACCEL keys works
  const listeners = { down: [], up: [] };

  const recompute = () => {
    let b = 0;
    for (const code of held) b |= KEYMAP[code] || 0;
    bits = b;
  };

  const isTyping = () => {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  };

  const onKeyDown = (e) => {
    if (!KEYMAP[e.code] || isTyping()) return;
    e.preventDefault();
    if (!held.has(e.code)) { held.add(e.code); for (const f of listeners.down) f(e.code, KEYMAP[e.code]); }
    recompute();
  };
  const onKeyUp = (e) => {
    if (!held.has(e.code)) return;
    e.preventDefault();
    held.delete(e.code);
    for (const f of listeners.up) f(e.code, KEYMAP[e.code]);
    recompute();
  };
  const onBlur = () => { held.clear(); touch = 0; recompute(); };

  // Gamepad: standard mapping. A=accel, B=brake, bumper=drift, X=item, dpad/stick=steer.
  const READ_DEADZONE = 0.28;
  function readPad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let b = 0;
    for (const p of pads) {
      if (!p) continue;
      const [ax, ay] = [p.axes[0] || 0, p.axes[1] || 0];
      const btn = (i) => p.buttons[i] && p.buttons[i].pressed;
      if (btn(0) || btn(7) || ay < -READ_DEADZONE) b |= BIT.ACCEL;
      if (btn(1) || btn(6) || ay > READ_DEADZONE) b |= BIT.BRAKE;
      if (btn(14) || ax < -READ_DEADZONE) b |= BIT.LEFT;
      if (btn(15) || ax > READ_DEADZONE) b |= BIT.RIGHT;
      if (btn(4) || btn(5) || btn(10)) b |= BIT.DRIFT;
      if (btn(2) || btn(3)) b |= BIT.ITEM;
      if (btn(8)) b |= BIT.LOOK;
      break;
    }
    return b;
  }

  return {
    bits() {
      if (!enabled) return NO_INPUT;
      pad = readPad();
      return bits | touch | pad;
    },
    setEnabled(v) { enabled = !!v; if (!enabled) { held.clear(); touch = 0; } },
    setBits(b) { bits = b >>> 0; },                  // used by the CDP test hook
    // touch buttons are bound generically via data-in="accel" attributes in index.html
    setTouch(action, down) {
      const bit = BIT[String(action).toUpperCase()];
      if (!bit) return;
      if (down) touch |= bit; else touch &= ~bit;
    },
    attach(el = (typeof window !== 'undefined' ? window : null)) {
      if (!el || !el.addEventListener) return;
      el.addEventListener('keydown', onKeyDown, { passive: false });
      el.addEventListener('keyup', onKeyUp, { passive: false });
      el.addEventListener('blur', onBlur);
      document.querySelectorAll('[data-in]').forEach((node) => {
        const action = node.getAttribute('data-in');
        const set = (down) => { this.setTouch(action, down); node.classList.toggle('held', down); };
        node.addEventListener('touchstart', (e) => { e.preventDefault(); set(true); }, { passive: false });
        node.addEventListener('touchend', (e) => { e.preventDefault(); set(false); }, { passive: false });
        node.addEventListener('touchcancel', () => set(false));
        node.addEventListener('mousedown', (e) => { e.preventDefault(); set(true); });
        node.addEventListener('mouseup', () => set(false));
        node.addEventListener('mouseleave', () => set(false));
      });
    },
    detach(el = (typeof window !== 'undefined' ? window : null)) {
      if (!el || !el.removeEventListener) return;
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('keyup', onKeyUp);
      el.removeEventListener('blur', onBlur);
    },
    on(kind, fn) { (listeners[kind] = listeners[kind] || []).push(fn); },
    get heldCodes() { return [...held]; },
  };
}

export default createInput;
