import { describe, it, expect } from 'vitest';
import { reviewStateByEntryId, withPreservedReview } from './syncReviewPreservation';
import type { StoredDiaryEntry } from '../types';

const entry = (overrides: Partial<StoredDiaryEntry> = {}): StoredDiaryEntry => ({
  entryId: 'p1_1',
  pageId: 'p1',
  pageTitle: 'page',
  classId: 'c1',
  studentName: 'Student',
  date: 'April 2, 2026',
  weekNumber: '1',
  weather: '',
  diaryText: 'old text',
  diaryTextCorrected: '',
  teacherFeedback: {},
  peerFeedback: [],
  translations: [],
  vocabCount: 0,
  sentiment: '',
  topics: [],
  vocabItems: [],
  photoCount: 0,
  translationCount: 0,
  chatbotFeedback: { present: false, data: '' },
  status: 'draft',
  parserMode: 'label-first',
  templateVersion: 'labeled-diary-v1',
  updatedAt: '2026-05-01T00:00:00.000Z',
  ...overrides,
});

describe('sync review preservation', () => {
  const reviewed = entry({
    status: 'approved',
    approvedAt: '2026-05-10T07:17:00.000Z',
    teacherFeedback: { diaryText: 'Nice work on tense.' },
  });

  it('keeps status, review date and feedback while taking the new content', () => {
    const states = reviewStateByEntryId([reviewed]);
    const incoming = entry({ diaryText: 'new text', status: 'draft', teacherFeedback: {} });
    const written = withPreservedReview(incoming, states.get('p1_1'));
    expect(written).toMatchObject({
      diaryText: 'new text',
      status: 'approved',
      approvedAt: '2026-05-10T07:17:00.000Z',
      teacherFeedback: { diaryText: 'Nice work on tense.' },
    });
  });

  it('does not stamp a fresh review date over the original', () => {
    const incoming = entry({ status: 'approved', approvedAt: '2026-10-05T12:00:00.000Z' });
    expect(withPreservedReview(incoming, reviewStateByEntryId([reviewed]).get('p1_1'))!.approvedAt).toBe('2026-05-10T07:17:00.000Z');
  });

  it('leaves new entries and untouched drafts as drafts', () => {
    const states = reviewStateByEntryId([entry({ entryId: 'p1_2' })]);
    expect(states.size).toBe(0);
    const incoming = entry({ entryId: 'p1_3' });
    expect(withPreservedReview(incoming, states.get('p1_3'))).toBe(incoming);
  });

  it('keeps feedback saved on a draft that is not yet Feedback Ready', () => {
    const draftWithFeedback = entry({ teacherFeedback: { overall: 'Draft note' } });
    const written = withPreservedReview(entry({ teacherFeedback: {} }), reviewStateByEntryId([draftWithFeedback]).get('p1_1'));
    expect(written.teacherFeedback).toEqual({ overall: 'Draft note' });
    expect(written.status).toBe('draft');
  });
});
