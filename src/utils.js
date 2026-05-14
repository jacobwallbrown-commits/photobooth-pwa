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
//   'serpentine_asc'  - rep 1 ascending, rep 2 descending, rep 3 ascending, ...
//   'serpentine_desc' - rep 1 descending, rep 2 ascending, rep 3 descending, ...
export function directionsFromPattern(pattern, selectedReps) {
  const dirs = {};
  const startAsc = pattern === 'serpentine_asc';
  selectedReps.forEach((rep, idx) => {
    const isAsc = (idx % 2 === 0) ? startAsc : !startAsc;
    dirs[rep] = isAsc ? 'asc' : 'desc';
  });
  return dirs;
}

// ─── SHOOTING QUEUE BUILDER ────────────────────────────────────────
export function buildShootingQueue(config) {
  const queue = [];
  const { trialNumber, selectedReps, totalTreatments, photosPerPlot, pattern, plotTreatmentMap } = config;
  const perPlot = Math.max(1, photosPerPlot || 1);
  const directions = directionsFromPattern(pattern, selectedReps);

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
