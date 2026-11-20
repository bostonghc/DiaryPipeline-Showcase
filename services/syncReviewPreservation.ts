import type { EntryStatus, StoredDiaryEntry, TeacherFeedbackFields } from '../types';

/**
 * Sync rewrites diary *content*; review work belongs to the teacher.
 *
 * Background sync saves every parsed entry through the same builder the
 * workspace uses, which stamps `status: 'draft'` and the in-memory feedback of
 * whatever page happens to be open (usually none). Saves merge, but those
 * fields are always present, so a re-read page lost its Feedback Ready status
 * and saved feedback. It rarely fired while stale OneNote dates kept pages from
 * being re-read; a Force re-sync on 2026-10-05 reset 8 entries (restored from
 * Firestore's one-hour version history). The workspace's open-page path already
 * remaps saved state and is unaffected.
 *
 * Rule: when sync saves an entry that already exists, its status, review date
 * and teacher feedback are carried over unchanged. New entries start as drafts.
 */

export interface ReviewState {
  status: EntryStatus;
  teacherFeedback: TeacherFeedbackFields;
  approvedAt?: string;
}

const hasFeedback = (feedback: TeacherFeedbackFields | undefined): boolean =>
  Object.values(feedback ?? {}).some((value) => typeof value === 'string' && value.trim().length > 0);

/** Review state of the stored entries on one page, by entry ID. */
export const reviewStateByEntryId = (stored: StoredDiaryEntry[]): Map<string, ReviewState> => {
  const states = new Map<string, ReviewState>();
  for (const entry of stored) {
    if (entry.status === 'draft' && !hasFeedback(entry.teacherFeedback) && !entry.approvedAt) continue;
    states.set(entry.entryId, {
      status: entry.status,
      teacherFeedback: entry.teacherFeedback ?? {},
      ...(entry.approvedAt ? { approvedAt: entry.approvedAt } : {}),
    });
  }
  return states;
};

/** The entry sync should write: fresh content, with any existing review work carried over. */
export const withPreservedReview = (incoming: StoredDiaryEntry, existing?: ReviewState): StoredDiaryEntry => {
  if (!existing) return incoming;
  const { approvedAt: _dropped, ...rest } = incoming;
  return {
    ...rest,
    status: existing.status,
    teacherFeedback: existing.teacherFeedback,
    ...(existing.approvedAt ? { approvedAt: existing.approvedAt } : {}),
  };
};
