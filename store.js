// Tiny IndexedDB layer. Book records and file blobs live in separate stores
// so the library can list books without loading whole PDFs.
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('folio', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function run(storeName, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, mode);
    const result = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const store = {
  allBooks: () => run('books', 'readonly', (s) => s.getAll()),
  getBook: (id) => run('books', 'readonly', (s) => s.get(id)),
  putBook: (book) => run('books', 'readwrite', (s) => s.put(book)),
  getFile: (id) => run('files', 'readonly', (s) => s.get(id)),
  putFile: (id, blob) => run('files', 'readwrite', (s) => s.put(blob, id)),
  async removeBook(id) {
    await run('books', 'readwrite', (s) => s.delete(id));
    await run('files', 'readwrite', (s) => s.delete(id));
  },
};

// PDFs shared into the app by the service worker.
export async function takeInbox() {
  const d = await new Promise((resolve, reject) => {
    const req = indexedDB.open('folio-inbox', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('inbox', { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return new Promise((resolve, reject) => {
    const tx = d.transaction('inbox', 'readwrite');
    const s = tx.objectStore('inbox');
    const req = s.getAll();
    req.onsuccess = () => s.clear();
    tx.oncomplete = () => resolve(req.result || []);
    tx.onerror = () => reject(tx.error);
  });
}

// Small debounced writer so frequent position updates don't hammer the database.
const pending = new Map();
export function saveSoon(book, delay = 400) {
  clearTimeout(pending.get(book.id));
  pending.set(book.id, setTimeout(() => {
    pending.delete(book.id);
    store.putBook(book).catch(() => {});
  }, delay));
}
export function flushSaves(book) {
  if (pending.has(book.id)) {
    clearTimeout(pending.get(book.id));
    pending.delete(book.id);
  }
  return store.putBook(book).catch(() => {});
}
