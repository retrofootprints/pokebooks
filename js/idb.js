// IndexedDB storage: encounters (the log) and editions_cache (network
// lookup results, kept forever so the same edition is never fetched twice).
window.App = window.App || {};

App.idb = (function () {
  const DB_NAME = "pt-book-encounters";
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains("encounters")) {
          const store = db.createObjectStore("encounters", { keyPath: "id", autoIncrement: true });
          store.createIndex("timestamp", "timestamp");
          store.createIndex("resolution_rung", "resolution_rung");
          store.createIndex("context", "context");
        }
        if (!db.objectStoreNames.contains("editions_cache")) {
          db.createObjectStore("editions_cache", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(storeName, mode) {
    const db = await open();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  async function addEncounter(record) {
    const store = await tx("encounters", "readwrite");
    return new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function updateEncounter(id, patch) {
    const store = await tx("encounters", "readwrite");
    return new Promise((resolve, reject) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) return reject(new Error("encounter not found: " + id));
        const updated = Object.assign({}, existing, patch);
        const putReq = store.put(updated);
        putReq.onsuccess = () => resolve(updated);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function getAllEncounters() {
    const store = await tx("encounters", "readonly");
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.timestamp - a.timestamp));
      req.onerror = () => reject(req.error);
    });
  }

  // Deletes are irreversible beyond the caller's in-memory undo buffer (see
  // js/main.js) — there is no server copy. Export stays the real backup.
  // One transaction for the whole batch, so a bulk delete is atomic: either
  // every id goes or none does.
  async function deleteEncounters(ids) {
    if (!ids || !ids.length) return 0;
    const store = await tx("encounters", "readwrite");
    return new Promise((resolve, reject) => {
      ids.forEach((id) => store.delete(id));
      store.transaction.oncomplete = () => resolve(ids.length);
      store.transaction.onerror = () => reject(store.transaction.error);
      store.transaction.onabort = () => reject(store.transaction.error);
    });
  }

  // Undo support: re-inserts whole records, preserving their original ids so
  // a restored encounter is the same row it was, not a copy. Uses put(), not
  // add(): the records carry an in-line key, and put upserts rather than
  // throwing ConstraintError if that id somehow exists again.
  async function restoreEncounters(records) {
    if (!records || !records.length) return 0;
    const store = await tx("encounters", "readwrite");
    return new Promise((resolve, reject) => {
      records.forEach((r) => store.put(r));
      store.transaction.oncomplete = () => resolve(records.length);
      store.transaction.onerror = () => reject(store.transaction.error);
      store.transaction.onabort = () => reject(store.transaction.error);
    });
  }

  async function getEncounter(id) {
    const store = await tx("encounters", "readonly");
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function cacheGet(key) {
    const store = await tx("editions_cache", "readonly");
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function cachePut(key, edition, source) {
    const store = await tx("editions_cache", "readwrite");
    return new Promise((resolve, reject) => {
      const req = store.put({ key, edition, source, fetched_at: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- Export / Import ---
  // Photos are stored as blobs in IndexedDB but exported as base64 so the
  // whole log is a single portable JSON file (data safety requirement:
  // Safari can evict IndexedDB without warning).
  async function exportAll() {
    const encounters = await getAllEncounters();
    const out = [];
    for (const e of encounters) {
      const copy = Object.assign({}, e);
      if (copy.photo_blob instanceof Blob) {
        copy.photo_base64 = await App.util.blobToBase64(copy.photo_blob);
        delete copy.photo_blob;
      }
      if (copy.id_photo_blob instanceof Blob) {
        copy.id_photo_base64 = await App.util.blobToBase64(copy.id_photo_blob);
        delete copy.id_photo_blob;
      }
      out.push(copy);
    }
    return {
      exported_at: new Date().toISOString(),
      app: "pt-book-encounter-pilot",
      version: 1,
      encounters: out,
    };
  }

  async function importAll(data) {
    if (!data || !Array.isArray(data.encounters)) {
      throw new Error("Invalid export file: missing encounters array");
    }
    let imported = 0;
    for (const e of data.encounters) {
      const record = Object.assign({}, e);
      delete record.id; // let IndexedDB assign fresh ids, avoids collisions
      if (record.photo_base64) {
        record.photo_blob = await App.util.base64ToBlob(record.photo_base64);
        delete record.photo_base64;
      }
      if (record.id_photo_base64) {
        record.id_photo_blob = await App.util.base64ToBlob(record.id_photo_base64);
        delete record.id_photo_base64;
      }
      await addEncounter(record);
      imported++;
    }
    return imported;
  }

  return {
    open, addEncounter, updateEncounter, getAllEncounters, getEncounter,
    deleteEncounters, restoreEncounters,
    cacheGet, cachePut, exportAll, importAll,
  };
})();
