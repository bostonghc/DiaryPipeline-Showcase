import { describe, it, expect } from 'vitest';
import {
  hydrateFeedbackReviewDecisionRecord,
  sanitizeFeedbackHistoryWire,
  sanitizeFeedbackReviewDecisionWire,
  hydrateFeedbackHistoryRecord,
  hydratePageSyncRecord,
  collapseHydratedPageEntries,
  sanitizeUserPreferencesWire,
  resolveClassParserConfig,
} from './firestoreDataService';
import type {
  FeedbackHistoryRecord,
  FeedbackReviewDecisionRecord,
  HydratedPageEntry,
  StoredDiaryEntry,
  UserPreferences,
} from '../types';

describe('page sync record hydration', () => {
  it('preserves reconciliation metadata and infers legacy section failures', () => {
    const orphan = hydratePageSyncRecord({
      pageId: 'page-1',
      classId: 'class-1',
      parserMode: 'label-first',
      templateVersion: 'labeled-diary-v1',
      syncState: 'saved',
      entryCount: 3,
      orphanedAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(orphan.recordKind).toBe('page');
    expect(orphan.orphanedAt).toBe('2026-08-27T00:00:00.000Z');

    const sectionError = hydratePageSyncRecord({
      pageId: 'error-section-1',
      classId: 'class-1',
      parserMode: 'label-first',
      templateVersion: 'labeled-diary-v1',
      syncState: 'error',
      entryCount: 0,
      updatedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(sectionError.recordKind).toBe('section_error');
  });
});

const rec = (overrides: Partial<FeedbackHistoryRecord> = {}): FeedbackHistoryRecord => ({
  feedbackId: 'f1',
  classId: 'c1',
  pageId: 'p1',
  entryId: 'e1',
  studentUpn: 'student-a@example.com',
  studentName: 'Student A',
  channel: 'email',
  sentAt: '2026-05-28T00:00:00.000Z',
  source: 'human',
  fieldsAddressed: ['diaryText'],
  content: '<p>...</p>',
  updatedAt: '2026-05-28T00:00:00.000Z',
  formatVersion: 2,
  ...overrides,
});

const decision = (
  overrides: Partial<FeedbackReviewDecisionRecord> = {}
): FeedbackReviewDecisionRecord => ({
  decisionId: 'd1',
  batchId: 'b1',
  classId: 'c1',
  pageId: 'p1',
  entryId: 'e1',
  studentUpn: 'student-a@example.com',
  studentName: 'Student A',
  decision: 'reviewed_no_feedback',
  decidedAt: '2026-06-06T00:00:00.000Z',
  updatedAt: '2026-06-06T00:00:00.000Z',
  ...overrides,
});

const pageEntry = (
  entryId: string,
  date: string,
  weekNumber: string
): HydratedPageEntry => {
  const storedEntry = {
    entryId,
    pageId: 'p1',
    pageTitle: 'Diary',
    classId: 'c1',
    studentName: 'Student A',
    date,
    weekNumber,
    weather: '',
    diaryText: `Entry ${entryId}`,
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
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as StoredDiaryEntry;
  return {
    storedEntry,
    parsedEntry: {
      id: entryId,
      date,
      weather: '',
      weekNumber,
      photoCount: 0,
      diaryText: storedEntry.diaryText,
      peerFeedback: [],
      vocabItems: [],
      vocabCount: 0,
      translations: [],
      translationCount: 0,
      chatbotFeedback: { present: false, data: '' },
    },
  };
};

describe('collapseHydratedPageEntries ordering', () => {
  it('orders a full-year page chronologically, not by lexicographic date string', () => {
    // Dates whose month names sort alphabetically out of chronological order
    // (April, August, December, February...) and week numbers that reset between
    // terms — the exact shape that produced "week 1, 2, 14, 15, 13" rendering.
    const shuffled = [
      pageEntry('e-w14', 'December 3, 2020', '14'),
      pageEntry('e-w1', 'April 24, 2020', '1'),
      pageEntry('e-w15', 'January 14, 2021', '15'),
      pageEntry('e-w2', 'April 30, 2020', '2'),
      pageEntry('e-w13', 'November 26, 2020', '13'),
      pageEntry('e-w3', 'May 7, 2020', '3'),
    ];

    const ordered = collapseHydratedPageEntries(shuffled).map((e) => e.storedEntry.weekNumber);
    expect(ordered).toEqual(['1', '2', '3', '13', '14', '15']);
  });

  it('infers the page year for year-less dates so later weeks do not jump to the front', () => {
    // Date.parse assigns year 2001 to "May 5"/"April 27"; without year inference those
    // later weeks sort before the dated April 2026 entries (the observed scramble).
    const page1 = [
      pageEntry('e1', 'April 15.2026', '1'),
      pageEntry('e2', 'April 19.2026', '2'),
      pageEntry('e3', 'April23.2026', '3'),
      pageEntry('e4', 'May 5', '4'), // no year
    ];
    expect(collapseHydratedPageEntries(page1).map((e) => e.storedEntry.weekNumber)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);

    const page2 = [
      pageEntry('f1', 'April 13, 2026', '1'),
      pageEntry('f2', 'April 16, 2026', '2'),
      pageEntry('f3', 'April 27', '3'), // no year
      pageEntry('f4', 'May 5', '4'), // no year
    ];
    expect(collapseHydratedPageEntries(page2).map((e) => e.storedEntry.weekNumber)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
  });

  it('falls back to week ordering when no entry carries an explicit year', () => {
    const page = [
      pageEntry('g3', 'April 27', '3'),
      pageEntry('g1', 'April 13', '1'),
      pageEntry('g2', 'April 20', '2'),
    ];
    expect(collapseHydratedPageEntries(page).map((e) => e.storedEntry.weekNumber)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('sorts week numbers numerically when dates tie', () => {
    const sameDay = [
      pageEntry('e-b', 'April 24, 2020', '10'),
      pageEntry('e-a', 'April 24, 2020', '2'),
    ];
    const ordered = collapseHydratedPageEntries(sameDay).map((e) => e.storedEntry.weekNumber);
    expect(ordered).toEqual(['2', '10']);
  });
});

describe('sanitizeUserPreferencesWire review focus', () => {
  it('writes only known review-focus string fields, plus the version', () => {
    const prefs = {
      reviewFocus: { vocab: 'Word forms', overall: '', bogus: 'x', diaryText: 5 },
      reviewFocusVersion: 1,
    } as unknown as UserPreferences;
    expect(sanitizeUserPreferencesWire(prefs)).toEqual({
      reviewFocus: { vocab: 'Word forms', overall: '' },
      reviewFocusVersion: 1,
    });
  });
});

describe('sanitizeUserPreferencesWire', () => {
  it('removes explicit undefined values before Firestore preference writes', () => {
    const prefs = {
      ffItemCount: undefined,
      priorFeedbackMode: undefined,
      feedbackTone: 'specific',
      teacherDisplayName: '',
      aiPrompts: {
        diaryText: 'Diary instruction',
        peerFeedback: undefined,
        vocab: 'Vocab instruction',
        translations: undefined,
        overall: 'Overall instruction',
      },
      exportPresets: undefined,
    } as unknown as UserPreferences;

    expect(sanitizeUserPreferencesWire(prefs)).toEqual({
      feedbackTone: 'specific',
      teacherDisplayName: '',
      aiPrompts: {
        diaryText: 'Diary instruction',
        vocab: 'Vocab instruction',
        overall: 'Overall instruction',
      },
    });
  });
});

describe('feedbackHistory wire round-trip (sanitize -> hydrate)', () => {
  it('persists optional batchId for multi-week delivery provenance', () => {
    const wire = sanitizeFeedbackHistoryWire(rec({ batchId: 'batch-123' }));
    expect(wire.batchId).toBe('batch-123');
    expect(hydrateFeedbackHistoryRecord(wire).batchId).toBe('batch-123');
  });

  it('omits batchId from feedback history wire when absent', () => {
    const wire = sanitizeFeedbackHistoryWire(rec());
    expect('batchId' in wire).toBe(false);
  });

  it('persists and reads back send-time analytics metadata', () => {
    const original = rec({
      itemCountSetting: '3-4',
      priorFeedbackMode: 'include',
      recipientResolutionSource: 'roster',
    });
    const wire = sanitizeFeedbackHistoryWire(original);
    // The sanitize boundary must not drop the analytics metadata.
    expect(wire.itemCountSetting).toBe('3-4');
    expect(wire.priorFeedbackMode).toBe('include');
    expect(wire.recipientResolutionSource).toBe('roster');
    const round = hydrateFeedbackHistoryRecord(wire);
    expect(round.itemCountSetting).toBe('3-4');
    expect(round.priorFeedbackMode).toBe('include');
    expect(round.recipientResolutionSource).toBe('roster');
  });

  it('omits the metadata keys from the wire when absent (no undefined writes)', () => {
    const wire = sanitizeFeedbackHistoryWire(rec());
    expect('itemCountSetting' in wire).toBe(false);
    expect('priorFeedbackMode' in wire).toBe(false);
    expect('recipientResolutionSource' in wire).toBe(false);
  });

  it('drops invalid metadata values to undefined on hydrate', () => {
    const round = hydrateFeedbackHistoryRecord({
      ...sanitizeFeedbackHistoryWire(rec()),
      itemCountSetting: 'bogus',
      priorFeedbackMode: 'nonsense',
      recipientResolutionSource: 'somewhere_else',
    });
    expect(round.itemCountSetting).toBeUndefined();
    expect(round.priorFeedbackMode).toBeUndefined();
    expect(round.recipientResolutionSource).toBeUndefined();
  });

  it('preserves the core fields and defaults legacy formatVersion to 1', () => {
    const round = hydrateFeedbackHistoryRecord({
      feedbackId: 'f9',
      classId: 'c9',
      pageId: 'p9',
      entryId: 'e9',
      studentUpn: 's9@example.com',
      studentName: 'S9',
      channel: 'teams',
      sentAt: '2026-05-28T00:00:00.000Z',
      source: 'human',
      fieldsAddressed: ['diaryText', 'overall'],
      content: '<p>hi</p>',
      updatedAt: '2026-05-28T00:00:00.000Z',
      // no formatVersion (legacy)
    });
    expect(round.channel).toBe('teams');
    expect(round.fieldsAddressed).toEqual(['diaryText', 'overall']);
    expect(round.formatVersion).toBe(1);
    expect(round.uptakeObservedAt).toBeNull();
  });
});

describe('feedbackReviewDecisions wire round-trip (sanitize -> hydrate)', () => {
  it('persists reviewed-no-feedback decisions without student-facing content fields', () => {
    const wire = sanitizeFeedbackReviewDecisionWire(decision());
    expect(wire.decisionId).toBe('d1');
    expect(wire.batchId).toBe('b1');
    expect(wire.decision).toBe('reviewed_no_feedback');
    expect('content' in wire).toBe(false);
    expect('channel' in wire).toBe(false);

    const round = hydrateFeedbackReviewDecisionRecord(wire);
    expect(round).toMatchObject({
      decisionId: 'd1',
      batchId: 'b1',
      entryId: 'e1',
      decision: 'reviewed_no_feedback',
    });
  });

  it('omits optional fields when absent', () => {
    const wire = sanitizeFeedbackReviewDecisionWire(
      decision({ batchId: undefined, studentGraphId: undefined })
    );
    expect('batchId' in wire).toBe(false);
    expect('studentGraphId' in wire).toBe(false);
  });
});


describe('feedback provenance', () => {
  const base = {
    feedbackId: 'fb-1', classId: 'c1', pageId: 'p1', entryId: 'e1',
    studentUpn: 'student@example.edu', studentName: 'Student',
    channel: 'email' as const, sentAt: '2026-09-01T00:00:00.000Z',
    source: 'human' as const, fieldsAddressed: ['diaryText'],
    content: '<p>hi</p>', updatedAt: '2026-09-01T00:00:00.000Z',
  };

  it('round-trips the author identity', () => {
    const wire = sanitizeFeedbackHistoryWire({
      ...base,
      authorUpn: 'intern@university.example',
      authorName: 'An Intern',
      authorRole: 'intern',
      authorFirebaseUid: 'firebase-uid-1',
    } as any);
    const record = hydrateFeedbackHistoryRecord(wire);
    expect(record.authorUpn).toBe('intern@university.example');
    expect(record.authorName).toBe('An Intern');
    expect(record.authorRole).toBe('intern');
    expect(record.authorFirebaseUid).toBe('firebase-uid-1');
  });

  it('leaves legacy records unattributed rather than crediting the reader', () => {
    // Records written before provenance existed have no author. Defaulting
    // them to the signed-in user would fabricate an audit trail.
    const record = hydrateFeedbackHistoryRecord({ ...base });
    expect(record.authorUpn).toBeUndefined();
    expect(record.authorName).toBeUndefined();
    expect(record.authorRole).toBeUndefined();
    expect(record.authorFirebaseUid).toBeUndefined();
  });

  it('omits author keys from the wire when unknown', () => {
    // Firestore rules reject unknown/!null shapes; absent is not the same as
    // present-and-empty.
    const wire = sanitizeFeedbackHistoryWire({ ...base } as any);
    expect('authorUpn' in wire).toBe(false);
    expect('authorRole' in wire).toBe(false);
  });

  it('rejects a role outside the known set', () => {
    const record = hydrateFeedbackHistoryRecord({ ...base, authorRole: 'administrator' });
    expect(record.authorRole).toBeUndefined();
  });

  it('records both identities so a mismatch is visible', () => {
    // Microsoft sends the message; Firebase owns the document. They come from
    // unrelated sign-ins, so both are stored deliberately.
    const record = hydrateFeedbackHistoryRecord({
      ...base,
      authorUpn: 'intern@university.example',
      authorFirebaseUid: 'some-other-google-account-uid',
    });
    expect(record.authorUpn).not.toBe(record.authorFirebaseUid);
    expect(record.authorUpn).toBeTruthy();
    expect(record.authorFirebaseUid).toBeTruthy();
  });
});

describe('feedback history wire rejects nothing Firestore would reject', () => {
  const base = {
    feedbackId: 'fb-2', classId: 'c1', pageId: 'p1', entryId: 'e1',
    studentUpn: 's@example.edu', studentName: 'S',
    channel: 'email' as const, sentAt: '2026-09-08T10:45:20.000Z',
    source: 'human' as const, fieldsAddressed: ['diaryText'],
    content: '<p>x</p>', updatedAt: '2026-09-08T10:45:20.000Z',
  };

  const hasUndefinedDeep = (value: unknown): boolean => {
    if (value === undefined) return true;
    if (Array.isArray(value)) return value.some(hasUndefinedDeep);
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some(hasUndefinedDeep);
    }
    return false;
  };

  it('drops a nested undefined instead of failing the whole write', () => {
    // Regression: structuredFeedback.priorExcerpt is set explicitly to
    // undefined when prior-feedback mode is off. Firestore rejects undefined
    // anywhere in a document, so the record was refused *after* the email had
    // already been sent — no history, no author, entry still queued as unsent.
    const wire = sanitizeFeedbackHistoryWire({
      ...base,
      structuredFeedback: { diaryFeedback: 'good', priorExcerpt: undefined } as any,
    } as any);
    expect(hasUndefinedDeep(wire)).toBe(false);
    expect('priorExcerpt' in (wire.structuredFeedback as object)).toBe(false);
    expect((wire.structuredFeedback as any).diaryFeedback).toBe('good');
  });

  it('prunes undefined inside entrySnapshot and its arrays', () => {
    const wire = sanitizeFeedbackHistoryWire({
      ...base,
      entrySnapshot: {
        diaryText: 'hello',
        chatbotFeedback: undefined,
        peerFeedback: [{ contributor: 'A', feedback: 'nice', extra: undefined }],
      } as any,
    } as any);
    expect(hasUndefinedDeep(wire)).toBe(false);
    expect((wire.entrySnapshot as any).diaryText).toBe('hello');
    expect((wire.entrySnapshot as any).peerFeedback[0].contributor).toBe('A');
  });

  it('drops undefined array elements, not just undefined properties', () => {
    // Firestore rejects an undefined element exactly as it rejects an undefined
    // field. Mapping over the array preserved the hole, so a single missing
    // element still failed the whole write after the message had been sent.
    const wire = sanitizeFeedbackHistoryWire({
      ...base,
      entrySnapshot: {
        vocabItems: ['a', undefined, 'b'],
        peerFeedback: [undefined, { contributor: 'A', feedback: 'nice' }],
        translations: [],
      } as any,
    } as any);
    expect(hasUndefinedDeep(wire)).toBe(false);
    expect((wire.entrySnapshot as any).vocabItems).toEqual(['a', 'b']);
    expect((wire.entrySnapshot as any).peerFeedback).toEqual([
      { contributor: 'A', feedback: 'nice' },
    ]);
  });

  it('keeps falsy values that are not undefined', () => {
    // Empty strings, zero and null are real values; only undefined means absent.
    const wire = sanitizeFeedbackHistoryWire({
      ...base,
      structuredFeedback: { diaryFeedback: '', includeDiary: false, count: 0 } as any,
    } as any);
    expect((wire.structuredFeedback as any).diaryFeedback).toBe('');
    expect((wire.structuredFeedback as any).includeDiary).toBe(false);
    expect((wire.structuredFeedback as any).count).toBe(0);
  });
});

describe('class parser config', () => {
  it('keeps the saved or default mode when Gemini is available', () => {
    expect(resolveClassParserConfig(undefined, true)).toEqual({ parserMode: 'ai', templateVersion: 'legacy-ai' });
    expect(resolveClassParserConfig({ parserMode: 'label-first' }, true))
      .toEqual({ parserMode: 'label-first', templateVersion: 'labeled-diary-v1' });
    // A template saved without a mode predates parserMode and belonged to the AI default.
    expect(resolveClassParserConfig({ templateVersion: 'legacy-ai' }, true))
      .toEqual({ parserMode: 'ai', templateVersion: 'legacy-ai' });
  });

  it('runs every class label-first without Gemini, including classes saved as AI', () => {
    // A new hosted user: no saved settings.
    expect(resolveClassParserConfig(undefined, false))
      .toEqual({ parserMode: 'label-first', templateVersion: 'labeled-diary-v1' });
    // A class already saved with the old AI default must not keep the AI template.
    expect(resolveClassParserConfig({ parserMode: 'ai', templateVersion: 'legacy-ai' }, false))
      .toEqual({ parserMode: 'label-first', templateVersion: 'labeled-diary-v1' });
    expect(resolveClassParserConfig({ parserMode: 'label-first', templateVersion: 'labeled-diary-v1' }, false))
      .toEqual({ parserMode: 'label-first', templateVersion: 'labeled-diary-v1' });
  });
});
