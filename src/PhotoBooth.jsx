import React, { useState, useCallback, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import { buildShootingQueue, parseARMText, parseManualEntry } from './utils';

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').replace(/_{2,}/g, '_').trim() || 'Trial';
}

const STEPS = {
  HOME: 'home', TRIAL: 'trial', REPS: 'reps', TREATMENTS: 'treatments',
  SELECT_REPS: 'selectReps', FRONT_BACK: 'frontBack', DIRECTIONS: 'directions',
  ARM_IMPORT: 'armImport', SAVE_SETUP: 'saveSetup', SHOOTING: 'shooting',
  REVIEW: 'review', COMPLETE: 'complete',
};

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

function MapView({ config, photos, shootingQueue, onClose, onPlotTap, mapSidePick, onSidePick, onCancelSidePick }) {
  const allReps = Array.from({ length: config.totalReps }, (_, i) => i + 1);
  const photographedKeys = new Set(photos.map(p => `${p.rep}-${p.plot}`));
  const queueKeys = new Set(shootingQueue.map(s => `${s.rep}-${s.plot}`));

  return (
    <div className="map-overlay" onClick={onClose}>
      <div className="map-modal" onClick={(e) => e.stopPropagation()}>
        <div className="map-header">
          <h3 className="map-title">Trial Map</h3>
          <button className="map-close" onClick={onClose} aria-label="Close map">✕</button>
        </div>
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
                    const taken = photographedKeys.has(`${rep}-${plot}`);
                    const queued = queueKeys.has(`${rep}-${plot}`);
                    return (
                      <button
                        key={plot}
                        className={`map-plot ${taken ? 'taken' : ''} ${queued && !taken ? 'queued' : ''}`}
                        onClick={() => onPlotTap(rep, plot)}
                      >
                        <div className="map-plot-num">{plot}</div>
                        {trt != null && <div className="map-plot-trt">T{trt}</div>}
                        {taken && <div className="map-plot-check">✓</div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {mapSidePick && (
          <div className="map-side-overlay" onClick={onCancelSidePick}>
            <div className="map-side-modal" onClick={(e) => e.stopPropagation()}>
              <h3 className="title" style={{ fontSize: 20, marginBottom: 6 }}>Plot {mapSidePick.plot}</h3>
              <p className="subtitle" style={{ marginBottom: 20 }}>Front or Back?</p>
              <button className="btn-primary" style={{ marginBottom: 10 }} onClick={() => onSidePick('Front')}>Front</button>
              <button className="btn-warning" onClick={() => onSidePick('Back')}>Back</button>
              <button className="btn-secondary" style={{ marginTop: 10 }} onClick={onCancelSidePick}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MAIN APP COMPONENT ─────────────────────────────────────────────

export default function PhotoBooth() {
  const [step, setStep] = useState(STEPS.HOME);
  const [config, setConfig] = useState({
    trialNumber: '', totalReps: 3, totalTreatments: 10, selectedReps: [],
    needFrontBack: false, directions: {}, plotTreatmentMap: {}, armLoaded: false,
  });
  const [shootingQueue, setShootingQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [photos, setPhotos] = useState([]);
  const [skippedPlots, setSkippedPlots] = useState([]);
  const [notes, setNotes] = useState({});
  const [dirStep, setDirStep] = useState(0);
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [currentNote, setCurrentNote] = useState('');
  const [armText, setArmText] = useState('');
  const [armParseStatus, setArmParseStatus] = useState(null);
  const [retakeMode, setRetakeMode] = useState(false);
  const [savingProgress, setSavingProgress] = useState(null);
  const [showMap, setShowMap] = useState(false);
  const [mapShot, setMapShot] = useState(null);
  const [mapSidePick, setMapSidePick] = useState(null); // pending plot/rep awaiting side choice

  const fileInputRef = useRef(null);
  const armFileRef = useRef(null);

  const currentShot = shootingQueue[currentIndex];
  const progress = shootingQueue.length > 0 ? (currentIndex / shootingQueue.length) * 100 : 0;

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
      const label = currentShot.trtLabel
        ? `${currentShot.label}, ${currentShot.trtLabel}`
        : currentShot.label;
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
        file,
        url,
        fileName: mapShot.fileName,
        label: mapShot.label,
        rep: mapShot.rep,
        plot: mapShot.plot,
        side: mapShot.side,
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
      file,
      url,
      fileName: currentShot.fileName,
      label: currentShot.label,
      rep: currentShot.rep,
      plot: currentShot.plot,
      side: currentShot.side,
      treatment: currentShot.treatment,
      index: currentIndex,
    };

    if (retakeMode) {
      setPhotos(prev => prev.map(p => p.index === currentIndex ? newPhoto : p));
      setRetakeMode(false);
    } else {
      setPhotos(prev => [...prev, newPhoto]);
    }
    setShowNoteInput(true);
  }, [currentShot, currentIndex, retakeMode, mapShot]);

  // ─── MAP PHOTO ─────────────────────────────────────────────────────
  const startMapPhoto = useCallback((rep, plot, side = null) => {
    const trt = config.plotTreatmentMap[plot];
    const trtSuffix = trt != null ? `_Trt${trt}` : '';
    const sideSuffix = side ? `_${side}` : '';
    const fileName = `${sanitizeFileName(config.trialNumber)}_Rep${rep}_Plot${plot}${trtSuffix}${sideSuffix}.jpg`;
    const label = side ? `Plot ${plot} - ${side.toUpperCase()}` : `Plot ${plot}`;
    setMapShot({
      rep, plot, side, treatment: trt ?? null,
      fileName, label,
      trtLabel: trt != null ? `Treatment ${trt}` : null,
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }, [config.trialNumber, config.plotTreatmentMap]);

  const handleMapPlotTap = useCallback((rep, plot) => {
    if (config.needFrontBack) {
      setMapSidePick({ rep, plot });
    } else {
      startMapPhoto(rep, plot, null);
    }
  }, [config.needFrontBack, startMapPhoto]);

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

  const startShooting = () => {
    const queue = buildShootingQueue(config);
    setShootingQueue(queue);
    setCurrentIndex(0);
    setPhotos([]);
    setSkippedPlots([]);
    setNotes({});
    setShowNoteInput(false);
    setCurrentNote('');
    setRetakeMode(false);
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
        const rows = ['Plot,Rep,Treatment,Side,Note,FileName'];
        noteKeys.forEach(idx => {
          const shot = shootingQueue[parseInt(idx)];
          if (shot) {
            rows.push(`${shot.plot},${shot.rep},${shot.treatment || ''},${shot.side || ''},${JSON.stringify(notes[idx])},${shot.fileName}`);
          }
        });
        folder.file(`${safeTrial}_notes.csv`, rows.join('\n'));
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
    setStep(STEPS.HOME);
    setConfig({
      trialNumber: '', totalReps: 3, totalTreatments: 10, selectedReps: [],
      needFrontBack: false, directions: {}, plotTreatmentMap: {}, armLoaded: false,
    });
    setShootingQueue([]); setCurrentIndex(0); setPhotos([]); setSkippedPlots([]);
    setNotes({}); setDirStep(0); setShowNoteInput(false); setCurrentNote('');
    setArmText(''); setArmParseStatus(null); setRetakeMode(false); setSavingProgress(null);
  };

  const toggleRep = (rep) => {
    setConfig(prev => {
      const sel = prev.selectedReps.includes(rep)
        ? prev.selectedReps.filter(r => r !== rep)
        : [...prev.selectedReps, rep].sort((a, b) => a - b);
      return { ...prev, selectedReps: sel };
    });
  };

  // Hidden file input for camera
  const cameraInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      capture="environment"
      onChange={handlePhotoCapture}
      style={{ display: 'none' }}
    />
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
        <div className="card">
          <button className="btn-primary" onClick={() => setStep(STEPS.TRIAL)}>Manual Mode</button>
          <p className="hint">Configure trial &rarr; auto-label &rarr; shoot</p>
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
          <NavButtons onBack={() => setStep(STEPS.TREATMENTS)} onNext={() => setStep(STEPS.FRONT_BACK)}
            nextDisabled={config.selectedReps.length === 0} />
        </div>
      </div>
    );
  }

  if (step === STEPS.FRONT_BACK) {
    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Step 5 of 8</span>
          <h2 className="title">Front & Back?</h2>
          <p className="subtitle">Do you need front AND back photos of each plot?</p>
          <OptionButton selected={config.needFrontBack === true} title="Yes - Front & Back"
            desc="All fronts first, then backs (reversed)" onPress={() => setConfig({ ...config, needFrontBack: true })} />
          <OptionButton selected={config.needFrontBack === false} title="No - One photo per plot"
            desc="Single photo of each plot" onPress={() => setConfig({ ...config, needFrontBack: false })} />
          <NavButtons onBack={() => setStep(STEPS.SELECT_REPS)}
            onNext={() => { setDirStep(0); setStep(STEPS.DIRECTIONS); }} />
        </div>
      </div>
    );
  }

  if (step === STEPS.DIRECTIONS) {
    const cRep = config.selectedReps[dirStep];
    const cDir = config.directions[cRep];
    const rBase = cRep * 100;
    const setDir = d => setConfig(prev => ({ ...prev, directions: { ...prev.directions, [cRep]: d } }));
    const goNext = () => {
      if (!cDir) return;
      if (dirStep + 1 < config.selectedReps.length) setDirStep(dirStep + 1);
      else setStep(STEPS.ARM_IMPORT);
    };
    const goBack = () => { if (dirStep > 0) setDirStep(dirStep - 1); else setStep(STEPS.FRONT_BACK); };

    return (
      <div className="page">
        <div className="card">
          <span className="step-label">Step 6 of 8 - Rep {cRep} ({dirStep + 1}/{config.selectedReps.length})</span>
          <h2 className="title">Direction</h2>
          <p className="subtitle">Which way for Rep {cRep}?</p>
          <OptionButton selected={cDir === 'asc'} title="Left to Right"
            desc={`${rBase + 1} > ${rBase + 2} > ... > ${rBase + config.totalTreatments}`}
            onPress={() => setDir('asc')} />
          <OptionButton selected={cDir === 'desc'} title="Right to Left"
            desc={`${rBase + config.totalTreatments} > ... > ${rBase + 1}`}
            onPress={() => setDir('desc')} />
          <NavButtons onBack={goBack} onNext={goNext} nextDisabled={!cDir}
            nextLabel={dirStep + 1 < config.selectedReps.length ? 'Next Rep' : 'Next'} />
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
            onBack={() => { setDirStep(config.selectedReps.length - 1); setStep(STEPS.DIRECTIONS); }}
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
        <div className="card">
          <span className="step-label">Step 8 of 8</span>
          <h2 className="title">Ready to Shoot</h2>
          <p className="subtitle">Photos save in the app, then export as ZIP when done</p>
          <div className="summary-box">
            <span className="summary-label">Session Summary</span>
            <div className="summary-row"><span className="summary-key">Trial: </span><span>{config.trialNumber}</span></div>
            <div className="summary-row"><span className="summary-key">Reps: </span><span>{config.selectedReps.map(r => `Rep ${r}`).join(', ')}</span></div>
            <div className="summary-row"><span className="summary-key">Treatments: </span><span>{config.totalTreatments} per rep</span></div>
            <div className="summary-row"><span className="summary-key">Front/Back: </span><span>{config.needFrontBack ? 'Yes' : 'No'}</span></div>
            {mapC > 0 && <div className="summary-row"><span className="summary-key">ARM: </span><span>{mapC} plots mapped</span></div>}
            <p className="summary-total">📷 {totalPhotos} total photos</p>
          </div>
          <NavButtons onBack={() => setStep(STEPS.ARM_IMPORT)} onNext={startShooting}
            nextLabel="Start Shooting" nextClass="btn-success" />
        </div>
      </div>
    );
  }

  if (step === STEPS.SHOOTING && currentShot) {
    const isNewRep = currentIndex === 0 || shootingQueue[currentIndex - 1]?.rep !== currentShot.rep;
    const isBackStart = currentIndex > 0 && currentShot.side === 'Back' && shootingQueue[currentIndex - 1]?.side === 'Front';
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
              <span className="muted">Rep {currentShot.rep} - {repDone + 1}/{repTotal}</span>
              <button className="map-btn" onClick={() => setShowMap(true)} aria-label="Open trial map">🗺️</button>
            </div>
          </div>
          <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${progress}%` }} /></div>
        </div>

        <div className="shooting-center">
          {(isNewRep || isBackStart) && (
            <div className={`alert-banner ${isBackStart ? 'warning' : 'info'}`}>
              {isBackStart ? 'Now taking BACK photos (reversed)' : `Starting Rep ${currentShot.rep}`}
            </div>
          )}
          {retakeMode && <div className="alert-banner error">Retaking - replaces previous photo</div>}
          <h1 className="plot-label">Plot {currentShot.plot}</h1>
          {currentShot.side && (
            <div className={`side-badge ${currentShot.side === 'Front' ? 'front' : 'back'}`}>{currentShot.side}</div>
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
          mapSidePick={mapSidePick}
          onSidePick={(side) => {
            const { rep, plot } = mapSidePick;
            setMapSidePick(null);
            startMapPhoto(rep, plot, side);
          }}
          onCancelSidePick={() => setMapSidePick(null)}
        />
      )}
      </>
    );
  }

  if (step === STEPS.REVIEW) {
    const noteCount = Object.keys(notes).length;
    return (
      <div className="page" style={{ paddingTop: 60 }}>
        <div className="card wide" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <h2 className="title">Review & Export</h2>
          <p className="subtitle">
            {photos.length} photos{skippedPlots.length > 0 ? `, ${skippedPlots.length} skipped` : ''}
            {noteCount > 0 ? `, ${noteCount} notes` : ''}
          </p>

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
                  <div style={{ flex: 1 }}>
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
            <button className="btn-success" onClick={exportAllPhotos}>Export All to Files ({photos.length})</button>
          )}
          {!savingProgress && (
            <button className="btn-primary" style={{ marginTop: 12 }} onClick={() => setStep(STEPS.COMPLETE)}>Done</button>
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
