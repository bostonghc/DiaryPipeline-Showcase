import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDocs = vi.fn((_args?: unknown) => Promise.resolve({ size: 0, docs: [] }) as unknown);
const deleteDoc = vi.fn((_args?: unknown) => Promise.resolve(undefined) as unknown);

vi.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => ({ __collection: args }),
  deleteField: () => ({ __deleteField: true }),
  deleteDoc: (...args: unknown[]) => deleteDoc(args),
  doc: (...args: unknown[]) => ({ __doc: args }),
  getDoc: vi.fn(),
  getDocs: (...args: unknown[]) => getDocs(args),
  limit: vi.fn(),
  orderBy: vi.fn(),
  query: (...args: unknown[]) => ({ __query: args }),
  setDoc: vi.fn(async () => undefined),
  updateDoc: vi.fn(async () => undefined),
  where: (...args: unknown[]) => ({ __where: args }),
  writeBatch: vi.fn(),
}));

const {
  listPageSyncRecordsForClasses,
  invalidatePageRecordCache,
  deletePageSyncRecord,
} = await import('./firestoreDataService');

const db = {} as any;
const emptySnapshot = { size: 0, docs: [] };

beforeEach(() => {
  getDocs.mockReset();
  getDocs.mockResolvedValue(emptySnapshot);
  deleteDoc.mockClear();
  invalidatePageRecordCache();
});

describe('page record read cache', () => {
  it('issues one query set for concurrent identical reads', async () => {
    // The tree badge, archive-status hook and dashboard mount together and each
    // asked for the same records independently.
    await Promise.all([
      listPageSyncRecordsForClasses(db, 'uid-1', ['class-a']),
      listPageSyncRecordsForClasses(db, 'uid-1', ['class-a']),
      listPageSyncRecordsForClasses(db, 'uid-1', ['class-a']),
    ]);
    expect(getDocs).toHaveBeenCalledTimes(1);
  });

  it('reuses a recent read for the same classes regardless of order', async () => {
    await listPageSyncRecordsForClasses(db, 'uid-1', ['class-a', 'class-b']);
    await listPageSyncRecordsForClasses(db, 'uid-1', ['class-b', 'class-a']);
    expect(getDocs).toHaveBeenCalledTimes(2); // one per class, from the first call only
  });

  it('does not share results between users', async () => {
    await listPageSyncRecordsForClasses(db, 'uid-1', ['class-a']);
    await listPageSyncRecordsForClasses(db, 'uid-2', ['class-a']);
    expect(getDocs).toHaveBeenCalledTimes(2);
  });

  it('re-reads after a page record is written', async () => {
    // Correctness guard: a stale badge must not outlive the write that changed it.
    await listPageSyncRecordsForClasses(db, 'uid-1', ['class-a']);
    await deletePageSyncRecord(db, 'uid-1', 'page-1');
    await listPageSyncRecordsForClasses(db, 'uid-1', ['class-a']);
    expect(getDocs).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read', async () => {
    getDocs.mockRejectedValueOnce(new Error('offline'));
    await expect(listPageSyncRecordsForClasses(db, 'uid-1', ['class-a'])).rejects.toThrow('offline');
    getDocs.mockResolvedValue(emptySnapshot);
    await listPageSyncRecordsForClasses(db, 'uid-1', ['class-a']);
    expect(getDocs).toHaveBeenCalledTimes(2);
  });
});
