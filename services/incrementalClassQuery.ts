import {
  collection,
  getCountFromServer,
  getDocs,
  getDocsFromCache,
  query,
  where,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { recordRead } from './readMeter';

/**
 * Class-scoped reads that lean on Firestore's persistent browser cache.
 *
 * The Class Dashboard used to re-read every entry of every selected class on
 * each open (~1,500 documents, billed as read units on Enterprise edition; see
 * ARCHITECTURE §48–49). An incremental load instead:
 *   1. asks the server only for documents whose `updatedAt` is newer than the
 *      last load (minus a clock-skew margin) — this also refreshes the cache;
 *   2. reads the full class set from the browser cache (no server reads);
 *   3. checks the cached count against a server count aggregation (about one
 *      read unit per class). A mismatch — a deletion, or the browser having
 *      evicted its storage — falls back to a full load, so a stale cache can
 *      never pass silently.
 *
 * Only for collections whose every write sets `updatedAt` (entries, page
 * records). feedbackHistory's uptake toggle does not, so it always loads in full.
 * Needs a (classId, updatedAt) index per collection.
 */

export type ClassLoadMode = 'full' | 'incremental';

/** Writes are stamped with the writer's clock; allow for skew between devices. */
const CLOCK_SKEW_MS = 10 * 60 * 1000;

const watermarkKey = (uid: string, collectionName: string, classId: string) =>
  `diary:fs-watermark:v1:${uid}:${collectionName}:${classId}`;

const readWatermark = (key: string): number | null => {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
};

const writeWatermark = (key: string, time: number) => {
  try {
    localStorage.setItem(key, String(time));
  } catch {
    // Storage unavailable: the next load is simply a full one.
  }
};

export interface ClassLoadResult {
  docs: DocumentData[];
  /** How this load was actually served; 'full' when an incremental attempt fell back. */
  servedAs: ClassLoadMode;
}

export const loadClassCollection = async (
  db: Firestore,
  uid: string,
  collectionName: 'entries' | 'pages',
  classId: string,
  mode: ClassLoadMode
): Promise<ClassLoadResult> => {
  const base = query(collection(db, 'users', uid, collectionName), where('classId', '==', classId));
  const key = watermarkKey(uid, collectionName, classId);
  const startedAt = Date.now();
  const watermark = mode === 'incremental' ? readWatermark(key) : null;

  if (watermark !== null) {
    try {
      const since = new Date(watermark - CLOCK_SKEW_MS).toISOString();
      const delta = await getDocs(query(base, where('updatedAt', '>', since)));
      const [cached, count] = await Promise.all([getDocsFromCache(base), getCountFromServer(base)]);
      recordRead(`${collectionName}:incremental`, delta.size + 1);
      if (cached.size === count.data().count) {
        writeWatermark(key, startedAt);
        return { docs: cached.docs.map((d) => d.data()), servedAs: 'incremental' };
      }
    } catch {
      // Cache unavailable or a transient error: fall through to a full load.
    }
  }

  const snapshot = await getDocs(base);
  recordRead(`${collectionName}:full`, snapshot.size);
  writeWatermark(key, startedAt);
  return { docs: snapshot.docs.map((d) => d.data()), servedAs: 'full' };
};
