import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDocs = vi.fn();
const getDocsFromCache = vi.fn();
const getCountFromServer = vi.fn();

vi.mock('firebase/firestore', () => ({
  collection: (...args: unknown[]) => ({ __collection: args }),
  query: (...args: unknown[]) => ({ __query: args }),
  where: (...args: unknown[]) => ({ __where: args }),
  getDocs: (q: unknown) => getDocs(q),
  getDocsFromCache: (q: unknown) => getDocsFromCache(q),
  getCountFromServer: (q: unknown) => getCountFromServer(q),
}));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
});

const { loadClassCollection } = await import('./incrementalClassQuery');

const snapshot = (ids: string[]) => ({ size: ids.length, docs: ids.map((id) => ({ data: () => ({ id }) })) });
const count = (n: number) => ({ data: () => ({ count: n }) });
const db = {} as any;
/** True when the query passed to getDocs carries an updatedAt filter (a delta query). */
const isDelta = (q: any) => JSON.stringify(q).includes('updatedAt');

beforeEach(() => {
  store.clear();
  getDocs.mockReset();
  getDocsFromCache.mockReset();
  getCountFromServer.mockReset();
});

describe('loadClassCollection', () => {
  it('does a full load the first time, then serves from cache plus changes', async () => {
    getDocs.mockResolvedValue(snapshot(['a', 'b', 'c']));
    const first = await loadClassCollection(db, 'u', 'entries', 'c1', 'incremental');
    expect(first.servedAs).toBe('full');

    getDocs.mockImplementation(async (q: any) => (isDelta(q) ? snapshot(['c']) : snapshot(['a', 'b', 'c'])));
    getDocsFromCache.mockResolvedValue(snapshot(['a', 'b', 'c']));
    getCountFromServer.mockResolvedValue(count(3));
    const second = await loadClassCollection(db, 'u', 'entries', 'c1', 'incremental');
    expect(second).toEqual({ docs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], servedAs: 'incremental' });
    // Only the delta query reached the server for documents.
    expect(getDocs).toHaveBeenLastCalledWith(expect.objectContaining({ __query: expect.anything() }));
    expect(isDelta(getDocs.mock.calls.at(-1)![0])).toBe(true);
  });

  it('falls back to a full load when the cache count disagrees with the server', async () => {
    getDocs.mockResolvedValue(snapshot(['a', 'b']));
    await loadClassCollection(db, 'u', 'entries', 'c1', 'full');

    getDocs.mockImplementation(async (q: any) => (isDelta(q) ? snapshot([]) : snapshot(['a', 'b', 'd'])));
    getDocsFromCache.mockResolvedValue(snapshot(['a', 'b'])); // evicted or missed a document
    getCountFromServer.mockResolvedValue(count(3));
    const result = await loadClassCollection(db, 'u', 'entries', 'c1', 'incremental');
    expect(result.servedAs).toBe('full');
    expect(result.docs.map((d) => d.id)).toEqual(['a', 'b', 'd']);
  });

  it('falls back to a full load when the cache cannot be read', async () => {
    getDocs.mockResolvedValue(snapshot(['a']));
    await loadClassCollection(db, 'u', 'pages', 'c1', 'full');
    getDocsFromCache.mockRejectedValue(new Error('no persistent cache'));
    getCountFromServer.mockResolvedValue(count(1));
    expect((await loadClassCollection(db, 'u', 'pages', 'c1', 'incremental')).servedAs).toBe('full');
  });

  it('always reads everything for a full load, even with a watermark', async () => {
    getDocs.mockResolvedValue(snapshot(['a']));
    await loadClassCollection(db, 'u', 'entries', 'c1', 'full');
    await loadClassCollection(db, 'u', 'entries', 'c1', 'full');
    expect(getDocsFromCache).not.toHaveBeenCalled();
    expect(getDocs.mock.calls.every(([q]) => !isDelta(q))).toBe(true);
  });

  it('keeps watermarks separate per user, collection and class', async () => {
    getDocs.mockResolvedValue(snapshot(['a']));
    await loadClassCollection(db, 'u', 'entries', 'c1', 'full');
    // A different class has no watermark yet, so its first incremental load is full.
    expect((await loadClassCollection(db, 'u', 'entries', 'c2', 'incremental')).servedAs).toBe('full');
    expect(getDocsFromCache).not.toHaveBeenCalled();
  });
});
