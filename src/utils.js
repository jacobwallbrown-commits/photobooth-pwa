// ─── ARM PDF PARSING ───────────────────────────────────────────────
export function parseARMText(text) {
  const mapping = {};
  const lines = text.replace(/\r/g, '').replace(/\n+/g, '\n').split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    const trtMatch = trimmed.match(/^(\d{1,2})\s+/);
    if (!trtMatch) continue;
    const trtNum = parseInt(trtMatch[1]);
    if (trtNum < 1 || trtNum > 99) continue;
    const plotMatches = trimmed.match(/\b[1-9]\d{2}\b/g);
    if (!plotMatches || plotMatches.length < 2) continue;
    for (const plotStr of plotMatches) {
      const plotNum = parseInt(plotStr);
      if (plotNum >= 100 && plotNum <= 999) {
        mapping[plotNum] = trtNum;
      }
    }
  }
  return mapping;
}

export function parseManualEntry(text) {
  const mapping = {};
  const pairRegex = /(\d{3})\s*[=:→\-\>]+\s*(\d{1,2})/g;
  let m;
  while ((m = pairRegex.exec(text)) !== null) {
    mapping[parseInt(m[1])] = parseInt(m[2]);
  }
  if (Object.keys(mapping).length > 0) return mapping;

  const lines = text.trim().split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const plot = parseInt(parts[0]);
      const trt = parseInt(parts[1]);
      if (plot >= 100 && plot <= 999 && trt >= 1 && trt <= 99) {
        mapping[plot] = trt;
      }
    }
  }
  return mapping;
}

// ─── PATTERN -> DIRECTIONS PER REP ─────────────────────────────────
// pattern values:
//   'serpentine_asc'  - rep 1 ascending, rep 2 descending, alternating
//   'serpentine_desc' - rep 1 descending, rep 2 ascending, alternating
//   'all_asc'         - every rep ascending
//   'all_desc'        - every rep descending
//   'custom'          - per-rep directions supplied in customDirections {rep: 'asc'|'desc'}
export function directionsFromPattern(pattern, selectedReps, customDirections) {
  const dirs = {};
  if (pattern === 'all_asc') {
    selectedReps.forEach(rep => { dirs[rep] = 'asc'; });
    return dirs;
  }
  if (pattern === 'all_desc') {
    selectedReps.forEach(rep => { dirs[rep] = 'desc'; });
    return dirs;
  }
  if (pattern === 'custom') {
    selectedReps.forEach(rep => { dirs[rep] = (customDirections && customDirections[rep]) || 'asc'; });
    return dirs;
  }
  // serpentine
  const startAsc = pattern !== 'serpentine_desc';
  selectedReps.forEach((rep, idx) => {
    const isAsc = (idx % 2 === 0) ? startAsc : !startAsc;
    dirs[rep] = isAsc ? 'asc' : 'desc';
  });
  return dirs;
}

// ─── SHOOTING QUEUE BUILDER ────────────────────────────────────────
export function buildShootingQueue(config) {
  const queue = [];
  const { trialNumber, selectedReps, totalTreatments, photosPerPlot, pattern, plotTreatmentMap, customDirections } = config;
  const perPlot = Math.max(1, photosPerPlot || 1);
  const directions = directionsFromPattern(pattern, selectedReps, customDirections);

  for (let i = 0; i < selectedReps.length; i++) {
    const repNum = selectedReps[i];
    const dir = directions[repNum];
    const repBase = repNum * 100;

    const plots = [];
    if (dir === 'asc') {
      for (let t = 1; t <= totalTreatments; t++) plots.push(repBase + t);
    } else {
      for (let t = totalTreatments; t >= 1; t--) plots.push(repBase + t);
    }

    for (const plot of plots) {
      const trt = plotTreatmentMap[plot];
      const trtSuffix = trt != null ? `_Trt${trt}` : '';
      for (let n = 1; n <= perPlot; n++) {
        queue.push({
          rep: repNum,
          plot,
          treatment: trt ?? null,
          photoNum: n,
          totalPhotos: perPlot,
          fileName: `${trialNumber}_Plot${plot}${trtSuffix}_${n}.jpg`,
          label: perPlot > 1 ? `Plot ${plot} — Photo ${n} of ${perPlot}` : `Plot ${plot}`,
          trtLabel: trt != null ? `Treatment ${trt}` : null,
        });
      }
    }
  }
  return queue;
}

// ─── MAP-GRID QUEUE BUILDER ────────────────────────────────────────
// grid: 2D array [row][col] of cells; a cell is null/undefined (no plot)
//   or { plot: number, treatment: number|null }.
// options: { photosPerPlot, snake (default true), startCorner: 'TL'|'TR'|'BL'|'BR', firstAxis: 'row'|'col' }
// Walks the grid in physical field order so the queue matches the map.
export function buildQueueFromGrid(trialNumber, grid, options = {}) {
  const perPlot = Math.max(1, options.photosPerPlot || 1);
  const snake = options.snake !== false;
  const startCorner = options.startCorner || 'TL';
  const firstAxis = options.firstAxis || 'row'; // 'row' = walk rows (default), 'col' = walk columns

  const nRows = grid.length;
  const nCols = grid.reduce((m, r) => Math.max(m, r ? r.length : 0), 0);
  const startTop = startCorner === 'TL' || startCorner === 'TR';
  const startLeft = startCorner === 'TL' || startCorner === 'BL';

  const cellAt = (r, c) => (grid[r] && grid[r][c]) ? grid[r][c] : null;
  const order = [];

  if (firstAxis === 'row') {
    const rowSeq = startTop ? range(0, nRows) : range(nRows - 1, -1);
    rowSeq.forEach((r, i) => {
      let colSeq = startLeft ? range(0, nCols) : range(nCols - 1, -1);
      if (snake && i % 2 === 1) colSeq = colSeq.slice().reverse();
      colSeq.forEach(c => { const cell = cellAt(r, c); if (cell && cell.plot != null) order.push(cell); });
    });
  } else {
    const colSeq = startLeft ? range(0, nCols) : range(nCols - 1, -1);
    colSeq.forEach((c, i) => {
      let rowSeq = startTop ? range(0, nRows) : range(nRows - 1, -1);
      if (snake && i % 2 === 1) rowSeq = rowSeq.slice().reverse();
      rowSeq.forEach(r => { const cell = cellAt(r, c); if (cell && cell.plot != null) order.push(cell); });
    });
  }

  const queue = [];
  for (const cell of order) {
    const trt = cell.treatment;
    const trtSuffix = trt != null ? `_Trt${trt}` : '';
    for (let n = 1; n <= perPlot; n++) {
      queue.push({
        rep: cell.rep ?? null,
        plot: cell.plot,
        treatment: trt ?? null,
        photoNum: n,
        totalPhotos: perPlot,
        fileName: `${trialNumber}_Plot${cell.plot}${trtSuffix}_${n}.jpg`,
        label: perPlot > 1 ? `Plot ${cell.plot} — Photo ${n} of ${perPlot}` : `Plot ${cell.plot}`,
        trtLabel: trt != null ? `Treatment ${trt}` : null,
      });
    }
  }
  return queue;
}

function range(start, end) {
  // inclusive-exclusive when start<end; descending when end<start (end exclusive)
  const out = [];
  if (start <= end) { for (let i = start; i < end; i++) out.push(i); }
  else { for (let i = start; i > end; i--) out.push(i); }
  return out;
}

// Build a plot→treatment map from a grid (for filename labeling / ARM-free flow).
export function plotMapFromGrid(grid) {
  const map = {};
  (grid || []).forEach(row => (row || []).forEach(cell => {
    if (cell && cell.plot != null && cell.treatment != null) map[cell.plot] = cell.treatment;
  }));
  return map;
}
