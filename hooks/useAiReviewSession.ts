import { useCallback } from 'react';
import type { User } from 'firebase/auth';
import { useAiFeedbackReview } from './useAiFeedbackReview';
import type { IdentityBindingStatus } from './useIdentityBinding';
import type { CollaborationAccessProfile } from '../services/collaborationAccess';
import type { AiReviewFieldKey } from '../services/aiFeedbackReview';
import type { AiReviewAvailabilityInput } from '../services/aiReviewClient';
import { effectiveReviewFocus } from '../services/reviewFocus';
import { sanitizeFirestoreId } from '../services/firestoreDataService';
import type { FeedbackHistoryRecord, FFItemCount, PriorFeedbackMode, UserPreferences } from '../types';
import type { AiReviewRequestBody } from '../components/feedback/FeedbackFieldEditor';

interface Params {
  firebaseUser: User | null;
  /** Live Microsoft account upn; state is scoped to uid + this. */
  microsoftUpn: string | null;
  addLog: (m: string) => void;
  accessProfile: CollaborationAccessProfile | null;
  aiReviewConfigured: boolean;
  microsoftSignedIn: boolean;
  bindingStatus: IdentityBindingStatus;
  preferences: Pick<UserPreferences, 'reviewFocus' | 'feedbackTone' | 'aiModelFeedback'>;
  priorFeedback: PriorFeedbackMode;
  ffItemCount: FFItemCount;
  pastFeedbackForStudent: FeedbackHistoryRecord[];
  isLoadingPastFeedback: boolean;
  activeClassId: string | null | undefined;
  activePageId: string | null | undefined;
}

/**
 * Wires AI feedback review to the App's cross-cutting context: the review state
 * machine, the availability inputs (ARCHITECTURE §22) and the request body for
 * a field. The server knows an entry by its sanitised id, so every id sent to
 * it, and every id used to look reviews up, goes through sanitizeFirestoreId.
 */
export function useAiReviewSession(p: Params) {
  const ai = useAiFeedbackReview({ firebaseUser: p.firebaseUser, microsoftUpn: p.microsoftUpn, addLog: p.addLog });
  const { sentReviewRefsForEntry } = ai;

  const reviewEntryId = (entryId: string) => sanitizeFirestoreId(entryId);

  const availabilityInput = (entrySaved: boolean): Omit<AiReviewAvailabilityInput, 'feedbackText'> => ({
    canUseAiReview: p.accessProfile?.capabilities.canUseAiReview === true,
    configured: p.aiReviewConfigured,
    microsoftSignedIn: p.microsoftSignedIn,
    hasFirebaseUser: !!p.firebaseUser,
    bindingStatus: p.bindingStatus,
    pilotEnabled: p.accessProfile?.pilotEnabled === true,
    entrySaved,
  });

  const buildRequest = (entryId: string, fieldKey: AiReviewFieldKey, feedbackText: string): AiReviewRequestBody => {
    const focus = effectiveReviewFocus(p.preferences, fieldKey);
    const priorFeedbackIds =
      p.priorFeedback !== 'off' && !p.isLoadingPastFeedback
        ? p.pastFeedbackForStudent.slice(0, 3).map((r) => r.feedbackId)
        : [];
    return {
      classId: String(p.activeClassId ?? ''),
      pageId: String(p.activePageId ?? ''),
      entryId: reviewEntryId(entryId),
      fieldKey,
      feedbackText,
      priorFeedbackIds,
      reviewFocus: focus.text,
      reviewFocusSource: focus.source,
      tone: p.preferences.feedbackTone,
      itemCountSetting: p.ffItemCount,
      model: p.preferences.aiModelFeedback,
    };
  };

  const getAiReviewRefsForEntry = useCallback(
    (entryId: string) => sentReviewRefsForEntry(sanitizeFirestoreId(entryId)),
    [sentReviewRefsForEntry]
  );

  return { ai, reviewEntryId, availabilityInput, buildRequest, getAiReviewRefsForEntry };
}
