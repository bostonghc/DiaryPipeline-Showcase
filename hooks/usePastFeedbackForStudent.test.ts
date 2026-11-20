// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchStudent = vi.fn();
const fetchPage = vi.fn();
vi.mock('../services/firestoreDataService', () => ({
  fetchRecentFeedbackForStudent: (...a: unknown[]) => fetchStudent(...a),
  fetchRecentFeedbackForPage: (...a: unknown[]) => fetchPage(...a),
}));

import { usePastFeedbackForStudent } from './usePastFeedbackForStudent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type P = Parameters<typeof usePastFeedbackForStudent>[0];
let latest: ReturnType<typeof usePastFeedbackForStudent>;
const Probe = (p: P) => { latest = usePastFeedbackForStudent(p); return null; };
const rec = (id: string) => ({ feedbackId: id }) as never;
const base: P = { db: {} as never, uid: 'u1', activePageId: 'p1', activeClassId: 'c1', activeStudentUpn: 'a@x', addLog: () => {} };

describe('usePastFeedbackForStudent', () => {
  let root: Root;
  beforeEach(() => { fetchStudent.mockReset(); fetchPage.mockReset(); root = createRoot(document.createElement('div')); });
  afterEach(async () => { await act(async () => root.unmount()); });
  const render = (p: P) => act(async () => root.render(createElement(Probe, p)));

  it('uses scope keys for student and page fallback', async () => {
    fetchStudent.mockResolvedValue([rec('f1')]);
    await render(base);
    expect(latest.scopeKey).toBe('u1|c1|a@x');
    expect(latest.records).toEqual([rec('f1')]);
    fetchPage.mockResolvedValue([]);
    await render({ ...base, activeStudentUpn: '' });
    expect(latest.scopeKey).toBe('u1|page|p1');
  });

  it('returns [] for a scope other than the one requested while loading', async () => {
    fetchStudent.mockResolvedValueOnce([rec('f1')]);
    await render(base);
    expect(latest.records).toHaveLength(1);
    let resolveB!: (v: unknown[]) => void;
    fetchStudent.mockReturnValueOnce(new Promise((r) => { resolveB = r; }));
    await render({ ...base, activeStudentUpn: 'b@x' });
    expect(latest.isLoading).toBe(true);
    expect(latest.records).toEqual([]);
    await act(async () => resolveB([rec('f2')]));
    expect(latest.records).toEqual([rec('f2')]);
    expect(latest.isLoading).toBe(false);
  });

  it('ignores a response for a superseded scope', async () => {
    let resolveA!: (v: unknown[]) => void;
    fetchStudent.mockReturnValueOnce(new Promise((r) => { resolveA = r; }));
    await render(base);
    fetchStudent.mockResolvedValueOnce([rec('fb')]);
    await render({ ...base, activeStudentUpn: 'b@x' });
    await act(async () => resolveA([rec('fa')]));
    expect(latest.records).toEqual([rec('fb')]);
  });

  it('setRecords from a stale closure cannot overwrite a newer scope', async () => {
    fetchStudent.mockResolvedValueOnce([rec('fa')]);
    await render(base);
    const staleSet = latest.setRecords;
    fetchStudent.mockResolvedValueOnce([rec('fb')]);
    await render({ ...base, activeStudentUpn: 'b@x' });
    await act(async () => staleSet(() => [rec('stale')]));
    expect(latest.records).toEqual([rec('fb')]);
  });

  it('setRecords edits the loaded scope', async () => {
    fetchStudent.mockResolvedValue([rec('f1')]);
    await render(base);
    await act(async () => latest.setRecords((prev) => [rec('f0'), ...prev]));
    expect(latest.records).toEqual([rec('f0'), rec('f1')]);
  });
});
