// tools/png-inspect.mjs — decode a PNG with zero dependencies (node:zlib) and describe it
// as text: dimensions, luminance grid, dominant colours, and an ASCII map.
//
// Why: an agent that cannot see images still has to sanity-check its own renders. This
// turns a screenshot into something readable in a terminal, so composition problems
// (black frame, HUD missing, everything in one corner) are actually detectable.
//
//   node tools/png-inspect.mjs shots/race-hud.png [--cols 96] [--rows 34]
//   node tools/png-inspect.mjs shots/start-grid.png
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit PNGs supported (got ' + bitDepth + ')');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error('unsupported colour type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride); pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      switch (filter) {
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
        default: break;
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

function inspect(path, cols, rows) {
  const img = decodePNG(readFileSync(path));
  const { width: w, height: h, channels: ch, data } = img;
  const luma = new Float32Array(w * h);
  const hist = new Map();
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * ch;
      const r = data[o], g = ch >= 3 ? data[o + 1] : data[o], b = ch >= 3 ? data[o + 2] : data[o];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luma[y * w + x] = l; sum += l;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  const mean = sum / (w * h);
  let varSum = 0;
  for (let i = 0; i < luma.length; i++) varSum += (luma[i] - mean) ** 2;
  const std = Math.sqrt(varSum / luma.length);

  const CH = ' .:-=+*#%@';
  const cellW = w / cols, cellH = h / rows;
  const lines = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      let s = 0, n = 0;
      const x0 = Math.floor(rx * cellW), x1 = Math.min(w, Math.ceil((rx + 1) * cellW));
      const y0 = Math.floor(ry * cellH), y1 = Math.min(h, Math.ceil((ry + 1) * cellH));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += luma[y * w + x]; n++; }
      const v = n ? s / n : 0;
      const idx = Math.max(0, Math.min(CH.length - 1, Math.round(Math.pow(v / 255, 0.55) * (CH.length - 1))));
      line += CH[idx];
    }
    lines.push(line);
  }

  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => {
    const r = (k >> 8) & 15, g = (k >> 4) & 15, b = k & 15;
    return `#${r.toString(16)}${r.toString(16)}${g.toString(16)}${g.toString(16)}${b.toString(16)}${b.toString(16)} ${(c / (w * h) * 100).toFixed(1)}%`;
  });

  // region report (3x3 grid) so "HUD present / sky present" is measurable
  const regions = [];
  for (let gy = 0; gy < 3; gy++) {
    const row = [];
    for (let gx = 0; gx < 3; gx++) {
      let s = 0, n = 0, mx = 0;
      for (let y = Math.floor(gy * h / 3); y < Math.floor((gy + 1) * h / 3); y++) {
        for (let x = Math.floor(gx * w / 3); x < Math.floor((gx + 1) * w / 3); x++) {
          const v = luma[y * w + x]; s += v; n++; mx = Math.max(mx, v);
        }
      }
      row.push(`${(s / n).toFixed(0)}/${mx.toFixed(0)}`);
    }
    regions.push(row.join('  '));
  }

  console.log(`\n${path}  ${w}x${h}  mean luma ${mean.toFixed(1)} (sd ${std.toFixed(1)})`);
  console.log(`regions (mean/peak luma, 3x3):  ${regions.join('   |   ')}`);
  console.log(`dominant colours: ${top.join('   ')}`);
  console.log(`\n${lines.join('\n')}\n`);
}

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const getNum = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : dflt; };
if (!file) {
  console.error('usage: node tools/png-inspect.mjs <file.png> [--cols 96] [--rows 34]');
  process.exit(2);
}
inspect(file, getNum('--cols', 96), getNum('--rows', 34));
