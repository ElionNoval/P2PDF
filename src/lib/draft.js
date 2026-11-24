// Auto-saves the pages in the browser (IndexedDB) so closing the tab by mistake never loses a scan.
const DB = 'p2pdf', STORE = 'draft', KEY = 'current';

const open = () =>
  new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

export async function saveDraft(pages) {
  try {
    const db = await open();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      if (!pages.length) st.delete(KEY);
      else st.put(pages.map(({ url, ...rest }) => rest), KEY);
      tx.oncomplete = res;
      tx.onerror = tx.onabort = () => rej(tx.error);
    });
    db.close();
  } catch { /* storage unavailable (private mode, full disk): the app still works, it just cannot recover */ }
}

export async function loadDraft() {
  try {
    const db = await open();
    const list = await new Promise((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return Array.isArray(list) ? list.filter((p) => p && p.blob) : [];
  } catch { return []; }
}

export const clearDraft = () => saveDraft([]);
