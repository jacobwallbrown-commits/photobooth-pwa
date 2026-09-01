// ─── TRIAL MAP OCR ──────────────────────────────────────────────────
// Reads a photo/screenshot of a trial map into a 2D grid of { plot, treatment }.
//
// Pass 1 reads the whole page. If the plot numbers form a value-anchored
// lattice (ARM style: x follows the position digit, y follows the rep digit),
// that lattice pins down every cell — including ones OCR couldn't read — so the
// region, the completion of missing plot numbers, and where to look for each
// treatment digit all fall out of the fit. Otherwise (e.g. a spreadsheet map
// whose rows mix reps) it falls back to density clustering of what was read.
//
// Best-effort: the caller shows an editable grid. Cells whose plot number was
// inferred rather than read are flagged `inferred`; treatment reads below a
// confidence floor are dropped, and middling ones flagged `trtUnsure`.

import { createWorker } from 'tesseract.js';

const TRT_MIN_CONF = 40;   // below this a treatment read is discarded
const TRT_SURE_CONF = 70;  // below this it's kept but flagged

// ARM plots are rep*100 + position; this rejects table numbers like 9885 or 297.
function plausible(s) {
  const n = +s;
  if (!(n >= 101 && n <= 6060)) return false;
  const rep = Math.floor(n / 100), pos = n % 100;
  return rep >= 1 && rep <= 60 && pos >= 1 && pos <= 60;
}
const isPlot = w => w.s.length >= 3 && plausible(w.s);
const isTrt = w => w.s.length <= 2 && +w.s >= 1;

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// 1-D coarse clustering: sorted values merged while within `tol` of the running centre.
function coarse(vals, tol) {
  const s = [...vals].sort((a, b) => a - b), cs = [];
  for (const v of s) {
    if (!cs.length || v - cs[cs.length - 1].c > tol) cs.push({ c: v, n: 1 });
    else { const k = cs[cs.length - 1]; k.c = (k.c * k.n + v) / (k.n + 1); k.n++; }
  }
  return cs.map(k => k.c);
}
function pitchOf(vals, minGap) {
  const cs = coarse(vals, minGap), g = [];
  for (let i = 1; i < cs.length; i++) g.push(cs[i] - cs[i - 1]);
  return median(g);
}
function collectWords(data) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.words) n.words.forEach(w => {
      const s = (w.text || '').trim();
      if (/^\d{1,4}$/.test(s)) {
        const b = w.bbox;
        out.push({ s, x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, conf: w.confidence || 0 });
      }
    });
    ['blocks', 'paragraphs', 'lines'].forEach(k => n[k] && walk(n[k]));
  })(data.blocks || data);
  return out;
}
// Union of two token sets; near-duplicates keep the more confident read.
function merge(a, b) {
  const out = [...a];
  for (const t of b) {
    const d = out.find(u => Math.abs(u.x - t.x) < 20 && Math.abs(u.y - t.y) < 20);
    if (!d) out.push(t); else if (t.conf > d.conf) Object.assign(d, t);
  }
  return out;
}
// Nearest treatment digit below-left of a cell centre, gated by confidence.
function pairTrt(trts, X, Y, rp, cp) {
  let b = null, bd = 1e9;
  for (const t of trts) {
    const dy = t.y - Y, dx = t.x - X;
    if (dy > rp * .12 && dy < rp * .75 && dx > -Math.abs(cp) * .4 && dx < Math.abs(cp) * .25 && dy < bd) { bd = dy; b = t; }
  }
  if (!b || b.conf < TRT_MIN_CONF) return { treatment: null, trtUnsure: false };
  return { treatment: +b.s, trtUnsure: b.conf < TRT_SURE_CONF };
}

// ── Lattice fit: x = x0 + (pos-1)*cp ; y = yRef + k*rp ; rep = rep0 + step*k ──
function fitLattice(tokens) {
  const P = tokens.filter(isPlot).filter(t => t.conf >= 30)
    .map(t => ({ ...t, pos: +t.s % 100, rep: Math.floor(+t.s / 100) }));
  const cands = [];
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], b = P[j];
    if (a.pos === b.pos || Math.abs(a.y - b.y) > 60) continue;
    cands.push((b.x - a.x) / (b.pos - a.pos));
  }
  if (cands.length < 3) return null;
  const cp = median(cands); if (Math.abs(cp) < 15) return null;
  const x0 = median(P.map(p => p.x - (p.pos - 1) * cp));
  const xin = P.filter(p => Math.abs(p.x - (x0 + (p.pos - 1) * cp)) < Math.abs(cp) * .3);
  if (xin.length < 4) return null;
  const rowsY = coarse(xin.map(p => p.y), 25); if (rowsY.length < 2) return null;
  const gaps = []; for (let i = 1; i < rowsY.length; i++) gaps.push(rowsY[i] - rowsY[i - 1]);
  const rp = median(gaps); if (!rp || rp < 20) return null;
  const dens = rowsY.map(y => xin.filter(p => Math.abs(p.y - y) < 25).length);
  const yRef = rowsY[dens.indexOf(Math.max(...dens))];
  const kOf = p => (p.y - yRef) / rp;
  const repAtK = {};
  xin.forEach(p => { const kf = kOf(p), k = Math.round(kf); if (Math.abs(kf - k) < .3) (repAtK[k] = repAtK[k] || []).push(p.rep); });
  const ks = Object.keys(repAtK).map(Number).sort((a, b) => a - b); if (ks.length < 2) return null;
  const rK = k => median(repAtK[k]);
  const st = []; for (let i = 1; i < ks.length; i++) st.push((rK(ks[i]) - rK(ks[i - 1])) / (ks[i] - ks[i - 1]));
  const step = median(st); if (Math.abs(step) !== 1) return null;
  const rep0 = rK(ks[0]) - step * ks[0];
  const inl = xin.filter(p => { const kf = kOf(p), k = Math.round(kf); return Math.abs(kf - k) < .3 && p.rep === rep0 + step * k; });
  if (inl.length < 6) return null;
  const kMin = Math.min(...inl.map(p => Math.round(kOf(p)))), kMax = Math.max(...inl.map(p => Math.round(kOf(p))));
  const maxPos = Math.max(...inl.map(p => p.pos));
  const cx = pos => x0 + (pos - 1) * cp, cy = k => yRef + k * rp;
  const bx = [cx(1) - .5 * cp, cx(maxPos) + .5 * cp].sort((a, b) => a - b), by = [cy(kMin) - .5 * rp, cy(kMax) + .7 * rp];
  const local = P.filter(p => p.x >= bx[0] && p.x <= bx[1] && p.y >= by[0] && p.y <= by[1]);
  if (inl.length / local.length < .6) return null;
  return { cp, x0, rp, yRef, step, rep0, kMin, kMax, maxPos, cx, cy };
}

async function latticeGrid(ocr, L, p1) {
  const repAt = k => L.rep0 + L.step * k;
  // ARM reps start at 1 — extend rows toward it, then keep only rows pass 2 can vouch for
  let kEnd = L.kMax; while (repAt(kEnd + 1) >= 1 && kEnd - L.kMax < 10) kEnd++;
  const xs = [L.cx(1) - .6 * L.cp, L.cx(L.maxPos) + .6 * L.cp].sort((a, b) => a - b);
  const top = L.cy(L.kMin) - .5 * L.rp;
  const rect = { left: Math.max(0, Math.round(xs[0])), top: Math.max(0, Math.round(top)),
    width: Math.round(xs[1] - xs[0]), height: Math.round(L.cy(kEnd) + .8 * L.rp - top) };
  const all = merge(p1, await ocr(rect));
  const plots = all.filter(isPlot), trts = all.filter(isTrt);
  const rowOk = k => k <= L.kMax || plots.some(p => Math.floor(+p.s / 100) === repAt(k) && Math.abs(p.y - L.cy(k)) < L.rp * .35);
  let lastOk = L.kMax; for (let k = L.kMax + 1; k <= kEnd; k++) if (rowOk(k)) lastOk = k;
  const grid = []; let anchored = 0, inferred = 0;
  for (let k = L.kMin; k <= lastOk; k++) {
    const rep = repAt(k), row = [];
    for (let pos = 1; pos <= L.maxPos; pos++) {
      const plot = rep * 100 + pos, X = L.cx(pos), Y = L.cy(k);
      const hit = plots.find(p => +p.s === plot && Math.abs(p.x - X) < Math.abs(L.cp) * .4 && Math.abs(p.y - Y) < L.rp * .4);
      if (hit) anchored++; else inferred++;
      row.push({ plot, ...pairTrt(trts, X, Y, L.rp, L.cp), inferred: !hit });
    }
    grid.push(row);
  }
  return { grid, rows: grid.length, cols: L.maxPos, filled: anchored + inferred, total: grid.length * L.maxPos, anchored, inferred, method: 'lattice' };
}

async function densityGrid(ocr, p1) {
  let pl = p1.filter(isPlot);
  if (pl.length < 6) return { grid: [], rows: 0, cols: 0, filled: 0, total: 0, anchored: 0, inferred: 0, lowConfidence: true, method: 'grid' };
  const mated = pl.filter(p => pl.some(o => o !== p && Math.abs(o.y - p.y) < 25)); if (mated.length >= 4) pl = mated;
  const xs = pl.map(p => p.x), ys = pl.map(p => p.y);
  const rect = { left: Math.max(0, Math.round(Math.min(...xs) - 70)), top: Math.max(0, Math.round(Math.min(...ys) - 30)),
    width: Math.round(Math.max(...xs) - Math.min(...xs) + 140), height: Math.round(Math.max(...ys) - Math.min(...ys) + 110) };
  const inR = t => t.x >= rect.left && t.x <= rect.left + rect.width && t.y >= rect.top && t.y <= rect.top + rect.height;
  const all = merge(p1.filter(inR), await ocr(rect));
  const plots = all.filter(isPlot), trts = all.filter(isTrt);
  const rp = pitchOf(plots.map(p => p.y), 25) || 60, cp = pitchOf(plots.map(p => p.x), 25) || 60;
  const cl = (vals, tol) => { const s = [...vals].sort((a, b) => a - b), g = []; for (const v of s) { const f = g.find(x => Math.abs(x.c - v) < tol); if (f) { f.items.push(v); f.c = f.items.reduce((a, b) => a + b, 0) / f.items.length; } else g.push({ c: v, items: [v] }); } return g; };
  const rg = cl(plots.map(p => p.y), Math.max(18, rp * .35)), cg = cl(plots.map(p => p.x), Math.max(30, cp * .35));
  const mR = Math.max(...rg.map(g => g.items.length)), mC = Math.max(...cg.map(g => g.items.length));
  const rows = rg.filter(g => g.items.length >= Math.max(2, mR * .3)).map(g => g.c).sort((a, b) => a - b);
  const cols = cg.filter(g => g.items.length >= Math.max(2, mC * .3)).map(g => g.c).sort((a, b) => a - b);
  const near = (cs, v) => { let bi = -1, bd = 1e9; cs.forEach((c, i) => { const d = Math.abs(c - v); if (d < bd) { bd = d; bi = i; } }); return { i: bi, d: bd }; };
  const grid = rows.map(() => cols.map(() => null));
  for (const p of plots) {
    const r = near(rows, p.y), c = near(cols, p.x);
    if (r.i < 0 || c.i < 0 || r.d > rp * .4 || c.d > cp * .45) continue;
    const cur = grid[r.i][c.i]; if (cur && cur.conf >= p.conf) continue;
    grid[r.i][c.i] = { plot: +p.s, ...pairTrt(trts, p.x, p.y, rp, cp), inferred: false, conf: p.conf };
  }
  let filled = 0; grid.forEach(r => r.forEach(c => { if (c) { filled++; delete c.conf; } }));
  return { grid, rows: rows.length, cols: cols.length, filled, total: rows.length * cols.length, anchored: filled, inferred: 0, method: 'grid' };
}

export async function scanTrialMap(imageSource, onProgress) {
  const worker = await createWorker('eng', 1, {
    logger: m => { if (onProgress && m.status === 'recognizing text') onProgress(m.progress * 0.5); },
  });
  try {
    await worker.setParameters({ tessedit_char_whitelist: '0123456789', preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' });
    const ocr = async rect => collectWords((await worker.recognize(imageSource, rect ? { rectangle: rect } : {}, { blocks: true })).data);
    const p1 = await ocr(null);
    if (onProgress) onProgress(0.55);
    const L = fitLattice(p1);
    const res = L ? await latticeGrid(ocr, L, p1) : await densityGrid(ocr, p1);
    if (onProgress) onProgress(1);
    return res;
  } finally {
    await worker.terminate();
  }
}
