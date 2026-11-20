import { describe, expect, it } from 'vitest';
import { serializeStoredEntry } from './firestoreDataService';
import { decodeStoredEntryForReview } from './storedEntryWire';
import { studentContentForField } from './aiFeedbackReview';
import type { StoredDiaryEntry } from '../types';

const entry = {
  entryId: 'e1', pageId: 'p1', pageTitle: 't', classId: 'c1', studentName: 'Sam',
  date: '2026-11-01', weekNumber: '3', weather: 'sunny',
  diaryText: 'I go to school yesterday.', diaryTextCorrected: '',
  teacherFeedback: {},
  peerFeedback: [{ peerName: 'Ken', comment: 'Nice trip' }],
  translations: [{ term: 'gakkou', translation: 'school' }],
  vocabCount: 1, sentiment: 'neutral', topics: [],
  vocabItems: [{ word: 'yesterday' }], photoCount: 0, translationCount: 1,
  chatbotFeedback: { present: true, data: 'Bot said: use past tense.' },
  status: 'draft', parserMode: 'label-first', templateVersion: 'label-v1',
  updatedAt: '2026-11-17T00:00:00.000Z',
} as unknown as StoredDiaryEntry;

describe('decodeStoredEntryForReview', () => {
  it('round-trips serializeStoredEntry output into what studentContentForField reads', () => {
    const wire = serializeStoredEntry(entry) as unknown as Record<string, unknown>;
    const dec = decodeStoredEntryForReview(wire);
    expect(dec.classId).toBe('c1');
    expect(dec.pageId).toBe('p1');
    expect(studentContentForField(dec, 'diaryText')).toBe('I go to school yesterday.');
    expect(studentContentForField(dec, 'chatbot')).toBe('Bot said: use past tense.');
    expect(studentContentForField(dec, 'peerFeedback')).toBe(JSON.stringify(entry.peerFeedback));
    expect(studentContentForField(dec, 'vocab')).toBe(JSON.stringify(entry.vocabItems));
    expect(studentContentForField(dec, 'translations')).toBe(JSON.stringify(entry.translations));
    expect(studentContentForField(dec, 'overall')).toContain('I go to school yesterday.');
    expect(dec.updatedAt).toBe('2026-11-17T00:00:00.000Z');
  });
  it('tolerates missing and malformed fields', () => {
    const dec = decodeStoredEntryForReview({ pageId: 'p', peerFeedback: 'not json', chatbotFeedback: 5 });
    expect(dec.classId).toBe('');
    expect(studentContentForField(dec, 'diaryText')).toBe('');
    expect(studentContentForField(dec, 'chatbot')).toBe('');
  });
});
