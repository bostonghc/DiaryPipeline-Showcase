import { describe, expect, it } from 'vitest';
import type { ParsedDiaryEntry } from '../types';
import {
  BULK_READY_MIN_DIARY_CHARS,
  getEntryWorkflowLabel,
  getEntryWorkflowUiState,
  getReadyEligibility,
  getWorkflowSummaryClassName,
  getWorkflowSummaryLabel,
  getWorkflowSummaryTooltip,
  hasTeacherFeedbackChanges,
  hasStudentDiaryWriting,
  selectBulkReadyEntries,
  summarizePageWorkflow,
} from './feedbackWorkflowService';

const entry = (diaryText: string, id = diaryText.slice(0, 8)): ParsedDiaryEntry => ({
  id,
  date: '',
  weather: '',
  weekNumber: '',
  photoCount: 0,
  diaryText,
  peerFeedback: [],
  vocabItems: [],
  vocabCount: 0,
  translations: [],
  translationCount: 0,
  chatbotFeedback: { present: false, data: '' },
});

describe('feedback workflow labels', () => {
  it('maps the persisted approved wire value to teacher-facing Feedback Ready', () => {
    expect(getEntryWorkflowUiState('approved')).toBe('ready');
    expect(getEntryWorkflowLabel('ready')).toBe('Feedback Ready');
    expect(getEntryWorkflowUiState('draft')).toBe('draft');
    expect(getEntryWorkflowUiState('reviewed')).toBe('draft');
    expect(getEntryWorkflowUiState(undefined)).toBe('draft');
  });

  it('shows unsaved changes before the persisted status label', () => {
    const current = { diaryText: 'Try using past tense here.' };
    const saved = { diaryText: 'Try using present tense here.' };

    expect(getEntryWorkflowUiState('approved', current, saved)).toBe('unsaved');
    expect(getEntryWorkflowLabel('unsaved')).toBe('Unsaved Changes');
  });

  it('treats whitespace-only feedback differences as unchanged', () => {
    expect(
      hasTeacherFeedbackChanges(
        { diaryText: '  Good idea.\nTry one tense. ' },
        { diaryText: 'Good idea. Try one tense.' }
      )
    ).toBe(false);
  });
});

describe('bulk ready eligibility', () => {
  it('requires deterministic diary writing rather than metadata-only entries', () => {
    expect(hasStudentDiaryWriting(entry(''))).toBe(false);
    expect(hasStudentDiaryWriting(entry('April 24, 2020'))).toBe(false);
    expect(hasStudentDiaryWriting(entry('x'.repeat(BULK_READY_MIN_DIARY_CHARS)))).toBe(true);
  });

  it('normalizes whitespace before applying the diary text threshold', () => {
    const spaced = `  ${'word '.repeat(8)}  `;
    expect(hasStudentDiaryWriting(entry(spaced))).toBe(true);
  });

  it('selects only entries with enough diary text for Mark All Ready', () => {
    const first = entry('Today I wrote enough diary text for the teacher to review.', 'ready');
    const second = entry('', 'empty');
    const third = entry('Short', 'short');

    expect(selectBulkReadyEntries([first, second, third])).toEqual({
      ready: [{ entry: first, index: 0 }],
      skipped: [
        { entry: second, index: 1 },
        { entry: third, index: 2 },
      ],
    });
  });

  it('uses stricter bulk rules than individual ready override', () => {
    const vocabOnly = {
      ...entry('', 'vocab'),
      vocabItems: [{ wordOrPhrase: 'architecture' }],
      vocabCount: 1,
    };
    const metadataOnly = {
      ...entry('', 'meta'),
      date: 'April 24, 2020',
      weekNumber: '1',
    };

    expect(selectBulkReadyEntries([vocabOnly]).ready).toHaveLength(0);
    expect(getReadyEligibility(vocabOnly)).toBe('needs_override');
    expect(getReadyEligibility(metadataOnly)).toBe('blocked');
    expect(getReadyEligibility(metadataOnly, { overall: 'Please add the diary text next time.' })).toBe('needs_override');
  });
});

describe('page workflow summary', () => {
  const a = entry('Today I wrote a sentence.', 'a');
  const b = entry('Another diary entry here.', 'b');
  const c = entry('Third diary entry text.', 'c');

  it('returns null for empty pages', () => {
    expect(summarizePageWorkflow(null, {}, {}, {}, new Set())).toBeNull();
    expect(summarizePageWorkflow([], {}, {}, {}, new Set())).toBeNull();
  });

  it('classifies entries by workflow state and sent membership', () => {
    const summary = summarizePageWorkflow(
      [a, b, c],
      { a: 'approved', b: 'approved', c: 'draft' },
      {},
      {},
      new Set(['a'])
    );
    expect(summary).toEqual({ total: 3, sent: 1, ready: 1, unsaved: 0, draft: 1 });
  });

  it('treats unsaved changes as unsaved even when the persisted status is approved', () => {
    const summary = summarizePageWorkflow(
      [a],
      { a: 'approved' },
      { a: { diaryText: 'new wording' } },
      { a: { diaryText: 'old wording' } },
      new Set(['a'])
    );
    expect(summary).toEqual({ total: 1, sent: 0, ready: 0, unsaved: 1, draft: 0 });
  });

  it('labels and styles the summary by the dominant state', () => {
    expect(getWorkflowSummaryLabel({ total: 3, sent: 1, ready: 1, unsaved: 0, draft: 1 }))
      .toBe('1 sent · 1 ready · 1 draft');
    expect(getWorkflowSummaryLabel({ total: 2, sent: 0, ready: 0, unsaved: 0, draft: 0 }))
      .toBe('2 entries');

    expect(getWorkflowSummaryClassName({ total: 1, sent: 0, ready: 0, unsaved: 1, draft: 0 }))
      .toContain('amber');
    expect(getWorkflowSummaryClassName({ total: 2, sent: 1, ready: 0, unsaved: 0, draft: 1 }))
      .toContain('indigo');
    expect(getWorkflowSummaryClassName({ total: 1, sent: 0, ready: 0, unsaved: 0, draft: 1 }))
      .toContain('slate');
    expect(getWorkflowSummaryClassName({ total: 1, sent: 1, ready: 0, unsaved: 0, draft: 0 }))
      .toContain('emerald');

    expect(getWorkflowSummaryTooltip({ total: 3, sent: 1, ready: 1, unsaved: 0, draft: 1 }))
      .toBe('3 entries on this page: 1 sent, 1 ready to send, 0 unsaved, 1 draft.');
  });
});
