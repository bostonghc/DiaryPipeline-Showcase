import { describe, it, expect } from 'vitest';
import {
  uptakeRate,
  fieldCoverage,
  itemCountDistribution,
  priorFeedbackModeDistribution,
  studentLongitudinal,
} from './dashboardDataService';
import type { FeedbackHistoryRecord } from '../types';

const rec = (overrides: Partial<FeedbackHistoryRecord> = {}): FeedbackHistoryRecord => ({
  feedbackId: 'f1',
  classId: 'c1',
  pageId: 'p1',
  entryId: 'e1',
  studentUpn: 'student-a@example.com',
  studentName: 'Student A',
  channel: 'email',
  sentAt: '2026-05-01T00:00:00.000Z',
  source: 'human',
  fieldsAddressed: ['diaryText'],
  content: '<p>...</p>',
  updatedAt: '2026-05-01T00:00:00.000Z',
  formatVersion: 2,
  ...overrides,
});

describe('uptakeRate', () => {
  it('returns 0 rate for an empty set without dividing by zero', () => {
    expect(uptakeRate([])).toEqual({ total: 0, observed: 0, rate: 0 });
  });

  it('counts only records with a non-null uptakeObservedAt', () => {
    const records = [
      rec({ feedbackId: 'a', uptakeObservedAt: '2026-05-10T00:00:00.000Z' }),
      rec({ feedbackId: 'b', uptakeObservedAt: null }),
      rec({ feedbackId: 'c' }), // undefined
      rec({ feedbackId: 'd', uptakeObservedAt: '2026-05-11T00:00:00.000Z' }),
    ];
    expect(uptakeRate(records)).toEqual({ total: 4, observed: 2, rate: 0.5 });
  });
});

describe('fieldCoverage', () => {
  it('tallies how often each field was addressed across records', () => {
    const records = [
      rec({ fieldsAddressed: ['diaryText', 'vocab'] }),
      rec({ fieldsAddressed: ['diaryText', 'overall'] }),
      rec({ fieldsAddressed: [] }),
    ];
    expect(fieldCoverage(records)).toEqual({ diaryText: 2, vocab: 1, overall: 1 });
  });
});

describe('itemCountDistribution', () => {
  it('buckets by itemCountSetting and labels missing values as unknown', () => {
    const records = [
      rec({ itemCountSetting: '3-4' }),
      rec({ itemCountSetting: '3-4' }),
      rec({ itemCountSetting: '1-2' }),
      rec({}), // no setting
    ];
    expect(itemCountDistribution(records)).toEqual({ '3-4': 2, '1-2': 1, unknown: 1 });
  });
});

describe('priorFeedbackModeDistribution', () => {
  it('buckets by priorFeedbackMode and labels missing values as unknown', () => {
    const records = [
      rec({ priorFeedbackMode: 'off' }),
      rec({ priorFeedbackMode: 'include' }),
      rec({ priorFeedbackMode: 'include' }),
      rec({}),
    ];
    expect(priorFeedbackModeDistribution(records)).toEqual({
      off: 1,
      include: 2,
      unknown: 1,
    });
  });
});

describe('studentLongitudinal', () => {
  it('filters to one student and orders chronologically by sentAt', () => {
    const records = [
      rec({ feedbackId: 'later', studentUpn: 'a@x.com', sentAt: '2026-05-20T00:00:00.000Z' }),
      rec({ feedbackId: 'other', studentUpn: 'b@x.com', sentAt: '2026-05-15T00:00:00.000Z' }),
      rec({
        feedbackId: 'earlier',
        studentUpn: 'a@x.com',
        sentAt: '2026-05-10T00:00:00.000Z',
        uptakeObservedAt: '2026-05-12T00:00:00.000Z',
        fieldsAddressed: ['diaryText', 'vocab'],
      }),
    ];
    const timeline = studentLongitudinal(records, 'a@x.com');
    expect(timeline.map((p) => p.feedbackId)).toEqual(['earlier', 'later']);
    expect(timeline[0]).toEqual({
      feedbackId: 'earlier',
      sentAt: '2026-05-10T00:00:00.000Z',
      fieldsAddressed: ['diaryText', 'vocab'],
      uptakeObserved: true,
    });
    expect(timeline[1].uptakeObserved).toBe(false);
  });

  it('returns an empty timeline for an unknown student', () => {
    expect(studentLongitudinal([rec()], 'nobody@x.com')).toEqual([]);
  });
});
