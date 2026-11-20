import { collectionGroup, getDocs, limit, orderBy, query, where, type Firestore } from 'firebase/firestore';
import type { FeedbackHistoryRecord } from '../types';
import { hydrateFeedbackHistoryRecord } from './firestoreDataService';
import { recordRead } from './readMeter';

/**
 * Owner/lead review of feedback sent through the app by any pilot participant
 * (Track B step 3). Reads every user's `feedbackHistory` for the given classes
 * through a collection-group query; firestore.rules allows it only when the
 * reader's identity claims carry role owner/lead and the class is in scope.
 * Needs the (classId, sentAt desc) COLLECTION_GROUP index.
 */

export interface ReviewedFeedback extends FeedbackHistoryRecord {
  /** Firebase uid of the account whose Firestore area holds the record. */
  ownerUid: string;
}

/** Most recent records per class; the pilot is small, so this covers the term. */
const PER_CLASS_LIMIT = 300;

export const listSentFeedbackForReview = async (db: Firestore, classIds: string[]): Promise<ReviewedFeedback[]> => {
  const snapshots = await Promise.all(
    Array.from(new Set(classIds)).map((classId) =>
      getDocs(
        query(
          collectionGroup(db, 'feedbackHistory'),
          where('classId', '==', classId),
          orderBy('sentAt', 'desc'),
          limit(PER_CLASS_LIMIT)
        )
      )
    )
  );
  recordRead('feedbackHistory:review', snapshots.reduce((n, s) => n + s.size, 0));
  return snapshots
    .flatMap((snapshot) =>
      snapshot.docs.map((d) => ({ ...hydrateFeedbackHistoryRecord(d.data()), ownerUid: d.ref.parent.parent?.id ?? '' }))
    )
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt));
};

export type AuthorshipCheck = 'matches' | 'mismatch' | 'not-recorded';

/**
 * Whether the record's recorded Firebase author is the account that saved it.
 * Rules already require this on new records; older records predate the field.
 */
export const authorshipCheck = (record: ReviewedFeedback): AuthorshipCheck =>
  !record.authorFirebaseUid ? 'not-recorded' : record.authorFirebaseUid === record.ownerUid ? 'matches' : 'mismatch';

/** Plain text of a sent message, for display without rendering stored HTML. */
export const sentFeedbackText = (record: FeedbackHistoryRecord): string => {
  const structured = record.structuredFeedback;
  if (structured) {
    const parts = [
      structured.includeDiary && structured.diaryFeedback,
      structured.includePeer && structured.peerFeedback,
      structured.includeVocab && structured.vocabFeedback,
      structured.includeTranslations && structured.translationsFeedback,
      structured.includeChatbot && structured.chatbotFeedback,
      structured.includeOverall && structured.overallFeedback,
    ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
    if (parts.length > 0) return parts.join('\n\n');
  }
  return record.content
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
