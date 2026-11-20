import { describe, it, expect } from 'vitest';
import {
  deriveArchiveCaptureStatus,
  deriveArchiveCaptureByClass,
  isSectionPageLoadError,
  isUntitledPageCapturePlaceholder,
  planPageRecordReconciliation,
  shouldSkipPageCapture,
} from './archiveCaptureStatus';
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

  it('excludes reconciled orphan records from current archive coverage', () => {
    const status = deriveArchiveCaptureStatus([
      rec('saved'),
      rec('saved', {
        pageId: 'historical-page',
        entryCount: 4,
        orphanedAt: '2026-08-27T00:00:00.000Z',
      }),
    ]);

    expect(status.state).toBe('captured');
    expect(status.total).toBe(1);
    expect(status.errored).toBe(0);
    expect(status.archived).toBe(1);
  });

  it('continues to count section page-list errors', () => {
    const status = deriveArchiveCaptureStatus([
      rec('saved', { diaryGroupId: 'section-ok' }),
      rec('error', {
        pageId: 'error-section-1',
        pageTitle: '⚠️ Error loading pages: Unknown API Error',
        diaryGroupId: 'section-failed',
        entryCount: 0,
      }),
    ]);

    expect(status.state).toBe('captured');
    expect(status.errored).toBe(0);
    expect(status.sectionErrors).toBe(1);
  });

  it('defers page errors in failed or unknown sections instead of counting them as current failures', () => {
    const status = deriveArchiveCaptureStatus([
      rec('saved', { pageId: 'current', diaryGroupId: 'section-ok' }),
      rec('error', {
        pageId: 'error-section-failed',
        recordKind: 'section_error',
        diaryGroupId: 'section-failed',
        entryCount: 0,
      }),
      rec('error', { pageId: 'failed-child', diaryGroupId: 'section-failed', entryCount: 0 }),
      rec('error', { pageId: 'legacy-unscoped', diaryGroupId: undefined, entryCount: 0 }),
      rec('error', { pageId: 'current-error', diaryGroupId: 'section-ok', entryCount: 0 }),
    ]);

    expect(status.state).toBe('captured-except');
    expect(status.errored).toBe(1);
    expect(status.deferred).toBe(2);
    expect(status.sectionErrors).toBe(1);
    expect(status.label).toBe('Captured except 1 page');
  });
});

describe('planPageRecordReconciliation', () => {
  it('reconciles by page id rather than stored title', () => {
    const records = [
      rec('saved', { pageId: 'current', pageTitle: 'Untitled Page', entryCount: 2 }),
      rec('error', { pageId: 'missing-empty', pageTitle: 'Student diary', entryCount: 0 }),
      rec('saved', { pageId: 'missing-evidence', pageTitle: '', entryCount: 3 }),
      rec('saved', {
        pageId: 'restored',
        pageTitle: 'Old name',
        entryCount: 2,
        orphanedAt: '2026-08-20T00:00:00.000Z',
      }),
    ];

    const plan = planPageRecordReconciliation(
      records,
      new Set(['current', 'restored']),
      {
        classDiscoveryComplete: true,
        successfullyListedSectionIds: new Set(),
      }
    );

    expect(plan.deletePageIds).toEqual(['missing-empty']);
    expect(plan.markOrphanedPageIds).toEqual(['missing-evidence']);
    expect(plan.restorePageIds).toEqual(['restored']);
    expect(plan.deferredPageIds).toEqual([]);
  });

  it('reconciles successful sections while deferring failed and unscoped records', () => {
    const plan = planPageRecordReconciliation(
      [
        rec('error', {
          pageId: 'successful-section-missing',
          diaryGroupId: 'section-ok',
          entryCount: 0,
        }),
        rec('error', {
          pageId: 'failed-section-missing',
          diaryGroupId: 'section-failed',
          entryCount: 0,
        }),
        rec('error', {
          pageId: 'legacy-unscoped',
          diaryGroupId: undefined,
          entryCount: 0,
        }),
      ],
      new Set(),
      {
        classDiscoveryComplete: false,
        successfullyListedSectionIds: new Set(['section-ok']),
      }
    );

    expect(plan.deletePageIds).toEqual(['successful-section-missing']);
    expect(plan.markOrphanedPageIds).toEqual([]);
    expect(plan.restorePageIds).toEqual([]);
    expect(plan.deferredPageIds).toEqual(['failed-section-missing', 'legacy-unscoped']);
  });

  it('treats every discovered id as present before title or section filtering', () => {
    const plan = planPageRecordReconciliation(
      [rec('saved', {
        pageId: 'blank-title-page',
        pageTitle: '',
        diaryGroupId: 'formerly-failed-section',
        entryCount: 2,
        orphanedAt: '2026-08-20T00:00:00.000Z',
      })],
      new Set(['blank-title-page']),
      {
        classDiscoveryComplete: false,
        successfullyListedSectionIds: new Set(['different-successful-section']),
      }
    );

    expect(plan.restorePageIds).toEqual(['blank-title-page']);
    expect(plan.markOrphanedPageIds).toEqual([]);
    expect(plan.deferredPageIds).toEqual([]);
  });

  it('never treats section failure records as orphaned pages', () => {
    const plan = planPageRecordReconciliation(
      [rec('error', {
        pageId: 'error-section-1',
        recordKind: 'section_error',
        entryCount: 0,
      })],
      new Set(),
      {
        classDiscoveryComplete: true,
        successfullyListedSectionIds: new Set(),
      }
    );

    expect(plan.deletePageIds).toEqual([]);
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

describe('shouldSkipPageCapture', () => {
  it('skips untitled OneNote pages with or without display prefixes', () => {
    expect(shouldSkipPageCapture({ id: 'page-1', displayName: 'Untitled Page' })).toBe(true);
    expect(shouldSkipPageCapture({ id: 'page-2', displayName: '? Untitled Page' })).toBe(true);
    expect(shouldSkipPageCapture({ id: 'page-3', displayName: '* ? Untitled Page' })).toBe(true);
  });

  it('skips synthetic page-loading error nodes', () => {
    const page = {
      id: 'error-section-1',
      displayName: '⚠️ Error loading pages: Unknown API Error',
    };
    expect(shouldSkipPageCapture(page)).toBe(true);
    expect(isSectionPageLoadError(page)).toBe(true);
    expect(isUntitledPageCapturePlaceholder(page)).toBe(false);
  });

  it('keeps a real student diary page', () => {
    expect(shouldSkipPageCapture({
      id: 'page-4',
      displayName: '1234575 - Kato Nana',
    })).toBe(false);
  });
});
