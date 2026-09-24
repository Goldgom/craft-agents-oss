export type StudioSessionMode = 'canvas' | 'mindmap'
export type StudioSessionMeta = { id: string; mode: StudioSessionMode; title: string; updatedAt: number }

const DB_NAME = 'tokenbird-studio-sessions'
const ACTIVE_PREFIX = 'tokenbird.studio.active.'
let database: Promise<IDBDatabase> | undefined
const writes = new Map<string, Promise<void>>()

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return database
}

async function transact<T>(storeName: 'meta' | 'data', mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const request = action(transaction.objectStore(storeName))
    let result: T
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function listStudioSessions(mode: StudioSessionMode): Promise<StudioSessionMeta[]> {
  const all = await transact<StudioSessionMeta[]>('meta', 'readonly', store => store.getAll())
  return all.filter(item => item.mode === mode).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadStudioSession(id: string): Promise<string> {
  return await transact<string | undefined>('data', 'readonly', store => store.get(id)) ?? ''
}

export async function putStudioSession(meta: StudioSessionMeta, data: string): Promise<void> {
  await transact('meta', 'readwrite', store => store.put(meta))
  await saveStudioSessionData(meta.id, data)
}

export function saveStudioSessionData(id: string, data: string): Promise<void> {
  const previous = writes.get(id) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => { await transact('data', 'readwrite', store => store.put(data, id)) })
  writes.set(id, next)
  void next.finally(() => { if (writes.get(id) === next) writes.delete(id) }).catch(() => {})
  return next
}

export async function updateStudioSessionMeta(meta: StudioSessionMeta): Promise<void> {
  await transact('meta', 'readwrite', store => store.put(meta))
}

export async function deleteStudioSession(id: string): Promise<void> {
  await (writes.get(id) ?? Promise.resolve()).catch(() => {})
  await transact('data', 'readwrite', store => store.delete(id))
  await transact('meta', 'readwrite', store => store.delete(id))
}

export function activeStudioSessionId(mode: StudioSessionMode): string {
  return localStorage.getItem(`${ACTIVE_PREFIX}${mode}`) ?? ''
}

export function setActiveStudioSessionId(mode: StudioSessionMode, id: string): void {
  localStorage.setItem(`${ACTIVE_PREFIX}${mode}`, id)
}
