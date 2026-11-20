import type { CollaborationRole } from './collaborationAccess';

/**
 * Who may open the Sent Feedback Review tab, and why it might not be usable.
 *
 * 'signed-out' is deliberately separate from 'not-permitted': an owner or lead
 * whose Microsoft session ended has not lost any permission and can fix it by
 * connecting again, so the tab stays visible but unavailable and says so. Only
 * people who can never use the tab (interns, unassigned accounts) get it hidden.
 */
export type SentFeedbackReviewAccess = 'ready' | 'verifying' | 'signed-out' | 'not-permitted';

export const MICROSOFT_SIGNED_OUT_REASON =
  'Your Microsoft sign-in has expired. Connect again to review feedback sent by others.';

const canReview = (role: CollaborationRole | null | undefined): boolean =>
  role === 'owner' || role === 'lead';

export const resolveSentFeedbackReviewAccess = (state: {
  /** Role on the current access profile; undefined when there is no profile (signed out). */
  profileRole: CollaborationRole | null | undefined;
  /** Role the browser last saw while signed in, kept after the session ends. */
  lastKnownRole: CollaborationRole | null;
  identityBound: boolean;
}): SentFeedbackReviewAccess => {
  if (state.profileRole !== undefined) {
    if (!canReview(state.profileRole)) return 'not-permitted';
    return state.identityBound ? 'ready' : 'verifying';
  }
  return canReview(state.lastKnownRole) ? 'signed-out' : 'not-permitted';
};
