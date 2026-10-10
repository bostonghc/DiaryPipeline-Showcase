import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  runTransaction,
  updateDoc,
  where,
  writeBatch,
  Firestore,
  setDoc,
} from 'firebase/firestore';
import {
  SyncJob,
  SyncJobCounts,
  SyncJobItem,
  SyncJobItemStatus,
  SyncJobStatus,
} from '../types';
import { recordRead } from './readMeter';

const sanitizeId = (id: string): string => id.replace(/!/g, '__').replace(/[^a-zA-Z0-9_\-]/g, '_');

export const makeItemId = (classId: string, pageId: string): string =>
  `${sanitizeId(classId)}__${sanitizeId(pageId)}`;

const jobsCol = (uid: string) => `users/${uid}/syncJobs`;
const itemsCol = (uid: string, jobId: string) => `users/${uid}/syncJobs/${jobId}/items`;

export const sanitizeSyncJobItemWire = (
  item: SyncJobItem
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined)
  );

// How long a 'running' item is trusted before being reclaimed as stale.
const STALE_RUNNING_MS = 10 * 60 * 1000; // 10 minutes

export const createSyncJob = async (
  db: Firestore,
  uid: string,
  classId: string,
  classDisplayName: string
): Promise<SyncJob> => {
  const now = new Date().toISOString();
  const jobRef = doc(collection(db, jobsCol(uid)));
  const job: SyncJob = {
    jobId: jobRef.id,
    classId,
    classDisplayName,
    status: 'populating',
    counts: { total: 0, queued: 0, running: 0, done: 0, skipped: 0, error: 0, rate_limited: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(jobRef, job);
  return job;
};

// Write all items in 400-doc batches (under Firestore's 500-op limit) and
// update the job doc with final counts + status: 'running' in one final batch.
export const batchWriteJobItems = async (
  db: Firestore,
  uid: string,
  jobId: string,
  items: SyncJobItem[]
): Promise<void> => {
  const CHUNK = 400;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const batch = writeBatch(db);
    for (const item of chunk) {
      batch.set(
        doc(db, itemsCol(uid, jobId), item.itemId),
        sanitizeSyncJobItemWire(item),
        { merge: true }
      );
    }
    await batch.commit();
  }

  const counts: SyncJobCounts = {
    total: items.length,
    queued: items.filter(i => i.status === 'queued').length,
    running: 0,
    done: items.filter(i => i.status === 'done').length,
    skipped: items.filter(i => i.status === 'skipped').length,
    error: items.filter(i => i.status === 'error').length,
    rate_limited: items.filter(i => i.status === 'rate_limited').length,
  };

  await updateDoc(doc(db, jobsCol(uid), jobId), {
    counts,
    status: 'running' as SyncJobStatus,
    updatedAt: new Date().toISOString(),
  });
};

// Re-queue stale 'running' items — items claimed by a worker whose heartbeat
// is older than STALE_RUNNING_MS. Handles the browser-close case.
export const reclaimStaleRunningItems = async (
  db: Firestore,
  uid: string,
  jobId: string
): Promise<number> => {
  const staleThreshold = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const snap = await getDocs(
    query(collection(db, itemsCol(uid, jobId)), where('status', '==', 'running'), limit(100))
  );
  recordRead('syncJob:reclaim-scan', snap.size);
  const stale = snap.docs.filter(d => {
    const h = d.data().heartbeatAt as string | undefined;
    return !h || h < staleThreshold;
  });
  if (stale.length === 0) return 0;

  const now = new Date().toISOString();
  const batch = writeBatch(db);
  for (const d of stale) {
    batch.update(d.ref, {
      status: 'queued',
      runId: deleteField(),
      claimedAt: deleteField(),
      heartbeatAt: deleteField(),
      updatedAt: now,
    });
  }
  batch.update(doc(db, jobsCol(uid), jobId), {
    'counts.running': increment(-stale.length),
    'counts.queued': increment(stale.length),
    updatedAt: now,
  });
  await batch.commit();
  return stale.length;
};

// Re-queue 'rate_limited' items whose nextRetryAt window has passed.
// Calling this before listQueuedItems ensures retry-ready items are visible.
export const requeueRetryableRateLimitedItems = async (
  db: Firestore,
  uid: string,
  jobId: string
): Promise<number> => {
  const snap = await getDocs(
    query(collection(db, itemsCol(uid, jobId)), where('status', '==', 'rate_limited'), limit(200))
  );
  recordRead('syncJob:requeue-scan', snap.size);
  const retryable = snap.docs.filter(d => {
    const nextRetryAt = d.data().nextRetryAt as string | undefined;
    return !nextRetryAt || new Date(nextRetryAt).getTime() <= Date.now();
  });
  if (retryable.length === 0) return 0;

  const now = new Date().toISOString();
  const batch = writeBatch(db);
  for (const d of retryable) {
    batch.update(d.ref, { status: 'queued', nextRetryAt: deleteField(), updatedAt: now });
  }
  batch.update(doc(db, jobsCol(uid), jobId), {
    'counts.rate_limited': increment(-retryable.length),
    'counts.queued': increment(retryable.length),
    updatedAt: now,
  });
  await batch.commit();
  return retryable.length;
};

// Query all queued items for a job, ordered by creation time.
// 1000 covers typical class sizes; use multiple runs for very large jobs.
export const listQueuedItems = async (
  db: Firestore,
  uid: string,
  jobId: string
): Promise<SyncJobItem[]> => {
  const snap = await getDocs(
    query(
      collection(db, itemsCol(uid, jobId)),
      where('status', '==', 'queued'),
      orderBy('createdAt'),
      limit(1000)
    )
  );
  recordRead('syncJob:queued-list', snap.size);
  return snap.docs.map(d => d.data() as SyncJobItem);
};

// Claim an item with a transaction so two tabs cannot both claim the same item.
// Returns true if the claim succeeded, false if the item was already taken.
export const claimItem = async (
  db: Firestore,
  uid: string,
  jobId: string,
  itemId: string,
  runId: string
): Promise<boolean> => {
  const now = new Date().toISOString();
  const itemRef = doc(db, itemsCol(uid, jobId), itemId);
  const jobRef = doc(db, jobsCol(uid), jobId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(itemRef);
    recordRead('syncJob:claim-tx', 1);
    if (!snap.exists() || snap.data().status !== 'queued') return false;
    tx.update(itemRef, { status: 'running', runId, claimedAt: now, heartbeatAt: now, updatedAt: now });
    tx.update(jobRef, { 'counts.queued': increment(-1), 'counts.running': increment(1), updatedAt: now });
    return true;
  });
};

// Transition a running item to its terminal status and update job counts.
export const completeItem = async (
  db: Firestore,
  uid: string,
  jobId: string,
  itemId: string,
  newStatus: Exclude<SyncJobItemStatus, 'queued' | 'running'>,
  opts: { lastError?: string; nextRetryAt?: string } = {}
): Promise<void> => {
  const now = new Date().toISOString();
  const itemRef = doc(db, itemsCol(uid, jobId), itemId);
  const jobRef = doc(db, jobsCol(uid), jobId);

  const itemUpdate: Record<string, unknown> = { status: newStatus, updatedAt: now };
  if (opts.lastError !== undefined) itemUpdate.lastError = opts.lastError;
  if (opts.nextRetryAt !== undefined) itemUpdate.nextRetryAt = opts.nextRetryAt;

  const batch = writeBatch(db);
  batch.update(itemRef, itemUpdate);
  batch.update(jobRef, {
    'counts.running': increment(-1),
    [`counts.${newStatus}`]: increment(1),
    updatedAt: now,
  });
  await batch.commit();
};

export const updateJobStatus = async (
  db: Firestore,
  uid: string,
  jobId: string,
  status: SyncJobStatus
): Promise<void> => {
  const now = new Date().toISOString();
  await updateDoc(doc(db, jobsCol(uid), jobId), {
    status,
    updatedAt: now,
    ...(status === 'done' || status === 'cancelled' ? { completedAt: now } : {}),
  });
};

export const getSyncJob = async (
  db: Firestore,
  uid: string,
  jobId: string
): Promise<SyncJob | null> => {
  const snap = await getDoc(doc(db, jobsCol(uid), jobId));
  recordRead('syncJob:get', 1);
  return snap.exists() ? (snap.data() as SyncJob) : null;
};

// Returns jobs in 'running' state — candidates for resume on login.
// 'populating' jobs are excluded: their item list is incomplete so they need
// a fresh discovery run rather than a resume.
export const getResumableJobs = async (
  db: Firestore,
  uid: string
): Promise<SyncJob[]> => {
  const snap = await getDocs(
    query(collection(db, jobsCol(uid)), where('status', '==', 'running'), limit(5))
  );
  recordRead('syncJob:resumable-scan', snap.size);
  return snap.docs.map(d => d.data() as SyncJob);
};
