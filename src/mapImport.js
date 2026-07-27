// ─── TRIAL MAP IMPORT (Excel / CSV / ARM PDF) ──────────────────────
// Reliable, offline alternatives to OCR. Both produce the same shape the
// rest of the app uses: a 2D grid of { plot, treatment } cells.
//
//  Excel  – ARM "Trial Map" sheets store each plot as one cell whose text is
//           "907\r\n8"  (plot, newline, treatment). The grid position in the
//           sheet IS the field layout, so we keep row/col as-is.
//  PDF    – ARM Spray/Seeding Plans carry a treatment table with one row per
//           treatment and one column per rep, listing the plot assigned to
//           each. We read the text layer (exact, no OCR) and invert it.

// Parse a single Excel cell like "907\r\n8" → { plot, treatment }
export function parseCellText(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const parts = text.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (!/^\d{2,4}$/.test(parts[0])) return null;          // first line must be a plot number
  const plot = parseInt(parts[0], 10);
  if (!(plot >= 10)) return null;
  let treatment = null;
  if (parts[1] != null && /^\d{1,3}$/.test(parts[1])) treatment = parseInt(parts[1], 10);
  return { plot, treatment };
}

// Build a grid from a SheetJS worksheet. Keeps sheet geometry; drops rows and
// columns (e.g. the Legend block) that contain no plot cells.
export function gridFromSheet(XLSX, worksheet) {
  if (!worksheet || !worksheet['!ref']) return [];
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  const cells = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = worksheet[addr];
      row.push(parseCellText(cell ? (cell.w != null ? cell.w : cell.v) : null));
    }
    cells.push(row);
  }
  return trimGrid(cells);
}

// Drop fully-empty leading/trailing rows and columns.
export function trimGrid(cells) {
  if (!cells.length) return [];
  const nRows = cells.length, nCols = Math.max(...cells.map(r => r.length));
  const rowHas = cells.map(r => r.some(Boolean));
  const colHas = [];
  for (let c = 0; c < nCols; c++) colHas.push(cells.some(r => !!r[c]));
  const r0 = rowHas.indexOf(true), r1 = rowHas.lastIndexOf(true);
  const c0 = colHas.indexOf(true), c1 = colHas.lastIndexOf(true);
  if (r0 < 0 || c0 < 0) return [];
  const out = [];
  for (let r = r0; r <= r1; r++) {
    const row = [];
    for (let c = c0; c <= c1; c++) row.push(cells[r][c] || null);
    out.push(row);
  }
  return out;
}

// How many plot cells a sheet has — used to pick/flag the map tab.
export function countPlots(grid) {
  let n = 0;
  grid.forEach(r => r.forEach(c => { if (c && c.plot != null) n++; }));
  return n;
}

// ── Excel entry point ────────────────────────────────────────────────
// Returns { sheets: [{ name, grid, plots }] } so the caller can offer a picker.
export async function importSpreadsheet(file) {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellText: true });
  const sheets = wb.SheetNames.map(name => {
    const grid = gridFromSheet(XLSX, wb.Sheets[name]);
    return { name, grid, plots: countPlots(grid) };
  });
  return { sheets };
}

// ── PDF: build a grid from a plot→treatment map ──────────────────────
// ARM plots are numbered rep*100 + position, so rep = the leading digits.
// Row 0 is the highest rep, matching how ARM prints maps (rep 1 at the bottom).
export function gridFromPlotMap(plotTreatmentMap) {
  const plots = Object.keys(plotTreatmentMap).map(Number).filter(n => !isNaN(n));
  if (!plots.length) return [];
  const byRep = new Map();
  for (const plot of plots) {
    const rep = Math.floor(plot / 100);
    const pos = plot % 100;
    if (!byRep.has(rep)) byRep.set(rep, []);
    byRep.get(rep).push({ plot, pos, treatment: plotTreatmentMap[plot] ?? null, rep });
  }
  const reps = [...byRep.keys()].sort((a, b) => b - a); // highest rep first (top row)
  const width = Math.max(...[...byRep.values()].map(v => Math.max(...v.map(x => x.pos))));
  return reps.map(rep => {
    const row = Array(width).fill(null);
    byRep.get(rep).forEach(c => { if (c.pos >= 1) row[c.pos - 1] = { plot: c.plot, treatment: c.treatment, rep: c.rep }; });
    return row;
  });
}

// Pull plot→treatment out of the ARM plan table in a PDF text layer.
// items: [{ s, x, y }] — text with page coordinates.
export function plotMapFromPdfItems(items) {
  const isPlot = s => /^\d{3,4}$/.test(s) && +s >= 100;
  const isSmall = s => /^\d{1,3}$/.test(s);
  // Group plot tokens by their text baseline
  const rows = new Map();
  items.filter(i => isPlot(i.s)).forEach(i => {
    const key = Math.round(i.y);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(i);
  });
  const map = {};
  let matched = 0;
  for (const [y, plotItems] of rows) {
    if (plotItems.length < 2) continue;               // a table row lists several reps
    const minPlotX = Math.min(...plotItems.map(p => p.x));
    // treatment number = small number on the same line, left of the plot columns
    const trtTok = items
      .filter(i => Math.abs(i.y - y) <= 2 && isSmall(i.s) && i.x < minPlotX - 20)
      .sort((a, b) => a.x - b.x)[0];
    if (!trtTok) continue;
    const trt = parseInt(trtTok.s, 10);
    plotItems.forEach(p => { map[parseInt(p.s, 10)] = trt; });
    matched++;
  }
  return { plotTreatmentMap: map, rowsMatched: matched };
}

// ── PDF entry point ──────────────────────────────────────────────────
export async function importPdf(file) {
  const pdfjs = await import('pdfjs-dist');
  const workerSrc = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const all = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    tc.items.forEach(i => {
      const s = (i.str || '').trim();
      if (s) all.push({ s, x: Math.round(i.transform[4]), y: Math.round(i.transform[5]) });
    });
  }
  const { plotTreatmentMap, rowsMatched } = plotMapFromPdfItems(all);
  const grid = gridFromPlotMap(plotTreatmentMap);
  return { grid, plotTreatmentMap, rowsMatched, plots: countPlots(grid) };
}
