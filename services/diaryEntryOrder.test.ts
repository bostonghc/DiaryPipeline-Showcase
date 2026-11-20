import { describe, expect, it } from 'vitest';
import type { ParsedDiaryEntry } from '../types';
import { orderDiaryEntriesForDisplay } from './diaryEntryOrder';

const entry = (id: string, date: string, weekNumber: string): ParsedDiaryEntry => ({
  id, date, weekNumber, weather: '', photoCount: 0, diaryText: `Writing ${id}`,
  peerFeedback: [], vocabItems: [], vocabCount: 0, translations: [], translationCount: 0,
  chatbotFeedback: { present: false, data: '' },
});

describe('diary display order', () => {
  it('orders compact dates and a full-width week by date, keeping IDs and writing attached', () => {
    const entries = [entry('e5', 'May16．2026', '5'), entry('e3', 'April30.2026', '３'), entry('e6', 'May14.2026', '6')];
    const ordered = orderDiaryEntriesForDisplay(entries);
    expect(ordered.map(e => e.id)).toEqual(['e3', 'e6', 'e5']);
    expect(ordered.map(e => e.diaryText)).toEqual(['Writing e3', 'Writing e6', 'Writing e5']);
    expect(entries.map(e => e.id)).toEqual(['e5', 'e3', 'e6']);
    expect(ordered[1].parseWarnings?.join()).toContain('Date/week order disagree:');
    expect(ordered[2].parseWarnings?.join()).toContain('Date/week order disagree:');
  });

  it('sorts ordinal dates with a term week reset and flags the June/week conflict', () => {
    const entries = [
      entry('w10', 'June 21st', '10'), entry('w11', 'June 1st', '11'),
      entry('w7', 'June 3rd', '7'), entry('w13', 'July 15th', '13'),
      entry('t2w1', 'October 8th', '1'), entry('t2w2', 'October 14th', '2'),
    ];
    const ordered = orderDiaryEntriesForDisplay(entries);
    expect(ordered.map(e => e.id)).toEqual(['w11', 'w7', 'w10', 'w13', 't2w1', 't2w2']);
    expect(ordered[0].parseWarnings?.join()).toContain('week 11 (June 1st) comes before week 7 (June 3rd)');
    expect(ordered.find(e => e.id === 't2w1')?.parseWarnings).toBeUndefined();
    expect(orderDiaryEntriesForDisplay(ordered)).toEqual(ordered);
  });

  it('keeps genuine parse warnings and places unknown dates last by week number', () => {
    const earlier = { ...entry('a', 'April 1, 2026', '1'), parseWarnings: ['Missing weather'] };
    const ordered = orderDiaryEntriesForDisplay([entry('u10', '???', '10'), entry('u3', '', '３'), earlier]);
    expect(ordered.map(e => e.id)).toEqual(['a', 'u3', 'u10']);
    expect(ordered[0].parseWarnings).toEqual(['Missing weather']);
  });
});
