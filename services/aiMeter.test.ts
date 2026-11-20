import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatAiSummary,
  getAiTotals,
  recordAiAttempt,
  recordAiOutcome,
  resetAiMeter,
} from './aiMeter';

beforeEach(() => {
  resetAiMeter();
});

describe('aiMeter', () => {
  it('accumulates Gemini attempts by purpose and model', () => {
    recordAiAttempt('gemini:parse:pass1', 'gemini-2.5-flash');
    recordAiAttempt('gemini:parse:pass1', 'gemini-2.5-flash');
    recordAiAttempt('gemini:feedback-draft', 'gemini-2.5-flash-lite');

    const totals = getAiTotals();
    expect(totals.totalAttempts).toBe(3);
    expect(totals.byPurpose).toEqual({
      'gemini:parse:pass1': 2,
      'gemini:feedback-draft': 1,
    });
    expect(totals.byModel).toEqual({
      'gemini-2.5-flash': 2,
      'gemini-2.5-flash-lite': 1,
    });
  });

  it('accumulates outcomes separately from attempts', () => {
    recordAiAttempt('gemini:analysis', 'gemini-2.5-flash');
    recordAiOutcome('rate_limited', {
      purpose: 'gemini:analysis',
      model: 'gemini-2.5-flash',
      error: new Error('RESOURCE_EXHAUSTED'),
    });
    recordAiAttempt('gemini:analysis', 'gemini-2.5-flash');
    recordAiOutcome('succeeded');

    const totals = getAiTotals();
    expect(totals.totalAttempts).toBe(2);
    expect(totals.byOutcome).toEqual({
      rate_limited: 1,
      succeeded: 1,
    });
    expect(totals.errorSamples).toHaveLength(1);
    expect(totals.errorSamples[0]).toMatchObject({
      purpose: 'gemini:analysis',
      model: 'gemini-2.5-flash',
      outcome: 'rate_limited',
    });
  });

  it('reset zeroes the counters and restarts the window', () => {
    recordAiAttempt('gemini:parse:pass2', 'gemini-2.5-flash');
    recordAiOutcome('failed');
    const before = getAiTotals().startedAt;

    resetAiMeter();

    const after = getAiTotals();
    expect(after.totalAttempts).toBe(0);
    expect(after.byPurpose).toEqual({});
    expect(after.byModel).toEqual({});
    expect(after.byOutcome).toEqual({});
    expect(after.errorSamples).toEqual([]);
    expect(after.startedAt).toBeGreaterThanOrEqual(before);
    expect(after.sinceMs).toBeGreaterThanOrEqual(0);
  });

  it('getAiTotals returns copies of breakdown maps', () => {
    recordAiAttempt('gemini:feedback-draft', 'gemini-2.5-flash-lite');
    recordAiOutcome('succeeded');

    const snapshot = getAiTotals();
    snapshot.byPurpose['gemini:feedback-draft'] = 999;
    snapshot.byModel['gemini-2.5-flash-lite'] = 999;
    snapshot.byOutcome.succeeded = 999;
    snapshot.errorSamples.push({
      at: 'bad',
      purpose: 'gemini:analysis',
      model: 'bad',
      outcome: 'failed',
      message: 'bad',
    });

    const next = getAiTotals();
    expect(next.byPurpose['gemini:feedback-draft']).toBe(1);
    expect(next.byModel['gemini-2.5-flash-lite']).toBe(1);
    expect(next.byOutcome.succeeded).toBe(1);
    expect(next.errorSamples).toEqual([]);
  });

  it('formatAiSummary reports total, window, and sorted sections', () => {
    recordAiAttempt('gemini:feedback-draft', 'gemini-2.5-flash-lite');
    recordAiAttempt('gemini:parse:pass1', 'gemini-2.5-flash');
    recordAiAttempt('gemini:parse:pass1', 'gemini-2.5-flash');
    recordAiOutcome('succeeded');
    recordAiOutcome('rate_limited');

    const summary = formatAiSummary();

    expect(summary).toContain('Gemini calls counted: 3');
    expect(summary).toContain('Window: since');
    expect(summary).toContain('By purpose:');
    expect(summary).toContain('By model:');
    expect(summary).toContain('By outcome:');
    expect(summary).toContain('Recent provider errors:');
    expect(summary.indexOf('gemini:parse:pass1')).toBeLessThan(summary.indexOf('gemini:feedback-draft'));
  });

  it('formatAiSummary reports empty sections before any calls', () => {
    const summary = formatAiSummary();
    expect(summary).toContain('Gemini calls counted: 0');
    expect(summary).toContain('  0  none');
  });

  it('formatAiSummary includes sanitized recent provider errors', () => {
    recordAiAttempt('gemini:feedback-draft', 'gemini-2.5-flash-lite');
    recordAiOutcome('billing_or_project_restricted', {
      purpose: 'gemini:feedback-draft',
      model: 'gemini-2.5-flash-lite',
      error: new Error('Prepay required for key=AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY and Bearer abc.def.ghi'),
    });

    const summary = formatAiSummary();

    expect(summary).toContain('billing_or_project_restricted');
    expect(summary).toContain('Prepay required');
    expect(summary).toContain('key=[redacted-api-key]');
    expect(summary).toContain('Bearer [redacted-token]');
    expect(summary).not.toContain('AIzaSyDUMMY');
    expect(summary).not.toContain('abc.def.ghi');
  });
});
