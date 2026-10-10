import type { FeedbackHistoryRecord } from '../types';

/**
 * Pure aggregation functions over feedbackHistory records, for the planned
 * Class Dashboard. Every function takes a plain array and returns a plain
 * object — no Firestore access here, so callers fetch/scope the records and
 * these stay trivially unit-testable (see dashboardDataService.test.ts).
 *
 * AI-reliance aggregation is intentionally absent: per-field source provenance
 * (`sourcePerField`) is deferred until the feedback field model is reconciled,
 * so `source` is currently uniform and would aggregate nothing meaningful.
 */

export interface UptakeSummary {
  total: number;
  observed: number;
  /** observed / total, or 0 when there are no records. */
  rate: number;
}

/** Fraction of sent feedback the teacher has marked as acted upon. */
export const uptakeRate = (records: FeedbackHistoryRecord[]): UptakeSummary => {
  const total = records.length;
  const observed = records.filter((r) => r.uptakeObservedAt != null).length;
  return { total, observed, rate: total === 0 ? 0 : observed / total };
};

/** How many records addressed each feedback field (diaryText, vocab, overall, …). */
export const fieldCoverage = (
  records: FeedbackHistoryRecord[]
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const r of records) {
    for (const field of r.fieldsAddressed ?? []) {
      counts[field] = (counts[field] ?? 0) + 1;
    }
  }
  return counts;
};

/** Distribution of the FF item-count setting in force at send time. */
export const itemCountDistribution = (
  records: FeedbackHistoryRecord[]
): Record<string, number> => {
  const dist: Record<string, number> = {};
  for (const r of records) {
    const key = r.itemCountSetting ?? 'unknown';
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return dist;
};

/** Distribution of the prior-feedback mode in force at send time. */
export const priorFeedbackModeDistribution = (
  records: FeedbackHistoryRecord[]
): Record<string, number> => {
  const dist: Record<string, number> = {};
  for (const r of records) {
    const key = r.priorFeedbackMode ?? 'unknown';
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return dist;
};

export interface LongitudinalPoint {
  feedbackId: string;
  sentAt: string;
  fieldsAddressed: string[];
  uptakeObserved: boolean;
}

/** Chronological feedback timeline for one student (ISO sentAt sorts naturally). */
export const studentLongitudinal = (
  records: FeedbackHistoryRecord[],
  studentUpn: string
): LongitudinalPoint[] =>
  records
    .filter((r) => r.studentUpn === studentUpn)
    .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
    .map((r) => ({
      feedbackId: r.feedbackId,
      sentAt: r.sentAt,
      fieldsAddressed: r.fieldsAddressed ?? [],
      uptakeObserved: r.uptakeObservedAt != null,
    }));
