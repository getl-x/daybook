/**
 * 离线草稿队列（IndexedDB）。
 *
 * 为什么需要：自动保存失败（断网、服务重启）时，用户刚敲的字不能丢。
 * 草稿按 `userId + entryDate + field` 存；网络恢复后按修改时间顺序重放。
 *
 * 刻意不引第三方库：只用到 open/put/getAll/delete 四个操作。
 */
export interface DraftRecord {
  /** `${userId}:${entryDate}:${field}` */
  key: string;
  userId: string;
  entryDate: string;
  field: string;
  value: string;
  /** 客户端本地修改时间（重放排序用） */
  modifiedAt: number;
}

const DB_NAME = 'daybook';
const DB_VERSION = 1;
const STORE = 'drafts';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打不开 IndexedDB'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 操作失败'));
    });
  } finally {
    db.close();
  }
}

export function draftKey(userId: string, entryDate: string, field: string): string {
  return `${userId}:${entryDate}:${field}`;
}

export async function saveDraft(record: Omit<DraftRecord, 'key'>): Promise<void> {
  const key = draftKey(record.userId, record.entryDate, record.field);
  await withStore('readwrite', (store) => store.put({ ...record, key }));
}

export async function listDrafts(userId: string): Promise<DraftRecord[]> {
  const all = await withStore<DraftRecord[]>('readonly', (store) => store.getAll());
  return all.filter((draft) => draft.userId === userId).sort((a, b) => a.modifiedAt - b.modifiedAt);
}

export async function clearDraft(userId: string, entryDate: string, field: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(draftKey(userId, entryDate, field)));
}
