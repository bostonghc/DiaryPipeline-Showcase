import { describe, it, expect } from 'vitest';
import { deriveArchiveCaptureStatus, deriveArchiveCaptureByClass } from './archiveCaptureStatus';
import type { PageSyncRecord, PageSyncState } from '../types';

const rec = (syncState: PageSyncState, overrides: Partial<PageSyncRecord> = {}): PageSyncRecord => ({
  pageId: `p-${Math.random().toString(36).slice(2)}`,
  classId: 'c1',
  pageTitle: 'Page',
  studentName: 'Student',
  parserMode: 'label-first',
  templateVersion: 'labeled-diary-v1',
  syncState,
  entryCount: 1,
  updatedAt: '2026-06-05T00:00:00.000Z',
  ...overrides,
});

describe('deriveArchiveCaptureStatus', () => {
  it('returns "none" for an empty class (never attempted)', () => {
    const status = deriveArchiveCaptureStatus([]);
    expect(status.state).toBe('none');
    expect(status.label).toBe('');
    expect(status.total).toBe(0);
  });

  it('returns "captured" when every page is saved', () => {
    const status = deriveArchiveCaptureStatus([rec('saved'), rec('saved'), rec('saved')]);
    expect(status.state).toBe('captured');
    expect(status.label).toBe('Captured');
    expect(status.saved).toBe(3);
    expect(status.pending).toBe(0);
    expect(status.errored).toBe(0);
  });

  it('returns "needs-pass" when pages are rate-limited or queued', () => {
    const status = deriveArchiveCaptureStatus([rec('saved'), rec('rate_limited'), rec('queued')]);
    expect(status.state).toBe('needs-pass');
    expect(status.label).toBe('Needs another pass');
    expect(status.pending).toBe(2);
  });

  it('treats syncing and idle as pending (not captured)', () => {
    expect(deriveArchiveCaptureStatus([rec('saved'), rec('syncing')]).state).toBe('needs-pass');
    expect(deriveArchiveCaptureStatus([rec('saved'), rec('idle')]).state).toBe('needs-pass');
  });

  it('returns "captured-except" when work is done but pages errored (honesty rule)', () => {
    const status = deriveArchiveCaptureStatus([rec('saved'), rec('saved'), rec('error'), rec('error'), rec('error')]);
    expect(status.state).toBe('captured-except');
    expect(status.label).toBe('Captured except 3 pages');
    expect(status.errored).toBe(3);
  });

  it('singularizes the "except" label for a single errored page', () => {
    const status = deriveArchiveCaptureStatus([rec('saved'), rec('error')]);
    expect(status.label).toBe('Captured except 1 page');
  });

  it('MIXED: saved + error + rate_limited resolves to "needs-pass", NOT "captured-except"', () => {
    // Pending outranks errors: a re-run is the next action, and only once nothing
    // is pending should known failures surface. Proves the precedence.
    const status = deriveArchiveCaptureStatus([rec('saved'), rec('error'), rec('rate_limited')]);
    expect(status.state).toBe('needs-pass');
    expect(status.label).toBe('Needs another pass');
    expect(status.pending).toBe(1);
    expect(status.errored).toBe(1);
  });

  it('never reports a clean "Captured" while any page is errored', () => {
    const status = deriveArchiveCaptureStatus([rec('saved'), rec('error')]);
    expect(status.state).not.toBe('captured');
  });
});

describe('deriveArchiveCaptureByClass', () => {
  it('groups records by classId and derives each class independently', () => {
    const records = [
      rec('saved', { classId: 'clean' }),
      rec('saved', { classId: 'clean' }),
      rec('saved', { classId: 'errored' }),
      rec('error', { classId: 'errored' }),
      rec('rate_limited', { classId: 'pending' }),
    ];
    const map = deriveArchiveCaptureByClass(records);
    expect(map.get('clean')?.state).toBe('captured');
    expect(map.get('errored')?.state).toBe('captured-except');
    expect(map.get('errored')?.label).toBe('Captured except 1 page');
    expect(map.get('pending')?.state).toBe('needs-pass');
  });

  it('returns an empty map for no records', () => {
    expect(deriveArchiveCaptureByClass([]).size).toBe(0);
  });
});
