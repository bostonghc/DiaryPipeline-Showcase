import { describe, it, expect } from 'vitest';
import { authorshipCheck, sentFeedbackText, type ReviewedFeedback } from './sentFeedbackReview';

const record = (overrides: Partial<ReviewedFeedback> = {}): ReviewedFeedback => ({
  feedbackId: 'f1',
  classId: 'c1',
  pageId: 'p1',
  entryId: 'e1',
  studentUpn: 'ak1@x.jp',
  studentName: 'Student',
  channel: 'email',
  sentAt: '2026-10-06T00:00:00.000Z',
  source: 'human',
  fieldsAddressed: ['diaryText'],
  content: '<p>Great <b>work</b>!</p><p>Keep going &amp; try past tense.</p>',
  updatedAt: '2026-10-06T00:00:00.000Z',
  formatVersion: 3,
  ownerUid: 'uid-emma',
  ...overrides,
});

describe('authorshipCheck', () => {
  it('compares the recorded author with the account that saved the record', () => {
    expect(authorshipCheck(record({ authorFirebaseUid: 'uid-emma' }))).toBe('matches');
    expect(authorshipCheck(record({ authorFirebaseUid: 'uid-other' }))).toBe('mismatch');
    expect(authorshipCheck(record())).toBe('not-recorded');
  });
});

describe('sentFeedbackText', () => {
  it('uses the included structured sections when present', () => {
    const text = sentFeedbackText(
      record({
        structuredFeedback: {
          greeting: 'Hi',
          diaryFeedback: 'Nice diary.',
          includeDiary: true,
          vocabFeedback: 'Not sent',
          includeVocab: false,
          overallFeedback: 'Well done.',
          includeOverall: true,
          closing: 'Bye',
          reviewNotice: '',
        },
      })
    );
    expect(text).toBe('Nice diary.\n\nWell done.');
  });

  it('falls back to the stored HTML as plain text, never rendering markup', () => {
    expect(sentFeedbackText(record())).toBe('Great work!\nKeep going & try past tense.');
  });
});
