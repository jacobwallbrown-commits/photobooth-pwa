// ─── TRIAL MAP OCR ──────────────────────────────────────────────────
// Reads a photo/screenshot of a trial map into a 2D grid of { plot, treatment }.
// Two passes: (1) whole image to locate the dense grid region, (2) focused
// recognition of that region for accuracy. Then clusters tokens into rows/cols
// and pairs each plot with the treatment number printed directly beneath it.
//
// Returns { grid, rows, cols, filled, total }. Best-effort — the caller shows
// an editable preview so the user can fix any missed cells.

import { createWorker } from 'tesseract.js';

function collectWords(data) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.words) n.words.forEach(w => {
      const t = (w.text || '').trim();
      if (/^\d{1,4}$/.test(t)) {
        const b = w.bbox;
        out.push({ t, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 });
      }
    });
    ['blocks', 'paragraphs', 'lines'].forEach(k => n[k] && walk(n[k]));
  })(data.blocks || data);
  return out;
}

function cluster(vals, tol) {
  const s = [...vals].sort((a, b) => a - b);
  const g = [];
  for (const v of s) {
    const f = g.find(x => Math.abs(x.c - v) < tol);
    if (f) { f.items.push(v); f.c = f.items.reduce((a, b) => a + b, 0) / f.items.length; }
    else g.push({ c: v, items: [v] });
  }
  return g;
}

const nearest = (cs, v) => {
  let bi = -1, bd = 1e9;
  cs.forEach((c, i) => { const d = Math.abs(c - v); if (d < bd) { bd = d; bi = i; } });
  return { i: bi, d: bd };
};

export async function scanTrialMap(imageSource, onProgress) {
  const worker = await createWorker('eng', 1, {
    logger: m => {
      if (onProgress && m.status === 'recognizing text') onProgress(m.progress);
    },
  });
  try {
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      preserve_interword_spaces: '1',
    });

    // Pass 1 — locate the dense grid of plot numbers
    if (onProgress) onProgress(0);
    const p1 = collectWords((await worker.recognize(imageSource, {}, { blocks: true })).data);
    const plots1 = p1.filter(w => w.t.length >= 3 && +w.t >= 100);
    if (plots1.length < 6) {
      return { grid: [], rows: 0, cols: 0, filled: 0, total: 0, lowConfidence: true };
    }
    const xs = plots1.map(p => p.cx).sort((a, b) => a - b);
    const ys = plots1.map(p => p.cy).sort((a, b) => a - b);
    const q = (a, f) => a[Math.max(0, Math.min(a.length - 1, Math.floor(a.length * f)))];
    const bx0 = q(xs, 0.02), bx1 = q(xs, 0.98), by0 = q(ys, 0.02), by1 = q(ys, 0.98);
    const rect = {
      left: Math.max(0, Math.round(bx0 - 60)),
      top: Math.max(0, Math.round(by0 - 25)),
      width: Math.round((bx1 - bx0) + 120),
      height: Math.round((by1 - by0) + 70),
    };

    // Pass 2 — focused recognition of the grid region
    const p2 = collectWords((await worker.recognize(imageSource, { rectangle: rect }, { blocks: true })).data);
    const plots = p2.filter(w => w.t.length >= 3 && +w.t >= 100);
    const trts = p2.filter(w => w.t.length <= 2);
    if (plots.length < 6) {
      return { grid: [], rows: 0, cols: 0, filled: 0, total: 0, lowConfidence: true };
    }

    const cg = cluster(plots.map(p => p.cx), 30);
    const rg = cluster(plots.map(p => p.cy), 18);
    const maxC = Math.max(...cg.map(g => g.items.length));
    const maxR = Math.max(...rg.map(g => g.items.length));
    const cols = cg.filter(g => g.items.length >= Math.max(3, maxC * 0.3)).map(g => g.c).sort((a, b) => a - b);
    const rows = rg.filter(g => g.items.length >= Math.max(3, maxR * 0.3)).map(g => g.c).sort((a, b) => a - b);

    const grid = Array.from({ length: rows.length }, () => Array(cols.length).fill(null));
    for (const p of plots) {
      const r = nearest(rows, p.cy), c = nearest(cols, p.cx);
      if (r.d > 25 || c.d > 45) continue; // stray token outside the grid
      let best = null, bd = 1e9;
      for (const tk of trts) {
        if (tk.cy > p.cy + 4 && tk.cy < p.cy + 40 && Math.abs(tk.cx - p.cx) < 30) {
          const d = tk.cy - p.cy; if (d < bd) { bd = d; best = tk; }
        }
      }
      grid[r.i][c.i] = { plot: +p.t, treatment: best ? +best.t : null };
    }

    let filled = 0;
    grid.forEach(row => row.forEach(c => { if (c) filled++; }));
    return { grid, rows: rows.length, cols: cols.length, filled, total: rows.length * cols.length };
  } finally {
    await worker.terminate();
  }
}
