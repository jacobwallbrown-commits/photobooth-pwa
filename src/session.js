// ─── SESSION PERSISTENCE (IndexedDB) ───────────────────────────────
// Stores an in-progress shooting session so it survives app close / reload.
// Two stores:
//   meta  ("current")  -> lightweight session state (config, queue, index, notes, photo metadata)
//   blobs (by pid)     -> the actual photo image blobs, plus "mapImage" for the reference map
//
// Photos are persisted blob-by-blob (only new ones are written) so saving stays fast
// even for large sessions.

const DB_NAME = 'photobooth';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BLOB_STORE = 'blobs';
const META_KEY = 'current';
const MAP_BLOB_KEY = 'mapImage';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function makePid() {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Save the lightweight session metadata (overwrites "current").
export async function saveMeta(meta) {
  try {
    const db = await openDB();
    await reqToPromise(tx(db, META_STORE, 'readwrite').put(meta, META_KEY));
    return true;
  } catch (e) {
    console.warn('saveMeta failed', e);
    return false;
  }
}

// Persist a single photo blob by its pid.
export async function savePhotoBlob(pid, blob) {
  try {
    const db = await openDB();
    await reqToPromise(tx(db, BLOB_STORE, 'readwrite').put(blob, pid));
    return true;
  } catch (e) {
    console.warn('savePhotoBlob failed', e);
    return false;
  }
}

export async function saveMapBlob(blob) {
  try {
    const db = await openDB();
    await reqToPromise(tx(db, BLOB_STORE, 'readwrite').put(blob, MAP_BLOB_KEY));
    return true;
  } catch (e) {
    console.warn('saveMapBlob failed', e);
    return false;
  }
}

// Read just the metadata (for the Home "Resume" card). No blobs loaded.
export async function peekSession() {
  try {
    const db = await openDB();
    const meta = await reqToPromise(tx(db, META_STORE, 'readonly').get(META_KEY));
    if (!meta || !meta.photos) return null;
    return meta;
  } catch (e) {
    return null;
  }
}

// Fully load the session, hydrating photo blobs into File objects + object URLs.
export async function loadSession() {
  try {
    const db = await openDB();
    const meta = await reqToPromise(tx(db, META_STORE, 'readonly').get(META_KEY));
    if (!meta) return null;

    const photos = [];
    for (const pm of (meta.photos || [])) {
      const blob = await reqToPromise(tx(db, BLOB_STORE, 'readonly').get(pm.pid));
      if (!blob) continue;
      const file = new File([blob], pm.fileName, { type: blob.type || 'image/jpeg' });
      photos.push({ ...pm, file, url: URL.createObjectURL(file) });
    }

    let mapImage = null;
    if (meta.hasMap) {
      const mblob = await reqToPromise(tx(db, BLOB_STORE, 'readonly').get(MAP_BLOB_KEY));
      if (mblob) {
        const mfile = new File([mblob], 'trial-map', { type: mblob.type || 'image/jpeg' });
        mapImage = { file: mfile, url: URL.createObjectURL(mfile) };
      }
    }

    return { meta, photos, mapImage };
  } catch (e) {
    console.warn('loadSession failed', e);
    return null;
  }
}

export async function clearSession() {
  try {
    const db = await openDB();
    await reqToPromise(tx(db, META_STORE, 'readwrite').clear());
    await reqToPromise(tx(db, BLOB_STORE, 'readwrite').clear());
    return true;
  } catch (e) {
    console.warn('clearSession failed', e);
    return false;
  }
}
