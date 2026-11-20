import type { PageSyncRecord, PageSyncState } from '../types';

// Archive capture status (Coverage & Sync Truthfulness, Slice 5).
//
// Answers one question for a class: "is the diary archive fully captured in the
// DB?" It is deliberately scoped to *capture*, not freshness or feedback — the
// label is always prefixed "Archive capture:" so a legacy class reading
// "Captured" is never mistaken for "up to date with classroom activity".
//
// Honesty rule: never claim a clean "Captured" while pages are known to have
// failed. A page that errored is a hole in the dataset that export cannot
// reveal (export shows what saved, not what should have), so an errored page
// downgrades the verdict to "Captured except N".

export type ArchiveCaptureState = 'captured' | 'needs-pass' | 'captured-except' | 'none';

export interface ArchiveCaptureStatus {
  state: ArchiveCaptureState;
  total: number;
  saved: number;
  /** Pages not yet definitively saved and not errored — a re-run can still finish these. */
  pending: number;
  /** Pages that failed and will not self-heal on re-run. */
  errored: number;
  /** Sections whose page list could not be read from Graph. Not a page count. */
  sectionErrors: number;
  /** Evidence-bearing pages retained after they disappeared from current discovery. */
  archived: number;
  /** Page records whose current status cannot be decided until failed sections list. */
  deferred: number;
  label: string;
}

export interface PageRecordReconciliationPlan {
  deletePageIds: string[];
  markOrphanedPageIds: string[];
  restorePageIds: string[];
  deferredPageIds: string[];
}

export interface PageRecordReconciliationScope {
  classDiscoveryComplete: boolean;
  successfullyListedSectionIds: ReadonlySet<string>;
}

/**
 * GraphService uses visible placeholder nodes when a section cannot return pages,
 * and OneNote can expose genuinely untitled pages. Neither is a diary capture
 * target: queuing them creates permanent error records with no student evidence.
 */
const normalizeCapturePageTitle = (displayName: string): string =>
  displayName
    .replace(/^[?*\s]+/, '')
    .trim()
    .toLowerCase();

export const isUntitledPageCapturePlaceholder = (
  page: { id: string; displayName: string }
): boolean => {
  return normalizeCapturePageTitle(page.displayName) === 'untitled page';
};

export const isSectionPageLoadError = (
  page: { id: string; displayName: string }
): boolean => {
  return page.id.startsWith('error-') || /error loading pages:/i.test(page.displayName);
};

export const shouldSkipPageCapture = (page: { id: string; displayName: string }): boolean => {
  return isUntitledPageCapturePlaceholder(page) || isSectionPageLoadError(page);
};

export const isSectionFailureRecord = (record: PageSyncRecord): boolean =>
  record.recordKind === 'section_error' || isSectionPageLoadError({
    id: record.pageId,
    displayName: record.pageTitle,
  });

export const isPageRecordDeferredBySectionFailures = (
  record: PageSyncRecord,
  failedSectionIds: ReadonlySet<string>,
  hasSectionFailures: boolean
): boolean =>
  hasSectionFailures && (
    !record.diaryGroupId || failedSectionIds.has(record.diaryGroupId)
  );

/**
 * Reconcile stored page identities against current discovery. A fully listed
 * section is a safe reconciliation boundary because its paginated page list is
 * complete. Records in failed sections, plus legacy records with no section id,
 * are deferred unless the whole class listed successfully.
 */
export const planPageRecordReconciliation = (
  records: PageSyncRecord[],
  discoveredPageIds: ReadonlySet<string>,
  scope: PageRecordReconciliationScope
): PageRecordReconciliationPlan => {
  const plan: PageRecordReconciliationPlan = {
    deletePageIds: [],
    markOrphanedPageIds: [],
    restorePageIds: [],
    deferredPageIds: [],
  };

  for (const record of records) {
    if (isSectionFailureRecord(record)) continue;

    if (discoveredPageIds.has(record.pageId)) {
      if (record.orphanedAt) plan.restorePageIds.push(record.pageId);
      continue;
    }

    const recordIsInSafeScope = scope.classDiscoveryComplete || (
      Boolean(record.diaryGroupId) &&
      scope.successfullyListedSectionIds.has(record.diaryGroupId as string)
    );
    if (!recordIsInSafeScope) {
      plan.deferredPageIds.push(record.pageId);
      continue;
    }

    if (record.entryCount === 0) {
      plan.deletePageIds.push(record.pageId);
    } else if (!record.orphanedAt) {
      plan.markOrphanedPageIds.push(record.pageId);
    }
  }

  return plan;
};

// Only 'saved' counts as captured. 'error' is a permanent hole. Everything else
// (queued/syncing/rate_limited/idle) is pending — a later pass can still finish it.
const isPending = (state: PageSyncState): boolean =>
  state === 'queued' || state === 'syncing' || state === 'rate_limited' || state === 'idle';

const buildLabel = (state: ArchiveCaptureState, errored: number): string => {
  switch (state) {
    case 'captured':
      return 'Captured';
    case 'needs-pass':
      return 'Needs another pass';
    case 'captured-except':
      return `Captured except ${errored} page${errored === 1 ? '' : 's'}`;
    case 'none':
      return '';
  }
};

export const deriveArchiveCaptureStatus = (records: PageSyncRecord[]): ArchiveCaptureStatus => {
  let saved = 0;
  let pending = 0;
  let errored = 0;
  let sectionErrors = 0;
  let archived = 0;
  let deferred = 0;

  const sectionFailureRecords = records.filter(isSectionFailureRecord);
  const failedSectionIds = new Set(
    sectionFailureRecords
      .map((record) => record.diaryGroupId)
      .filter((sectionId): sectionId is string => Boolean(sectionId))
  );
  sectionErrors = sectionFailureRecords.length;

  for (const record of records) {
    if (isSectionFailureRecord(record)) {
      continue;
    }
    if (record.orphanedAt) {
      archived += 1;
      continue;
    }
    if (isPageRecordDeferredBySectionFailures(record, failedSectionIds, sectionErrors > 0)) {
      deferred += 1;
      continue;
    }

    if (record.syncState === 'saved') saved += 1;
    else if (record.syncState === 'error') errored += 1;
    else if (isPending(record.syncState)) pending += 1;
  }

  const total = saved + pending + errored;

  // Precedence encodes the honesty rule: pending work (which a re-run can finish)
  // is the most actionable state and outranks errors; only once nothing is
  // pending do known failures surface as "Captured except N"; a clean "Captured"
  // requires zero pending AND zero errored.
  let state: ArchiveCaptureState;
  if (total === 0) state = 'none';
  else if (pending > 0) state = 'needs-pass';
  else if (errored > 0) state = 'captured-except';
  else state = 'captured';

  return {
    state,
    total,
    saved,
    pending,
    errored,
    sectionErrors,
    archived,
    deferred,
    label: buildLabel(state, errored),
  };
};

/** Group page sync records by classId and derive each class's capture status. */
export const deriveArchiveCaptureByClass = (
  records: PageSyncRecord[]
): Map<string, ArchiveCaptureStatus> => {
  const byClass = new Map<string, PageSyncRecord[]>();
  for (const record of records) {
    const list = byClass.get(record.classId);
    if (list) list.push(record);
    else byClass.set(record.classId, [record]);
  }

  const result = new Map<string, ArchiveCaptureStatus>();
  for (const [classId, classRecords] of byClass) {
    result.set(classId, deriveArchiveCaptureStatus(classRecords));
  }
  return result;
};
