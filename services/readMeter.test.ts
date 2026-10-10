import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRead,
  getReadTotals,
  resetReadMeter,
  formatReadSummary,
} from './readMeter';

beforeEach(() => {
  resetReadMeter();
});

describe('readMeter', () => {
  it('accumulates total and per-label counts', () => {
    recordRead('entries:page', 30);
    recordRead('pageRecord:get', 1);
    recordRead('entries:page', 5);

    const totals = getReadTotals();
    expect(totals.total).toBe(36);
    expect(totals.byLabel).toEqual({ 'entries:page': 35, 'pageRecord:get': 1 });
  });

  it('ignores non-positive and non-finite counts', () => {
    recordRead('x', 0);
    recordRead('x', -4);
    recordRead('x', Number.NaN);
    recordRead('x', Number.POSITIVE_INFINITY);
    expect(getReadTotals().total).toBe(0);
    expect(getReadTotals().byLabel).toEqual({});
  });

  it('reset zeroes the counters and restarts the window', () => {
    recordRead('a', 10);
    const before = getReadTotals().startedAt;
    resetReadMeter();
    const after = getReadTotals();
    expect(after.total).toBe(0);
    expect(after.byLabel).toEqual({});
    expect(after.startedAt).toBeGreaterThanOrEqual(before);
    expect(after.sinceMs).toBeGreaterThanOrEqual(0);
  });

  it('getReadTotals returns a copy of byLabel (mutation does not leak)', () => {
    recordRead('a', 1);
    const snapshot = getReadTotals();
    snapshot.byLabel['a'] = 999;
    expect(getReadTotals().byLabel.a).toBe(1);
  });

  it('formatReadSummary reports the total, a window line, and labels sorted by count', () => {
    recordRead('small', 2);
    recordRead('big', 100);
    const summary = formatReadSummary();
    expect(summary).toContain('Firestore reads counted: 102');
    expect(summary).toContain('Window: since');
    // Highest-count label appears before the lower one.
    expect(summary.indexOf('big')).toBeLessThan(summary.indexOf('small'));
  });
});
