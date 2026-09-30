import type { ScoreDocument } from '../types';
import { hydrateRenderedCursors } from './score-cursor-legacy';

export interface LibraryScore { id: string; document: ScoreDocument; addedAt: number; }
const DATABASE = 'suixian-library';
const STORE = 'scores';

function openLibrary(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('谱库暂时无法访问。'));
  });
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openLibrary();
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = operation(tx.objectStore(STORE));
    let value: T;
    request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => { database.close(); resolve(value); };
    tx.onerror = () => { database.close(); reject(tx.error); };
    tx.onabort = () => { database.close(); reject(tx.error); };
  });
}

export async function readLibrary(): Promise<LibraryScore[]> {
  const records = await transaction<LibraryScore[]>('readonly', store => store.getAll());
  return records.map(record => ({ ...record, document: hydrateRenderedCursors(record.document) })).sort((a, b) => b.addedAt - a.addedAt);
}

export async function saveLibraryScore(document: ScoreDocument, existing?: LibraryScore): Promise<LibraryScore> {
  const record = { id: existing?.id ?? crypto.randomUUID(), document, addedAt: existing?.addedAt ?? Date.now() };
  await transaction('readwrite', store => store.put(record));
  return record;
}

export async function removeLibraryScore(id: string): Promise<void> {
  await transaction('readwrite', store => store.delete(id));
}
