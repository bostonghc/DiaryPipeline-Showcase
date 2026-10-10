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
  label: string;
}

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

  for (const record of records) {
    if (record.syncState === 'saved') saved += 1;
    else if (record.syncState === 'error') errored += 1;
    else if (isPending(record.syncState)) pending += 1;
  }

  const total = records.length;

  // Precedence encodes the honesty rule: pending work (which a re-run can finish)
  // is the most actionable state and outranks errors; only once nothing is
  // pending do known failures surface as "Captured except N"; a clean "Captured"
  // requires zero pending AND zero errored.
  let state: ArchiveCaptureState;
  if (total === 0) state = 'none';
  else if (pending > 0) state = 'needs-pass';
  else if (errored > 0) state = 'captured-except';
  else state = 'captured';

  return { state, total, saved, pending, errored, label: buildLabel(state, errored) };
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
