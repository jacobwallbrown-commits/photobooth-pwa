import React, { useState, useCallback, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { buildShootingQueue, buildQueueFromGrid, plotMapFromGrid, parseARMText, parseManualEntry } from './utils';
import { makePid, saveMeta, savePhotoBlob, saveMapBlob, peekSession, loadSession, clearSession } from './session';
import { scanTrialMap } from './ocr';
import { importSpreadsheet, importPdf } from './mapImport';

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').replace(/_{2,}/g, '_').trim() || 'Trial';
}

const STEPS = {
  HOME: 'home', HELP: 'help', TRIAL: 'trial', REPS: 'reps', TREATMENTS: 'treatments',
  SELECT_REPS: 'selectReps', PHOTOS_PER_PLOT: 'photosPerPlot', PATTERN: 'pattern',
  CUSTOM_DIR: 'customDir', ARM_IMPORT: 'armImport', SAVE_SETUP: 'saveSetup',
  MAP_TRIAL: 'mapTrial', MAP_SCAN: 'mapScan', MAP_SHEET: 'mapSheet', MAP_GRID: 'mapGrid',
  SHOOTING: 'shooting', REVIEW: 'review', COMPLETE: 'complete',
};

const CORNERS = [
  { key: 'TL', label: '↖ Top-left' },
  { key: 'TR', label: '↗ Top-right' },
  { key: 'BL', label: '↙ Bottom-left' },
  { key: 'BR', label: '↘ Bottom-right' },
];

const PATTERN_LABELS = {
  serpentine_asc: 'Serpentine (start asc)',
  serpentine_desc: 'Serpentine (start desc)',
  all_asc: 'All ascending',
  all_desc: 'All descending',
  custom: 'Custom per rep',
};

// Full-screen zoomable image viewer
function ImageZoom({ url, onClose }) {
  return (
    <div className="zoom-overlay" onClick={onClose}>
      <button className="zoom-close" onClick={onClose} aria-label="Close">✕</button>
      <img src={url} className="zoom-img" alt="Trial map" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

// ─── SUB-COMPONENTS ─────────────────────────────────────────────────

function NumberStepper({ value, onChange }) {
  return (
    <div className="stepper-row">
      <button className="stepper-btn" onClick={() => onChange(Math.max(1, value - 1))}>-</button>
      <span className="stepper-value">{value}</span>
      <button className="stepper-btn" onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

function OptionButton({ selected, title, desc, onPress }) {
  return (
    <button className={selected ? 'option-btn selected' : 'option-btn'} onClick={onPress}>
      <span className="option-title">{title}</span>
      {desc && <span className="option-desc">{desc}</span>}
    </button>
  );
}

function NavButtons({ onBack, onNext, nextLabel, nextDisabled, nextClass }) {
  return (
    <div className="row">
      <button className="btn-secondary flex1" onClick={onBack}>Back</button>
      <button
        className={`${nextClass || 'btn-primary'} flex1`}
        disabled={nextDisabled}
        onClick={() => !nextDisabled && onNext()}
      >
        {nextLabel || 'Next'}
      </button>
    </div>
  );
}

function MapView({ config, photos, shootingQueue, onClose, onPlotTap, mapImage, onAttachMap, onViewMap }) {
  const allReps = Array.from({ length: config.totalReps }, (_, i) => i + 1);
  // Count photos per plot for badge
  const countByPlot = photos.reduce((acc, p) => {
    acc[p.plot] = (acc[p.plot] || 0) + 1;
    return acc;
  }, {});
  const queueKeys = new Set(shootingQueue.map(s => `${s.rep}-${s.plot}`));

  // ── Map-mode: render the scanned grid layout instead of rep rows ──
  if (config.mode === 'map' && config.mapGrid) {
    return (
      <div className="map-overlay" onClick={onClose}>
        <div className="map-modal" onClick={(e) => e.stopPropagation()}>
          <div className="map-header">
            <h3 className="map-title">Trial Map</h3>
            <button className="map-close" onClick={onClose} aria-label="Close map">✕</button>
          </div>
          {mapImage && (
            <div className="map-ref-row">
              <img src={mapImage.url} className="map-ref-thumb" alt="Trial map reference" onClick={onViewMap} />
              <div style={{ flex: 1 }}>
                <p className="map-ref-label">Your scanned map</p>
                <button className="link-blue" onClick={onViewMap}>Tap to view full screen</button>
              </div>
            </div>
          )}
          <p className="map-hint">Tap any plot to take an extra photo. Green = photographed.</p>
          <div className="map-grid-scroll">
            <div className="edit-grid" style={{ gridTemplateColumns: `repeat(${config.mapGrid[0]?.length || 1}, 58px)` }}>
              {config.mapGrid.map((row, r) => row.map((cell, c) => {
                if (!cell || cell.plot == null) return <div key={`${r}-${c}`} className="edit-cell empty" />;
                const count = countByPlot[cell.plot] || 0;
                return (
                  <button key={`${r}-${c}`} className={`edit-cell ${count > 0 ? 'taken' : ''}`} onClick={() => onPlotTap(null, cell.plot)}>
                    <span className="ec-plot">{cell.plot}</span>
                    <span className="ec-trt">{count > 0 ? (count > 1 ? `×${count}` : '✓') : (cell.treatment != null ? `T${cell.treatment}` : '')}</span>
                  </button>
                );
              }))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="map-overlay" onClick={onClose}>
      <div className="map-modal" onClick={(e) => e.stopPropagation()}>
        <div className="map-header">
          <h3 className="map-title">Trial Map</h3>
          <button className="map-close" onClick={onClose} aria-label="Close map">✕</button>
        </div>

        {mapImage ? (
          <div className="map-ref-row">
            <img src={mapImage.url} className="map-ref-thumb" alt="Trial map reference" onClick={onViewMap} />
            <div style={{ flex: 1 }}>
              <p className="map-ref-label">Your trial map</p>
              <button className="link-blue" onClick={onViewMap}>Tap to view full screen</button>
              <button className="link-blue" onClick={onAttachMap} style={{ marginTop: 4 }}>Replace</button>
            </div>
          </div>
        ) : (
          <button className="btn-secondary" style={{ marginBottom: 12, paddingBlock: 12 }} onClick={onAttachMap}>
            📎 Attach trial map photo
          </button>
        )}

        <p className="map-hint">Tap any plot to take an extra photo. Green = photographed, blue outline = in queue.</p>

        <div className="map-grid-scroll">
          {allReps.map(rep => {
            const inQueue = config.selectedReps.includes(rep);
            const rBase = rep * 100;
            return (
              <div key={rep} className="map-rep-row">
                <div className={`map-rep-label ${inQueue ? '' : 'map-rep-outside'}`}>
                  Rep {rep}{!inQueue && ' (outside queue)'}
                </div>
                <div className="map-plot-grid">
                  {Array.from({ length: config.totalTreatments }, (_, i) => {
                    const plot = rBase + i + 1;
                    const trt = config.plotTreatmentMap[plot];
                    const count = countByPlot[plot] || 0;
                    const taken = count > 0;
                    const queued = queueKeys.has(`${rep}-${plot}`);
                    return (
                      <button
                        key={plot}
                        className={`map-plot ${taken ? 'taken' : ''} ${queued && !taken ? 'queued' : ''}`}
                        onClick={() => onPlotTap(rep, plot)}
                      >
                        <div className="map-plot-num">{plot}</div>
                        {trt != null && <div className="map-plot-trt">T{trt}</div>}
                        {taken && <div className="map-plot-check">{count > 1 ? `×${count}` : '✓'}</div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP COMPONENT ─────────────────────────────────────────────

export default function PhotoBooth() {
  const [step, setStep] = useState(STEPS.HOME);
  const [config, setConfig] = useState({
    mode: 'manual',
    trialNumber: '', totalReps: 3, totalTreatments: 10, selectedReps: [],
    photosPerPlot: 1, pattern: 'serpentine_asc', customDirections: {}, plotTreatmentMap: {}, armLoaded: false,
    mapGrid: null, startCorner: 'TL', snake: true,
  });
  const [shootingQueue, setShootingQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [photos, setPhotos] = useState([]);
  const [skippedPlots, setSkippedPlots] = useState([]);
  const [notes, setNotes] = useState({});
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [currentNote, setCurrentNote] = useState('');
  const [armText, setArmText] = useState('');
  const [armParseStatus, setArmParseStatus] = useState(null);
  const [retakeMode, setRetakeMode] = useState(false);
  const [savingProgress, setSavingProgress] = useState(null);
  const [showMap, setShowMap] = useState(false);
  const [mapShot, setMapShot] = useState(null);
  const [mapImage, setMapImage] = useState(null);      // { file, url } reference trial-map photo
  const [viewMapZoom, setViewMapZoom] = useState(false);
  const [resumeInfo, setResumeInfo] = useState(null);  // summary of a saved session for the Home card
  const [startedAt, setStartedAt] = useState(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanStatus, setScanStatus] = useState(null);  // { ok, filled, total } after a scan
  const [editCell, setEditCell] = useState(null);      // { r, c } being edited in the grid
  const [sheetChoices, setSheetChoices] = useState(null); // Excel tabs awaiting a pick

  const fileInputRef = useRef(null);
  const armFileRef = useRef(null);
  const mapImageRef = useRef(null);
  const scanInputRef = useRef(null);
  const fileImportRef = useRef(null);
  const persistedPids = useRef(new Set());
  const sessionActive = useRef(false);

  const currentShot = shootingQueue[currentIndex];
  const progress = shootingQueue.length > 0 ? (currentIndex / shootingQueue.length) * 100 : 0;

  // ─── SESSION PERSISTENCE ────────────────────────────────────────────
  // On mount, check for a resumable session.
  useEffect(() => {
    peekSession().then(meta => {
      if (meta && meta.photos && meta.photos.length >= 0 && meta.config) {
        setResumeInfo({
          trialNumber: meta.config.trialNumber,
          photoCount: meta.photos.length,
          total: meta.totalShots ?? null,
          startedAt: meta.startedAt,
        });
      }
    });
  }, []);

  // Auto-save the session whenever key state changes during an active session.
  useEffect(() => {
    if (!sessionActive.current) return;
    if (step !== STEPS.SHOOTING && step !== STEPS.REVIEW) return;
    const t = setTimeout(async () => {
      // Persist any new photo blobs
      for (const p of photos) {
        if (p.pid && !persistedPids.current.has(p.pid)) {
          const ok = await savePhotoBlob(p.pid, p.file);
          if (ok) persistedPids.current.add(p.pid);
        }
      }
      // Persist lightweight meta
      const meta = {
        v: 1,
        config,
        shootingQueue,
        currentIndex,
        notes,
        skippedPlots,
        startedAt,
        totalShots: shootingQueue.length,
        hasMap: !!mapImage,
        photos: photos.map(p => ({
          pid: p.pid, fileName: p.fileName, label: p.label, rep: p.rep,
          plot: p.plot, photoNum: p.photoNum, treatment: p.treatment,
          index: p.index, fromMap: !!p.fromMap,
        })),
      };
      saveMeta(meta);
    }, 350);
    return () => clearTimeout(t);
  }, [step, config, shootingQueue, currentIndex, notes, skippedPlots, photos, mapImage, startedAt]);

  // ─── TTS ────────────────────────────────────────────────────────────
  const speak = useCallback((text) => {
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 1.0;
      speechSynthesis.speak(u);
    }
  }, []);

  useEffect(() => {
    if (step === STEPS.SHOOTING && currentShot && !showNoteInput && !retakeMode) {
      // Only announce on the first photo of a plot to avoid spam during multi-photo
      const isFirstOfPlot = currentShot.photoNum === 1 || currentShot.photoNum == null;
      if (!isFirstOfPlot) return;
      const label = currentShot.trtLabel
        ? `Plot ${currentShot.plot}, ${currentShot.trtLabel}`
        : `Plot ${currentShot.plot}`;
      const timer = setTimeout(() => speak(label), 300);
      return () => clearTimeout(timer);
    }
  }, [step, currentIndex, currentShot, showNoteInput, retakeMode, speak]);

  // ─── CAMERA (file input) ───────────────────────────────────────────
  const takePhoto = useCallback(() => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }, []);

  const handlePhotoCapture = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);

    // Map-tapped photo path
    if (mapShot) {
      const newPhoto = {
        pid: makePid(),
        file,
        url,
        fileName: mapShot.fileName,
        label: mapShot.label,
        rep: mapShot.rep,
        plot: mapShot.plot,
        photoNum: mapShot.photoNum,
        treatment: mapShot.treatment,
        index: `map-${Date.now()}`,
        fromMap: true,
      };
      setPhotos(prev => [...prev, newPhoto]);
      setMapShot(null);
      // Stay on map so they can take more
      return;
    }

    const newPhoto = {
      pid: makePid(),
      file,
      url,
      fileName: currentShot.fileName,
      label: currentShot.label,
      rep: currentShot.rep,
      plot: currentShot.plot,
      photoNum: currentShot.photoNum,
      treatment: currentShot.treatment,
      index: currentIndex,
    };

    if (retakeMode) {
      setPhotos(prev => prev.map(p => p.index === currentIndex ? newPhoto : p));
      setRetakeMode(false);
      setShowNoteInput(true);
    } else {
      setPhotos(prev => [...prev, newPhoto]);
      // Auto-advance for multi-photo: skip note input until last photo of plot
      const isLastOfPlot = currentShot.photoNum === currentShot.totalPhotos;
      if (isLastOfPlot) {
        setShowNoteInput(true);
      } else {
        // Auto-advance to next photo of same plot
        if (currentIndex + 1 < shootingQueue.length) {
          setCurrentIndex(prev => prev + 1);
        } else {
          setStep(STEPS.REVIEW);
        }
      }
    }
  }, [currentShot, currentIndex, retakeMode, mapShot, shootingQueue.length]);

  // ─── MAP PHOTO ─────────────────────────────────────────────────────
  // Each map tap takes one extra photo. Use highest existing photo number for that plot + 1.
  const handleMapPlotTap = useCallback((rep, plot) => {
    const trt = config.plotTreatmentMap[plot];
    const trtSuffix = trt != null ? `_Trt${trt}` : '';
    const safeTrial = sanitizeFileName(config.trialNumber);
    // Find highest existing photo number for this plot
    const existing = photos.filter(p => p.plot === plot);
    let nextNum = existing.length + 1;
    // Check uniqueness in case of retakes/skips
    const used = new Set(existing.map(p => p.photoNum).filter(n => n != null));
    while (used.has(nextNum)) nextNum++;
    const fileName = `${safeTrial}_Plot${plot}${trtSuffix}_${nextNum}.jpg`;
    setMapShot({
      rep, plot, treatment: trt ?? null,
      photoNum: nextNum,
      fileName,
      label: `Plot ${plot} — Extra ${nextNum}`,
      trtLabel: trt != null ? `Treatment ${trt}` : null,
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }, [config.trialNumber, config.plotTreatmentMap, photos]);

  // ─── REFERENCE MAP IMAGE ───────────────────────────────────────────
  const attachMapImage = useCallback(() => {
    if (mapImageRef.current) {
      mapImageRef.current.value = '';
      mapImageRef.current.click();
    }
  }, []);

  const handleMapImageSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMapImage(prev => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return { file, url: URL.createObjectURL(file) };
    });
    if (sessionActive.current) saveMapBlob(file);
  }, []);

  // ─── TRIAL-MAP SCAN (OCR) ──────────────────────────────────────────
  const pickScanImage = useCallback(() => {
    if (scanInputRef.current) { scanInputRef.current.value = ''; scanInputRef.current.click(); }
  }, []);

  const handleScanSelect = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Keep it as the reference image too
    setMapImage(prev => { if (prev?.url) URL.revokeObjectURL(prev.url); return { file, url: URL.createObjectURL(file) }; });
    setScanBusy(true);
    setScanProgress(0);
    setScanStatus(null);
    try {
      const res = await scanTrialMap(file, (p) => setScanProgress(p));
      if (!res.grid || res.grid.length === 0) {
        setScanStatus({ ok: false, message: "Couldn't read a grid. Try a clearer/closer image, or build it by hand." });
      } else {
        setConfig(prev => ({ ...prev, mapGrid: res.grid }));
        setScanStatus({ ok: true, filled: res.filled, total: res.total, anchored: res.anchored ?? res.filled, inferred: res.inferred || 0 });
        setStep(STEPS.MAP_GRID);
      }
    } catch (err) {
      console.error('scan error', err);
      setScanStatus({ ok: false, message: 'Scan failed. Try again or build the grid by hand.' });
    } finally {
      setScanBusy(false);
    }
  }, []);

  // ─── TRIAL-MAP FILE IMPORT (Excel / CSV / PDF) ─────────────────────
  const pickImportFile = useCallback(() => {
    if (fileImportRef.current) { fileImportRef.current.value = ''; fileImportRef.current.click(); }
  }, []);

  const handleFileImport = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanBusy(true); setScanProgress(0); setScanStatus(null); setSheetChoices(null);
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    try {
      if (isPdf) {
        const res = await importPdf(file);
        if (!res.grid.length) {
          setScanStatus({ ok: false, message: "No plot table found in that PDF. If it's a scanned image, use the photo scan instead." });
        } else {
          setConfig(prev => ({ ...prev, mapGrid: res.grid }));
          setScanStatus({ ok: true, filled: res.plots, total: res.plots, source: 'PDF' });
          setStep(STEPS.MAP_GRID);
        }
      } else {
        const { sheets } = await importSpreadsheet(file);
        const usable = sheets.filter(s => s.plots > 0).sort((a, b) => b.plots - a.plots);
        if (!usable.length) {
          setScanStatus({ ok: false, message: 'No plot grid found in that file. Expect cells like "907" over "8".' });
        } else if (usable.length === 1) {
          setConfig(prev => ({ ...prev, mapGrid: usable[0].grid }));
          setScanStatus({ ok: true, filled: usable[0].plots, total: usable[0].plots, source: 'Excel' });
          setStep(STEPS.MAP_GRID);
        } else {
          setSheetChoices(usable);       // let the user pick the tab
          setStep(STEPS.MAP_SHEET);
        }
      }
    } catch (err) {
      console.error('import error', err);
      setScanStatus({ ok: false, message: 'Could not read that file. Try Excel (.xlsx), CSV, or an ARM PDF.' });
    } finally {
      setScanBusy(false);
    }
  }, []);

  const chooseSheet = useCallback((sheet) => {
    setConfig(prev => ({ ...prev, mapGrid: sheet.grid }));
    setScanStatus({ ok: true, filled: sheet.plots, total: sheet.plots, source: `Excel · ${sheet.name}` });
    setSheetChoices(null);
    setStep(STEPS.MAP_GRID);
  }, []);

  // Grid editing helpers (map mode)
  const setGridCell = useCallback((r, c, patch) => {
    setConfig(prev => {
      const grid = prev.mapGrid.map(row => row.slice());
      const cur = grid[r][c] || { plot: null, treatment: null };
      const next = { ...cur, ...patch, inferred: false, trtUnsure: false };
      grid[r][c] = (next.plot == null && next.treatment == null) ? null : next;
      return { ...prev, mapGrid: grid };
    });
  }, []);

  const addGridRow = useCallback(() => setConfig(prev => {
    const cols = prev.mapGrid[0]?.length || 1;
    return { ...prev, mapGrid: [...prev.mapGrid, Array(cols).fill(null)] };
  }), []);
  const addGridCol = useCallback(() => setConfig(prev => ({
    ...prev, mapGrid: prev.mapGrid.map(row => [...row, null]),
  })), []);

  const startMapMode = useCallback(() => {
    setConfig({
      mode: 'map',
      trialNumber: '', totalReps: 3, totalTreatments: 10, selectedReps: [],
      photosPerPlot: 1, pattern: 'serpentine_asc', customDirections: {}, plotTreatmentMap: {}, armLoaded: false,
      mapGrid: null, startCorner: 'TL', snake: true,
    });
    setMapImage(null); setScanStatus(null); setScanProgress(0); setSheetChoices(null);
    setStep(STEPS.MAP_TRIAL);
  }, []);

  // ─── RESUME ─────────────────────────────────────────────────────────
  const resumeSession = useCallback(async () => {
    const data = await loadSession();
    if (!data || !data.meta) {
      setResumeInfo(null);
      return;
    }
    const { meta, photos: loadedPhotos, mapImage: loadedMap } = data;
    persistedPids.current = new Set(loadedPhotos.map(p => p.pid));
    setConfig(meta.config);
    setShootingQueue(meta.shootingQueue || []);
    setCurrentIndex(meta.currentIndex || 0);
    setNotes(meta.notes || {});
    setSkippedPlots(meta.skippedPlots || []);
    setStartedAt(meta.startedAt || Date.now());
    setPhotos(loadedPhotos);
    setMapImage(loadedMap);
    setShowNoteInput(false);
    setCurrentNote('');
    setRetakeMode(false);
    setResumeInfo(null);
    sessionActive.current = true;
    setStep(STEPS.SHOOTING);
  }, []);

  const discardSavedSession = useCallback(async () => {
    await clearSession();
    persistedPids.current = new Set();
    setResumeInfo(null);
  }, []);

  // ─── NAVIGATION ─────────────────────────────────────────────────────
  const advanceToNext = useCallback(() => {
    if (currentIndex + 1 < shootingQueue.length) {
      setCurrentIndex(prev => prev + 1);
      setShowNoteInput(false);
      setCurrentNote('');
      setRetakeMode(false);
    } else {
      setStep(STEPS.REVIEW);
    }
  }, [currentIndex, shootingQueue.length]);

  const saveNoteAndAdvance = () => {
    if (currentNote.trim()) {
      setNotes(prev => ({ ...prev, [currentIndex]: currentNote.trim() }));
    }
    advanceToNext();
  };

  const skipPlot = () => {
    setSkippedPlots(prev => [...prev, currentIndex]);
    advanceToNext();
  };

  const startShooting = async () => {
    let cfg = config;
    let queue;
    if (config.mode === 'map' && config.mapGrid) {
      // Derive the plot→treatment map from the grid so extra (map-tap) photos get treatment names too
      cfg = { ...config, plotTreatmentMap: plotMapFromGrid(config.mapGrid) };
      setConfig(cfg);
      queue = buildQueueFromGrid(cfg.trialNumber, cfg.mapGrid, {
        photosPerPlot: cfg.photosPerPlot, snake: cfg.snake, startCorner: cfg.startCorner,
      });
    } else {
      queue = buildShootingQueue(config);
    }
    // Fresh session: wipe any prior saved one
    await clearSession();
    persistedPids.current = new Set();
    if (mapImage) saveMapBlob(mapImage.file);
    setShootingQueue(queue);
    setCurrentIndex(0);
    setPhotos([]);
    setSkippedPlots([]);
    setNotes({});
    setShowNoteInput(false);
    setCurrentNote('');
    setRetakeMode(false);
    setStartedAt(Date.now());
    sessionActive.current = true;
    setStep(STEPS.SHOOTING);
  };

  // ─── EXPORT / SHARE ─────────────────────────────────────────────────
  const exportAllPhotos = async () => {
    const safeTrial = sanitizeFileName(config.trialNumber);
    try {
      setSavingProgress({ done: 0, total: photos.length + 1 });
      const zip = new JSZip();
      const folder = zip.folder(safeTrial);

      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        const arrayBuf = await photo.file.arrayBuffer();
        folder.file(photo.fileName, arrayBuf);
        setSavingProgress({ done: i + 1, total: photos.length + 1 });
      }

      const noteKeys = Object.keys(notes);
      if (noteKeys.length > 0) {
        const rows = ['Plot,Rep,Treatment,PhotoNum,Note,FileName'];
        noteKeys.forEach(idx => {
          const shot = shootingQueue[parseInt(idx)];
          if (shot) {
            rows.push(`${shot.plot},${shot.rep},${shot.treatment || ''},${shot.photoNum || ''},${JSON.stringify(notes[idx])},${shot.fileName}`);
          }
        });
        folder.file(`${safeTrial}_notes.csv`, rows.join('\n'));
      }

      // Include the reference trial-map photo if attached
      if (mapImage?.file) {
        const ext = (mapImage.file.type && mapImage.file.type.split('/')[1]) || 'jpg';
        const mapBuf = await mapImage.file.arrayBuffer();
        folder.file(`${safeTrial}_trial-map.${ext}`, mapBuf);
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      setSavingProgress({ done: photos.length + 1, total: photos.length + 1 });

      const zipFile = new File([blob], `${safeTrial}_photos.zip`, { type: 'application/zip' });

      if (navigator.canShare && navigator.canShare({ files: [zipFile] })) {
        await navigator.share({
          files: [zipFile],
          title: `${safeTrial} Photos`,
        });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeTrial}_photos.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      setSavingProgress(null);
      // Session exported successfully — it's safe to clear the saved copy
      sessionActive.current = false;
      await clearSession();
      persistedPids.current = new Set();
      setStep(STEPS.COMPLETE);
    } catch (e) {
      console.error('Export error:', e);
      setSavingProgress(null);
      if (e.name !== 'AbortError') {
        alert('Export error. Please try again.');
      }
    }
  };

  const shareOnePhoto = async (photo) => {
    try {
      const file = new File([photo.file], photo.fileName, { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
      }
    } catch (e) {
      if (e.name !== 'AbortError') alert('Could not share photo.');
    }
  };

  // ─── ARM PDF / MANUAL ──────────────────────────────────────────────
  const handleARMFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const mapping = parseARMText(text);
      const count = Object.keys(mapping).length;
      if (count > 0) {
        setConfig(prev => ({ ...prev, plotTreatmentMap: mapping, armLoaded: true }));
        setArmParseStatus({
          success: true,
          message: `Found ${count} plot-treatment mappings`,
          sample: Object.entries(mapping).slice(0, 6).map(([p, t]) => `Plot ${p} = Trt ${t}`).join(', '),
        });
      } else {
        setArmParseStatus({ success: false, message: 'Could not extract mappings. Use manual entry below.' });
      }
    } catch {
      setArmParseStatus({ success: false, message: 'Could not read file. Use manual entry below.' });
    }
  };

  const handleManualParse = () => {
    const mapping = parseManualEntry(armText);
    const count = Object.keys(mapping).length;
    if (count > 0) {
      setConfig(prev => ({ ...prev, plotTreatmentMap: mapping, armLoaded: true }));
      setArmParseStatus({
        success: true,
        message: `Parsed ${count} mappings`,
        sample: Object.entries(mapping).slice(0, 6).map(([p, t]) => `Plot ${p} = Trt ${t}`).join(', '),
      });
    } else {
      setArmParseStatus({ success: false, message: 'Could not parse. Check format.' });
    }
  };

  // ─── RESET ──────────────────────────────────────────────────────────
  const resetApp = () => {
    photos.forEach(p => { if (p.url) URL.revokeObjectURL(p.url); });
    if (mapImage?.url) URL.revokeObjectURL(mapImage.url);
    sessionActive.current = false;
    persistedPids.current = new Set();
    clearSession();
    setStep(STEPS.HOME);
    setConfig({
      mode: 'manual',
      trialNumber: '', totalReps: 3, totalTreatments: 10, selectedReps: [],
      photosPerPlot: 1, pattern: 'serpentine_asc', customDirections: {}, plotTreatmentMap: {}, armLoaded: false,
      mapGrid: null, startCorner: 'TL', snake: true,
    });
    setShootingQueue([]); setCurrentIndex(0); setPhotos([]); setSkippedPlots([]);
    setNotes({}); setShowNoteInput(false); setCurrentNote('');
    setArmText(''); setArmParseStatus(null); setRetakeMode(false); setSavingProgress(null);
    setMapImage(null); setStartedAt(null); setScanStatus(null); setScanBusy(false); setEditCell(null); setSheetChoices(null);
  };

  const toggleRep = (rep) => {
    setConfig(prev => {
      const sel = prev.selectedReps.includes(rep)
        ? prev.selectedReps.filter(r => r !== rep)
        : [...prev.selectedReps, rep].sort((a, b) => a - b);
      return { ...prev, selectedReps: sel };
    });
  };

  // Hidden file inputs: camera (capture) for plot photos, library/camera for the reference map
  const cameraInput = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handlePhotoCapture}
        style={{ display: 'none' }}
      />
      <input
        ref={mapImageRef}
        type="file"
        accept="image/*"
        onChange={handleMapImageSelect}
        style={{ display: 'none' }}
      />
      <input
        ref={scanInputRef}
        type="file"
        accept="image/*"
        onChange={handleScanSelect}
        style={{ display: 'none' }}
      />
      <input
        ref={fileImportRef}
        type="file"
        accept=".xlsx,.xls,.csv,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={handleFileImport}
        style={{ display: 'none' }}
      />
    </>
  );

  // ═══════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════

  if (step === STEPS.HOME) {
    return (
      <div className="page center">
        <div className="app-icon">📸</div>
        <h1 className="title-large">PhotoBooth</h1>
        <p className="subtitle" style={{ textAlign: 'center', marginBottom: 40 }}>Trial Photo Assistant</p>

        {resumeInfo && (
          <div className="card resume-card">
            <p className="resume-label">▶ Resume session</p>
            <p className="resume-trial">{resumeInfo.trialNumber || 'Untitled trial'}</p>
            <p className="resume-sub">
              {resumeInfo.photoCount}{resumeInfo.total ? ` of ${resumeInfo.total}` : ''} photos
              {resumeInfo.startedAt ? ` · started ${new Date(resumeInfo.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}
            </p>
            <button className="btn-success" style={{ marginTop: 14 }} onClick={resumeSession}>Resume</button>
            <button className="link-danger" style={{ marginTop: 12, alignSelf: 'center' }}
              onClick={() => { if (window.confirm('Discard the saved session? This cannot be undone.')) discardSavedSession(); }}>
              Discard saved session
            </button>
          </div>
        )}

        <div className="card">
          <button className="btn-success" onClick={startMapMode}>🗺️ Use Trial Map</button>
          <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => { setConfig(c => ({ ...c, mode: 'manual' })); setStep(STEPS.TRIAL); }}>Manual Mode</button>
          <button className="btn-secondary" style={{ marginTop: 12 }} onClick={() => setStep(STEPS.HELP)}>📖 How to Use</button>
          <p className="hint">Scan your map, or configure by hand &rarr; shoot</p>
        </div>
      </div>
    );
  }

  if (step === STEPS.HELP) {
    return (
      <div className="review-page">
        <div className="review-card">
          <h2 className="title">How to Use</h2>
          <p className="subtitle">From setup to saving your photos</p>
          <div className="review-list help-body">

            <div className="help-section">
              <h3 className="help-h">📲 First time: add to your home screen</h3>
              <p className="help-p">In Safari, tap the <b>Share</b> button, then <b>Add to Home Screen</b>. The app opens full-screen and works in the field even with no signal. Your photos are saved on the phone as you go.</p>
            </div>

            <div className="help-section">
              <h3 className="help-h">1 · Start a session</h3>
              <p className="help-p">Two ways in: <b>Use Trial Map</b> (load your real map so the order matches the field) or <b>Manual Mode</b> (set reps &amp; treatments by hand). If you left a session unfinished, a green <b>Resume</b> card appears — tap it to pick up exactly where you stopped.</p>
            </div>

            <div className="help-section help-highlight">
              <h3 className="help-h">🗺️ Use Trial Map (recommended)</h3>
              <p className="help-p">Name the trial, then load the map. Best to worst:</p>
              <p className="help-p"><b>Import Excel or ARM PDF</b> — reads the file's own data, so it's exact. An ARM trial-map workbook (cells with the plot over the treatment) or an ARM Spray/Seeding Plan PDF both work. If the workbook has several tabs you'll pick which one is the map.</p>
              <p className="help-p"><b>Scan a photo</b> — for when a picture is all you have. It reads what it can; anything it misses shows as a blank cell.</p>
              <p className="help-p"><b>Build by hand</b> — start from an empty grid.</p>
              <p className="help-p">Then <b>Check the Grid</b>: every plot with its treatment. Tap any cell to fix or fill it, add rows/columns, choose which corner you start from and whether you <b>snake</b> (alternate direction each row), set photos per plot, and go. Treatments are pulled in automatically, so file names include them — no separate ARM step needed.</p>
            </div>

            <div className="help-section">
              <h3 className="help-h">2 · Manual setup (8 quick steps)</h3>
              <p className="help-p">
                <b>Trial name</b> → <b>Number of reps</b> → <b>Treatments per rep</b> → <b>Select reps</b> to shoot →
                <b> Photos per plot</b> (1, 2, 3…) → <b>Walking pattern</b> (serpentine, all-ascending, all-descending, or custom per rep) →
                <b> ARM map</b> (optional — paste or upload a plot=treatment list so file names include the treatment) →
                <b> Ready to Shoot</b>.
              </p>
              <p className="help-p">On the last step you can also <b>attach a photo of your trial map</b> for reference (optional).</p>
            </div>

            <div className="help-section">
              <h3 className="help-h">3 · Take photos</h3>
              <p className="help-p">The big plot number and file name are shown. Tap <b>Take Photo</b> — your camera opens, snap the picture, and it auto-saves. If you set more than one photo per plot, it stays on the same plot until you've taken them all, then moves on.</p>
              <p className="help-p">The app reads each plot number aloud so you can keep your eyes on the field.</p>
            </div>

            <div className="help-section">
              <h3 className="help-h">4 · Notes, skip & retake</h3>
              <p className="help-p">After a plot's photos, you can add an optional <b>note</b>. Use <b>Skip Plot</b> if you're not shooting one, or <b>Retake This Photo</b> to redo the last shot.</p>
            </div>

            <div className="help-section">
              <h3 className="help-h">5 · Trial map button 🗺️</h3>
              <p className="help-p">Tap the map icon (top-right while shooting) to see every plot. <b>Tap any plot</b> — even one outside your selected reps — to grab an extra photo of it. Green plots are done; the count shows how many photos each has. Your attached map photo also appears here, tap to zoom.</p>
            </div>

            <div className="help-section">
              <h3 className="help-h">6 · Nothing gets lost</h3>
              <p className="help-p">Every photo is saved instantly on your phone. If the app closes, the screen locks, or you switch apps, just reopen PhotoBooth and tap <b>Resume</b>.</p>
            </div>

            <div className="help-section">
              <h3 className="help-h">7 · Review & check for gaps</h3>
              <p className="help-p">When you finish (or tap <b>Stop Early</b>), the Review screen lists every photo. If any plots were missed it shows a ⚠️ warning with the plot numbers and a <b>Back to shooting</b> link so you can fill them in.</p>
            </div>

            <div className="help-section help-highlight">
              <h3 className="help-h">8 · Save your photos ⭐</h3>
              <p className="help-p">Tap <b>Export All to Files</b>. The iOS share sheet opens — choose <b>Save to Files</b>, then pick the folder you want (e.g. iCloud Drive or On My iPhone) and tap <b>Save</b>.</p>
              <p className="help-p">You get one <b>.zip</b> file named after your trial. Inside is a folder with every photo (named by plot &amp; treatment), a <b>notes .csv</b>, and your trial-map photo if you attached one.</p>
              <p className="help-p"><b>To open the photos:</b> in the Files app, tap the .zip once — iOS unzips it into a folder next to it.</p>
            </div>

            <div className="help-section">
              <h3 className="help-h">Tip</h3>
              <p className="help-p">You can tap <b>Share</b> on any single photo in the Review list to send just that one.</p>
            </div>

          </div>
          <div className="review-buttons">
            <button className="btn-primary" onClick={() => setStep(STEPS.HOME)}>Back to Home</button>
          </div>
        </div>
      </div>
    );
  }

  // ─── MAP MODE: TRIAL NAME ──────────────────────────────────────────
  if (step === STEPS.MAP_TRIAL) {
    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Trial Map · Step 1 of 3</span>
          <h2 className="title">Trial Number</h2>
          <p className="subtitle">Enter a name or number for this trial</p>
          <input
            className="input"
            placeholder="e.g., CornTrial1"
            value={config.trialNumber}
            onChange={e => setConfig({ ...config, trialNumber: e.target.value })}
            autoFocus
          />
          <NavButtons
            onBack={() => setStep(STEPS.HOME)}
            onNext={() => setStep(STEPS.MAP_SCAN)}
            nextDisabled={!config.trialNumber.trim()}
          />
        </div>
      </div>
    );
  }

  // ─── MAP MODE: SCAN PHOTO ──────────────────────────────────────────
  if (step === STEPS.MAP_SCAN) {
    return (
      <div className="page">
        {cameraInput}
        {viewMapZoom && mapImage && <ImageZoom url={mapImage.url} onClose={() => setViewMapZoom(false)} />}
        <div className="card">
          <span className="step-label">Trial Map · Step 2 of 3</span>
          <h2 className="title">Load Your Map</h2>
          <p className="subtitle">Import the map so the shooting order matches your field.</p>

          {scanBusy ? (
            <div className="info-box info">
              <p style={{ textAlign: 'center', marginBottom: 10 }}>Reading map… {scanProgress > 0 ? `${Math.round(scanProgress * 100)}%` : ''}</p>
              <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${Math.max(8, Math.round(scanProgress * 100))}%` }} /></div>
            </div>
          ) : (
            <>
              <button className="btn-success" onClick={pickImportFile}>📄 Import Excel or ARM PDF</button>
              <p className="hint" style={{ marginTop: 8, marginBottom: 18 }}>Most accurate — reads the file's own data, no guessing.</p>

              {mapImage && (
                <img src={mapImage.url} className="scan-preview" alt="Trial map" onClick={() => setViewMapZoom(true)} />
              )}

              <button className="btn-secondary" onClick={pickScanImage}>{mapImage ? '📷 Choose a Different Photo' : '📷 Scan a Photo Instead'}</button>
              <p className="hint" style={{ marginTop: 8 }}>Use when a picture is all you have. A straight-on, well-lit shot reads best — you'll get to fix any misreads next.</p>

              {scanStatus && !scanStatus.ok && (
                <div className="info-box error" style={{ marginTop: 12 }}><p>{scanStatus.message}</p></div>
              )}

              <div className="row">
                <button className="btn-secondary flex1" onClick={() => setStep(STEPS.MAP_TRIAL)}>Back</button>
                <button className="btn-secondary flex1" onClick={() => {
                  // Build by hand: start with a small empty grid
                  setConfig(prev => ({ ...prev, mapGrid: [[null, null, null], [null, null, null]] }));
                  setStep(STEPS.MAP_GRID);
                }}>Build by Hand</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ─── MAP MODE: PICK A SHEET/TAB ────────────────────────────────────
  if (step === STEPS.MAP_SHEET && sheetChoices) {
    return (
      <div className="page">
        {cameraInput}
        <div className="card">
          <span className="step-label">Trial Map · Choose Tab</span>
          <h2 className="title">Which Tab?</h2>
          <p className="subtitle">That workbook has more than one sheet with plot numbers. Pick the trial map.</p>
          {sheetChoices.map(s => (
            <OptionButton
              key={s.name}
              selected={false}
              title={s.name}
              desc={`${s.plots} plot${s.plots === 1 ? '' : 's'} · ${s.grid.length} × ${s.grid[0]?.length || 0} grid`}
              onPress={() => chooseSheet(s)}
            />
          ))}
          <button className="btn-secondary" style={{ marginTop: 8 }} onClick={() => { setSheetChoices(null); setStep(STEPS.MAP_SCAN); }}>Back</button>
        </div>
      </div>
    );
  }

  // ─── MAP MODE: EDITABLE GRID ───────────────────────────────────────
  if (step === STEPS.MAP_GRID && config.mapGrid) {
    const grid = config.mapGrid;
    let filled = 0, cells = 0;
    grid.forEach(row => row.forEach(c => { cells++; if (c && c.plot != null) filled++; }));
    return (
      <div className="page">
        {editCell && (() => {
          const cur = grid[editCell.r]?.[editCell.c] || {};
          return (
            <div className="map-side-overlay" onClick={() => setEditCell(null)}>
              <div className="map-side-modal" onClick={(e) => e.stopPropagation()}>
                <h3 className="title" style={{ fontSize: 20, marginBottom: 12 }}>Edit cell</h3>
                <label className="cell-edit-label">Plot #</label>
                <input className="input" type="number" inputMode="numeric" placeholder="plot"
                  value={cur.plot ?? ''} autoFocus
                  onChange={e => setGridCell(editCell.r, editCell.c, { plot: e.target.value === '' ? null : parseInt(e.target.value) })} />
                <label className="cell-edit-label" style={{ marginTop: 12 }}>Treatment #</label>
                <input className="input" type="number" inputMode="numeric" placeholder="treatment"
                  value={cur.treatment ?? ''}
                  onChange={e => setGridCell(editCell.r, editCell.c, { treatment: e.target.value === '' ? null : parseInt(e.target.value) })} />
                <button className="btn-primary" style={{ marginTop: 16 }} onClick={() => setEditCell(null)}>Done</button>
                <button className="link-danger" style={{ marginTop: 12, alignSelf: 'center' }}
                  onClick={() => { setGridCell(editCell.r, editCell.c, { plot: null, treatment: null }); setEditCell(null); }}>Clear cell</button>
              </div>
            </div>
          );
        })()}

        <div className="card wide">
          <h2 className="title">Check the Grid</h2>
          <p className="subtitle">
            {scanStatus?.source ? `Imported from ${scanStatus.source}. ` : ''}
            {scanStatus?.inferred
              ? `${scanStatus.anchored} plot numbers read, ${scanStatus.inferred} filled in from the map's numbering (dashed) — give those a glance. `
              : `${filled} of ${cells} cells filled. `}
            Tap any cell to fix it. A "?" after a treatment means it was a low-confidence read. Empty cells are skipped.
          </p>

          <div className="grid-scroll">
            <div className="edit-grid" style={{ gridTemplateColumns: `repeat(${grid[0]?.length || 1}, 58px)` }}>
              {grid.map((row, r) => row.map((cell, c) => (
                <button key={`${r}-${c}`}
                  className={`edit-cell ${cell && cell.plot != null ? '' : 'empty'} ${cell && cell.plot != null && cell.treatment == null ? 'no-trt' : ''} ${cell?.inferred ? 'inferred' : ''}`}
                  onClick={() => setEditCell({ r, c })}>
                  <span className="ec-plot">{cell?.plot ?? '+'}</span>
                  <span className={`ec-trt ${cell?.trtUnsure ? 'unsure' : ''}`}>{cell?.treatment != null ? `T${cell.treatment}${cell.trtUnsure ? '?' : ''}` : (cell?.plot != null ? 'T?' : '')}</span>
                </button>
              )))}
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn-secondary flex1" onClick={addGridRow}>+ Row</button>
            <button className="btn-secondary flex1" onClick={addGridCol}>+ Column</button>
          </div>

          <div className="summary-box" style={{ marginTop: 16 }}>
            <span className="summary-label">Walking order</span>
            <div className="corner-grid">
              {CORNERS.map(cn => (
                <button key={cn.key} className={config.startCorner === cn.key ? 'cd-btn sel' : 'cd-btn'}
                  onClick={() => setConfig({ ...config, startCorner: cn.key })}>{cn.label}</button>
              ))}
            </div>
            <button className={config.snake ? 'toggle-row on' : 'toggle-row'} onClick={() => setConfig({ ...config, snake: !config.snake })}>
              <span>Snake (alternate direction each row)</span>
              <span className="toggle-pill">{config.snake ? 'ON' : 'OFF'}</span>
            </button>
          </div>

          <div className="summary-box">
            <span className="summary-label">Photos per plot</span>
            <NumberStepper value={config.photosPerPlot} onChange={v => setConfig({ ...config, photosPerPlot: v })} />
          </div>

          <div className="review-buttons">
            <button className="btn-success" onClick={startShooting} disabled={filled === 0}>Start Shooting ({filled} plots)</button>
            <button className="btn-secondary" style={{ marginTop: 12 }} onClick={() => setStep(STEPS.MAP_SCAN)}>Back</button>
          </div>
        </div>
      </div>
    );
  }

  if (step === STEPS.TRIAL) {
    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Step 1 of 8</span>
          <h2 className="title">Trial Number</h2>
          <p className="subtitle">Enter a name or number for this trial</p>
          <input
            className="input"
            placeholder="e.g., CornTrial1"
            value={config.trialNumber}
            onChange={e => setConfig({ ...config, trialNumber: e.target.value })}
            autoFocus
          />
          <NavButtons
            onBack={() => setStep(STEPS.HOME)}
            onNext={() => setStep(STEPS.REPS)}
            nextDisabled={!config.trialNumber.trim()}
          />
        </div>
      </div>
    );
  }

  if (step === STEPS.REPS) {
    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Step 2 of 8</span>
          <h2 className="title">Number of Reps</h2>
          <p className="subtitle">How many reps in this trial?</p>
          <NumberStepper value={config.totalReps} onChange={v => setConfig({ ...config, totalReps: v })} />
          <NavButtons onBack={() => setStep(STEPS.TRIAL)} onNext={() => setStep(STEPS.TREATMENTS)} />
        </div>
      </div>
    );
  }

  if (step === STEPS.TREATMENTS) {
    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Step 3 of 8</span>
          <h2 className="title">Treatments per Rep</h2>
          <p className="subtitle">How many treatments in each rep?</p>
          <NumberStepper value={config.totalTreatments} onChange={v => setConfig({ ...config, totalTreatments: v })} />
          <NavButtons onBack={() => setStep(STEPS.REPS)} onNext={() => setStep(STEPS.SELECT_REPS)} />
        </div>
      </div>
    );
  }

  if (step === STEPS.SELECT_REPS) {
    const allReps = Array.from({ length: config.totalReps }, (_, i) => i + 1);
    const allSelected = config.selectedReps.length === config.totalReps;
    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Step 4 of 8</span>
          <h2 className="title">Select Reps</h2>
          <p className="subtitle">Which reps will you photograph?</p>
          <button className="btn-secondary" style={{ marginBottom: 14, paddingBlock: 12 }}
            onClick={() => setConfig({ ...config, selectedReps: allSelected ? [] : [...allReps] })}>
            {allSelected ? 'Deselect All' : 'Select All'}
          </button>
          <div className="rep-grid">
            {allReps.map(rep => {
              const sel = config.selectedReps.includes(rep);
              return (
                <button key={rep} className={sel ? 'rep-btn selected' : 'rep-btn'} onClick={() => toggleRep(rep)}>
                  Rep {rep}
                </button>
              );
            })}
          </div>
          <NavButtons onBack={() => setStep(STEPS.TREATMENTS)} onNext={() => setStep(STEPS.PHOTOS_PER_PLOT)}
            nextDisabled={config.selectedReps.length === 0} />
        </div>
      </div>
    );
  }

  if (step === STEPS.PHOTOS_PER_PLOT) {
    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Step 5 of 8</span>
          <h2 className="title">Photos per Plot</h2>
          <p className="subtitle">How many photos do you want to take of each plot?</p>
          <NumberStepper value={config.photosPerPlot} onChange={v => setConfig({ ...config, photosPerPlot: v })} />
          <NavButtons onBack={() => setStep(STEPS.SELECT_REPS)} onNext={() => setStep(STEPS.PATTERN)} />
        </div>
      </div>
    );
  }

  if (step === STEPS.PATTERN) {
    const firstRep = config.selectedReps[0] ?? 1;
    const lastTrt = config.totalTreatments;
    const ll = String(lastTrt).padStart(2, '0');
    const exAsc = `${firstRep}01 → ${firstRep}${ll}`;
    const exDesc = `${firstRep}${ll} → ${firstRep}01`;
    const goNextFromPattern = () => {
      if (config.pattern === 'custom') setStep(STEPS.CUSTOM_DIR);
      else setStep(STEPS.ARM_IMPORT);
    };
    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Step 6 of 8</span>
          <h2 className="title">Walking Pattern</h2>
          <p className="subtitle">How will you walk through the trial?</p>
          <OptionButton
            selected={config.pattern === 'serpentine_asc'}
            title="Serpentine — start ascending"
            desc={`Rep 1 ascending (${exAsc}), then each rep reverses`}
            onPress={() => setConfig({ ...config, pattern: 'serpentine_asc' })}
          />
          <OptionButton
            selected={config.pattern === 'serpentine_desc'}
            title="Serpentine — start descending"
            desc={`Rep 1 descending (${exDesc}), then each rep reverses`}
            onPress={() => setConfig({ ...config, pattern: 'serpentine_desc' })}
          />
          <OptionButton
            selected={config.pattern === 'all_asc'}
            title="All ascending"
            desc={`Every rep low → high (${exAsc})`}
            onPress={() => setConfig({ ...config, pattern: 'all_asc' })}
          />
          <OptionButton
            selected={config.pattern === 'all_desc'}
            title="All descending"
            desc={`Every rep high → low (${exDesc})`}
            onPress={() => setConfig({ ...config, pattern: 'all_desc' })}
          />
          <OptionButton
            selected={config.pattern === 'custom'}
            title="Custom (Advanced)"
            desc="Set the direction for each rep individually"
            onPress={() => setConfig({ ...config, pattern: 'custom' })}
          />
          <NavButtons
            onBack={() => setStep(STEPS.PHOTOS_PER_PLOT)}
            onNext={goNextFromPattern}
            nextDisabled={!config.pattern}
          />
        </div>
      </div>
    );
  }

  if (step === STEPS.CUSTOM_DIR) {
    const setRepDir = (rep, dir) => setConfig(prev => ({
      ...prev, customDirections: { ...prev.customDirections, [rep]: dir },
    }));
    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Step 6 of 8 — Custom</span>
          <h2 className="title">Direction per Rep</h2>
          <p className="subtitle">Set which way you'll walk each rep</p>
          <div className="custom-dir-list">
            {config.selectedReps.map(rep => {
              const dir = config.customDirections[rep] || 'asc';
              const rBase = rep * 100;
              const low = rBase + 1;
              const high = rBase + config.totalTreatments;
              return (
                <div key={rep} className="custom-dir-row">
                  <span className="custom-dir-rep">Rep {rep}</span>
                  <div className="custom-dir-toggle">
                    <button className={dir === 'asc' ? 'cd-btn sel' : 'cd-btn'} onClick={() => setRepDir(rep, 'asc')}>
                      {low} → {high}
                    </button>
                    <button className={dir === 'desc' ? 'cd-btn sel' : 'cd-btn'} onClick={() => setRepDir(rep, 'desc')}>
                      {high} → {low}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <NavButtons onBack={() => setStep(STEPS.PATTERN)} onNext={() => setStep(STEPS.ARM_IMPORT)} />
        </div>
      </div>
    );
  }

  if (step === STEPS.ARM_IMPORT) {
    const mapC = Object.keys(config.plotTreatmentMap).length;
    return (
      <div className="page">
        <div className="card wide">
          <span className="step-label">Step 7 of 8</span>
          <h2 className="title">ARM Treatment Map</h2>
          <p className="subtitle">Optional - map plots to treatments for file names</p>

          <div className="summary-box">
            <p style={{ fontWeight: 700, marginBottom: 12 }}>Upload ARM File</p>
            <input ref={armFileRef} type="file" accept=".pdf,.txt,.csv" onChange={handleARMFile} style={{ display: 'none' }} />
            <button className="btn-secondary" onClick={() => armFileRef.current?.click()}>Choose File</button>
          </div>

          <div className="summary-box">
            <p style={{ fontWeight: 700, marginBottom: 4 }}>Or Enter Manually</p>
            <p className="hint" style={{ marginBottom: 12 }}>Format: plot=treatment (e.g., 101=1, 102=9)</p>
            <textarea className="textarea" placeholder={'101=1, 102=9, 103=2\n201=5, 202=3'}
              value={armText} onChange={e => setArmText(e.target.value)} />
            <button className="btn-secondary" style={{ marginTop: 10, opacity: armText.trim() ? 1 : 0.4 }}
              onClick={() => armText.trim() && handleManualParse()}>Parse Manual Entry</button>
          </div>

          {armParseStatus && (
            <div className={`info-box ${armParseStatus.success ? 'success' : 'error'}`}>
              <p>{armParseStatus.success ? '+ ' : 'x '}{armParseStatus.message}</p>
              {armParseStatus.sample && <p className="mono" style={{ marginTop: 8 }}>{armParseStatus.sample}...</p>}
            </div>
          )}

          {mapC > 0 && (
            <div className="info-box info">
              <p>{mapC} mappings loaded</p>
              <button className="link-danger" onClick={() => {
                setConfig(p => ({ ...p, plotTreatmentMap: {}, armLoaded: false }));
                setArmParseStatus(null); setArmText('');
              }}>Clear mapping</button>
            </div>
          )}

          <NavButtons
            onBack={() => setStep(config.pattern === 'custom' ? STEPS.CUSTOM_DIR : STEPS.PATTERN)}
            onNext={() => setStep(STEPS.SAVE_SETUP)}
            nextLabel={mapC > 0 ? 'Next' : 'Skip - No Mapping'} />
        </div>
      </div>
    );
  }

  if (step === STEPS.SAVE_SETUP) {
    const totalPhotos = buildShootingQueue(config).length;
    const mapC = Object.keys(config.plotTreatmentMap).length;
    return (
      <div className="page">
        {cameraInput}
        {viewMapZoom && mapImage && <ImageZoom url={mapImage.url} onClose={() => setViewMapZoom(false)} />}
        <div className="card">
          <span className="step-label">Step 8 of 8</span>
          <h2 className="title">Ready to Shoot</h2>
          <p className="subtitle">Photos save in the app, then export as ZIP when done</p>
          <div className="summary-box">
            <span className="summary-label">Session Summary</span>
            <div className="summary-row"><span className="summary-key">Trial: </span><span>{config.trialNumber}</span></div>
            <div className="summary-row"><span className="summary-key">Reps: </span><span>{config.selectedReps.map(r => `Rep ${r}`).join(', ')}</span></div>
            <div className="summary-row"><span className="summary-key">Treatments: </span><span>{config.totalTreatments} per rep</span></div>
            <div className="summary-row"><span className="summary-key">Photos per plot: </span><span>{config.photosPerPlot}</span></div>
            <div className="summary-row"><span className="summary-key">Pattern: </span><span>{PATTERN_LABELS[config.pattern] || config.pattern}</span></div>
            {mapC > 0 && <div className="summary-row"><span className="summary-key">ARM: </span><span>{mapC} plots mapped</span></div>}
            <p className="summary-total">📷 {totalPhotos} total photos</p>
          </div>

          <div className="summary-box">
            <span className="summary-label">Trial Map (optional)</span>
            {mapImage ? (
              <div className="map-ref-row" style={{ marginTop: 8 }}>
                <img src={mapImage.url} className="map-ref-thumb" alt="Trial map" onClick={() => setViewMapZoom(true)} />
                <div style={{ flex: 1 }}>
                  <button className="link-blue" onClick={() => setViewMapZoom(true)}>View full screen</button>
                  <button className="link-blue" onClick={attachMapImage} style={{ marginTop: 4 }}>Replace</button>
                  <button className="link-danger" onClick={() => { if (mapImage.url) URL.revokeObjectURL(mapImage.url); setMapImage(null); }} style={{ marginTop: 4 }}>Remove</button>
                </div>
              </div>
            ) : (
              <button className="btn-secondary" style={{ marginTop: 8, paddingBlock: 12 }} onClick={attachMapImage}>
                📎 Attach a photo of your trial map
              </button>
            )}
          </div>

          <NavButtons onBack={() => setStep(STEPS.ARM_IMPORT)} onNext={startShooting}
            nextLabel="Start Shooting" nextClass="btn-success" />
        </div>
      </div>
    );
  }

  if (step === STEPS.SHOOTING && currentShot) {
    const mapMode = config.mode === 'map';
    const isNewRep = !mapMode && (currentIndex === 0 || shootingQueue[currentIndex - 1]?.rep !== currentShot.rep);
    const repDone = shootingQueue.slice(0, currentIndex).filter(s => s.rep === currentShot.rep).length;
    const repTotal = shootingQueue.filter(s => s.rep === currentShot.rep).length;

    if (showNoteInput) {
      return (
        <div className="page center">
          {cameraInput}
          <div className="card">
            <div className="alert-banner success">Photo saved</div>
            <h2 className="title" style={{ fontSize: 22 }}>Add Note?</h2>
            <p className="subtitle">{currentShot.label} {currentShot.trtLabel ? `(${currentShot.trtLabel})` : ''}</p>
            <textarea className="input" style={{ minHeight: 80 }} placeholder="Optional notes for this plot..."
              value={currentNote} onChange={e => setCurrentNote(e.target.value)} autoFocus />
            <button className="btn-primary" style={{ marginTop: 16 }} onClick={saveNoteAndAdvance}>
              {currentNote.trim() ? 'Save Note & Next' : 'Next - No Note'}
            </button>
            <button className="btn-danger" style={{ marginTop: 10 }}
              onClick={() => { setShowNoteInput(false); setRetakeMode(true); }}>Retake This Photo</button>
          </div>
        </div>
      );
    }

    return (
      <>
      <div className="shooting-page">
        {cameraInput}
        <div>
          <div className="shooting-topbar">
            <span className="muted">{currentIndex + 1} of {shootingQueue.length}</span>
            <div className="topbar-right">
              {!mapMode && <span className="muted">Rep {currentShot.rep} - {repDone + 1}/{repTotal}</span>}
              <button className="map-btn" onClick={() => setShowMap(true)} aria-label="Open trial map">🗺️</button>
            </div>
          </div>
          <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${progress}%` }} /></div>
        </div>

        <div className="shooting-center">
          {isNewRep && (
            <div className="alert-banner info">
              Starting Rep {currentShot.rep}
            </div>
          )}
          {retakeMode && <div className="alert-banner error">Retaking - replaces previous photo</div>}
          <h1 className="plot-label">Plot {currentShot.plot}</h1>
          {currentShot.totalPhotos > 1 && (
            <div className="photo-num-badge">Photo {currentShot.photoNum} of {currentShot.totalPhotos}</div>
          )}
          {currentShot.trtLabel && <div className="trt-badge">{currentShot.trtLabel}</div>}
          <p className="file-name">{currentShot.fileName}</p>
        </div>

        <div>
          <button className="btn-success big" onClick={takePhoto}>
            📷 {retakeMode ? 'Retake Photo' : 'Take Photo'}
          </button>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn-warning flex1" onClick={() => {
              if (window.confirm(`Skip Plot ${currentShot.plot}?`)) skipPlot();
            }}>Skip Plot</button>
            {retakeMode && (
              <button className="btn-secondary flex1" onClick={() => { setRetakeMode(false); setShowNoteInput(true); }}>
                Cancel Retake</button>
            )}
          </div>
          <button className="btn-secondary muted-text" style={{ marginTop: 10 }} onClick={() => {
            if (window.confirm('Stop shooting? Your taken photos will be kept.')) {
              photos.length > 0 ? setStep(STEPS.REVIEW) : setStep(STEPS.COMPLETE);
            }
          }}>Stop Early</button>
        </div>
      </div>
      {showMap && (
        <MapView
          config={config}
          photos={photos}
          shootingQueue={shootingQueue}
          onClose={() => setShowMap(false)}
          onPlotTap={handleMapPlotTap}
          mapImage={mapImage}
          onAttachMap={attachMapImage}
          onViewMap={() => setViewMapZoom(true)}
        />
      )}
      {viewMapZoom && mapImage && <ImageZoom url={mapImage.url} onClose={() => setViewMapZoom(false)} />}
      </>
    );
  }

  if (step === STEPS.REVIEW) {
    const noteCount = Object.keys(notes).length;
    // Completeness check: which queued plots have zero photos?
    const queuedPlots = [];
    const seenQ = new Set();
    shootingQueue.forEach(s => {
      const k = `${s.rep}-${s.plot}`;
      if (!seenQ.has(k)) { seenQ.add(k); queuedPlots.push({ rep: s.rep, plot: s.plot }); }
    });
    const photographedPlots = new Set(photos.map(p => `${p.rep}-${p.plot}`));
    const missingPlots = queuedPlots.filter(q => !photographedPlots.has(`${q.rep}-${q.plot}`));

    const finishSession = () => {
      sessionActive.current = false;
      clearSession();
      persistedPids.current = new Set();
      setStep(STEPS.COMPLETE);
    };

    return (
      <div className="review-page">
        <div className="review-card">
          <h2 className="title">Review & Export</h2>
          <p className="subtitle">
            {photos.length} photos{skippedPlots.length > 0 ? `, ${skippedPlots.length} skipped` : ''}
            {noteCount > 0 ? `, ${noteCount} notes` : ''}
          </p>

          {!savingProgress && missingPlots.length > 0 && (
            <div className="info-box error">
              <p>⚠️ {missingPlots.length} plot{missingPlots.length > 1 ? 's' : ''} with no photo</p>
              <p className="mono" style={{ marginTop: 6 }}>
                {missingPlots.slice(0, 30).map(m => m.plot).join(', ')}{missingPlots.length > 30 ? '…' : ''}
              </p>
              <button className="link-blue" style={{ marginTop: 8 }} onClick={() => setStep(STEPS.SHOOTING)}>
                ← Back to shooting
              </button>
            </div>
          )}
          {!savingProgress && missingPlots.length === 0 && queuedPlots.length > 0 && (
            <div className="info-box success">
              <p>✓ All {queuedPlots.length} plots photographed</p>
            </div>
          )}

          {savingProgress && (
            <div className="info-box info">
              <p style={{ textAlign: 'center', marginBottom: 10 }}>Saving {savingProgress.done} of {savingProgress.total}...</p>
              <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${Math.round((savingProgress.done / savingProgress.total) * 100)}%` }} /></div>
            </div>
          )}

          <div className="review-list">
            {photos.map((photo, i) => {
              const noteText = notes[photo.index];
              return (
                <div key={i} className="review-item" onClick={() => shareOnePhoto(photo)}>
                  <img src={photo.url} className="review-thumb" alt="" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className="review-label">{photo.label}</p>
                    {photo.treatment != null && <p className="review-trt">Treatment {photo.treatment}</p>}
                    <p className="review-filename">{photo.fileName}</p>
                    {noteText && <p className="review-note">📝 {noteText}</p>}
                  </div>
                  <span className="share-link">Share</span>
                </div>
              );
            })}
          </div>

          {!savingProgress && (
            <div className="review-buttons">
              <button className="btn-success" onClick={exportAllPhotos}>Export All to Files ({photos.length})</button>
              <button className="btn-primary" style={{ marginTop: 12 }} onClick={finishSession}>Done</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step === STEPS.COMPLETE) {
    const noteCount = Object.keys(notes).length;
    return (
      <div className="page center">
        <div className="check-circle">&#10003;</div>
        <h2 className="title" style={{ fontSize: 30, textAlign: 'center' }}>All Done!</h2>
        <p className="subtitle" style={{ textAlign: 'center' }}>
          {photos.length} photos for {config.trialNumber}
          {skippedPlots.length > 0 ? ` (${skippedPlots.length} skipped)` : ''}
        </p>
        {noteCount > 0 && <p style={{ color: '#fbbf24', textAlign: 'center' }}>📝 {noteCount} notes recorded</p>}
        <div className="card" style={{ marginTop: 40 }}>
          <button className="btn-primary" onClick={resetApp}>Start New Session</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page center">
      <div className="card">
        <h2 className="title" style={{ textAlign: 'center' }}>Oops</h2>
        <p className="subtitle" style={{ textAlign: 'center' }}>Something went wrong.</p>
        <button className="btn-primary" onClick={resetApp}>Go Home</button>
      </div>
    </div>
  );
}
