/** Local image history is independent of canvas sessions, so deleting a canvas
 * never silently removes a generated image. Images are stored as Blobs rather
 * than base64 strings to avoid expanding the IndexedDB payload. */
export type StudioGenerationKind = 'generate' | 'edit' | 'outpaint' | 'cutout'

export type StudioGeneration = {
  id: string
  createdAt: number
  sessionId: string
  sessionTitle: string
  kind: StudioGenerationKind
  prompt: string
  model: string
  connectionName: string
  channelGroup?: string
  width: number
  height: number
  image: Blob
}

export type StudioGenerationCursor = Pick<StudioGeneration, 'createdAt' | 'id'>

const DB_NAME = 'tokenbird-studio-generation-history'
const STORE_NAME = 'generations'
const ORDER_INDEX = 'by-created-at'
let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      store.createIndex(ORDER_INDEX, ['createdAt', 'id'])
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const ready = pending.catch(error => { database = undefined; throw error })
  database = ready
  return ready
}

export async function saveStudioGeneration(record: StudioGeneration): Promise<void> {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(record)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function listStudioGenerations(
  limit = 20,
  before?: StudioGenerationCursor,
): Promise<{ items: StudioGeneration[]; hasMore: boolean }> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const range = before ? IDBKeyRange.upperBound([before.createdAt, before.id], true) : undefined
    const request = transaction.objectStore(STORE_NAME).index(ORDER_INDEX).openCursor(range, 'prev')
    const items: StudioGeneration[] = []
    let hasMore = false
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      if (items.length >= limit) { hasMore = true; return }
      items.push(cursor.value as StudioGeneration)
      cursor.continue()
    }
    transaction.oncomplete = () => resolve({ items, hasMore })
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function deleteStudioGeneration(id: string): Promise<void> {
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
