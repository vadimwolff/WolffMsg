/**
 * A small promise wrapper over IndexedDB.
 *
 * IndexedDB rather than localStorage for two reasons that matter here: it can
 * store structured-cloned `CryptoKey` objects (which is what makes a
 * non-extractable key usable at all), and it holds binary data without a
 * base64 round trip.
 */

const DB_NAME = 'wolffmsg';
const DB_VERSION = 2;

export const STORE_VAULT = 'vault';
export const STORE_MESSAGES = 'messages';
export const STORE_META = 'meta';
export const STORE_OUTBOX = 'outbox';
export const STORE_IDENTITIES = 'identities';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_VAULT)) {
        db.createObjectStore(STORE_VAULT);
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      if (!db.objectStoreNames.contains(STORE_IDENTITIES)) {
        db.createObjectStore(STORE_IDENTITIES);
      }
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const store = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
        store.createIndex('byChat', ['chatId', 'seq']);
        store.createIndex('byChatTime', ['chatId', 'createdAt']);
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const store = db.createObjectStore(STORE_OUTBOX, { keyPath: 'clientId' });
        store.createIndex('byChat', 'chatId');
        store.createIndex('byQueuedAt', 'queuedAt');
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgraded the schema; drop our handle so the next call
      // reopens rather than operating on a stale version.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
    request.onblocked = () =>
      reject(new Error('Close WolffMsg in your other tabs and reload'));
  });

  return dbPromise;
}

function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = work(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB error'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      }),
  );
}

/**
 * IndexedDB's own typings describe each request as returning a fixed shape, so
 * the generic result has to be asserted at the boundary. It is contained to
 * these four wrappers rather than spread across every call site.
 */
export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return run<T | undefined>(
    store,
    'readonly',
    (s) => s.get(key) as unknown as IDBRequest<T | undefined>,
  );
}

export function idbPut<T>(store: string, value: T, key?: IDBValidKey): Promise<void> {
  return run<void>(store, 'readwrite', (s) =>
    (key === undefined
      ? s.put(value)
      : s.put(value, key)) as unknown as IDBRequest<void>,
  );
}

export function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  return run<void>(
    store,
    'readwrite',
    (s) => s.delete(key) as unknown as IDBRequest<void>,
  );
}

export function idbClear(store: string): Promise<void> {
  return run<void>(store, 'readwrite', (s) => s.clear() as unknown as IDBRequest<void>);
}

export function idbGetAll<T>(
  store: string,
  query?: IDBKeyRange,
  count?: number,
): Promise<T[]> {
  return run<T[]>(store, 'readonly', (s) => s.getAll(query, count) as IDBRequest<T[]>);
}

/** Read from an index, newest first when `direction` is 'prev'. */
export function idbGetAllFromIndex<T>(
  store: string,
  indexName: string,
  query: IDBKeyRange | IDBValidKey | null,
  count?: number,
): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const index = tx.objectStore(store).index(indexName);
        const request = index.getAll(query, count) as IDBRequest<T[]>;
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB error'));
      }),
  );
}

/** Put many records in one transaction — used when backfilling history. */
export function idbPutMany<T>(store: string, values: T[]): Promise<void> {
  if (values.length === 0) return Promise.resolve();
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const objectStore = tx.objectStore(store);
        for (const value of values) objectStore.put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB error'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'));
      }),
  );
}

/**
 * Wipe every trace of the account from this device.
 *
 * Called on sign-out. Deleting the whole database is deliberate: a partial
 * clear risks leaving a decrypted message cache behind after the keys are gone.
 */
export async function destroyDb(): Promise<void> {
  const db = await openDb().catch(() => null);
  db?.close();
  dbPromise = null;

  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** Whether this browser can store anything at all (private mode can refuse). */
export async function storageAvailable(): Promise<boolean> {
  try {
    await openDb();
    return true;
  } catch {
    return false;
  }
}
