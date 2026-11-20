import { describe, expect, it } from 'vitest';
import { dominantYear, parseEntryDate, parseEntryWeek, sortDiaryEntries } from './diaryChronology';

describe('student-written diary dates', () => {
  it.each([
    ['April25,2026', 2026, 3, 25], ['April30.2026', 2026, 3, 30],
    ['May16．2026', 2026, 4, 16], ['July4.2026', 2026, 6, 4],
    ['June 21st', 2026, 5, 21], ['October 19th', 2026, 9, 19],
    ['24,September', 2026, 8, 24], ['SEPTEMBER30', 2026, 8, 30],
    ['Jun,４', 2026, 5, 4], ['October/11', 2026, 9, 11],
    ['October28,2026', 2026, 9, 28], ['２１st June ２０２６', 2026, 5, 21],
  ])('reads %s without changing its text', (raw, year, month, day) => {
    expect(parseEntryDate(raw, 2026)).toBe(new Date(year, month, day).getTime());
  });

  it.each(['February 30, 2026', 'April 31, 2026', '???, 2026', '30', '[DATE]', ''])('leaves %s unparseable', raw => {
    expect(parseEntryDate(raw, 2026)).toBe(Infinity);
  });

  it('infers a full-width explicit year and keeps leap-day validation', () => {
    expect(dominantYear(['April 5, ２０２６', 'April 12'])).toBe(2026);
    expect(parseEntryDate('February 29, 2024')).toBe(new Date(2024, 1, 29).getTime());
    expect(parseEntryDate('February 29, 2026')).toBe(Infinity);
  });

  it('accepts a year-less leap day when the page has no year to borrow', () => {
    expect(parseEntryDate('February 29')).toBe(new Date(2000, 1, 29).getTime());
    expect(parseEntryDate('February 29', 2026)).toBe(Infinity);
  });

  it('compares numeric and English year-less dates on the same year', () => {
    expect(parseEntryDate('4/30')).toBeLessThan(parseEntryDate('May 1'));
    expect(parseEntryDate('4/30')).toBe(new Date(2000, 3, 30).getTime());
    expect(parseEntryDate('2/29')).toBe(new Date(2000, 1, 29).getTime());
    expect(parseEntryDate('4/30', 2026)).toBe(new Date(2026, 3, 30).getTime());
    expect(parseEntryDate('4/30', 2026)).toBeLessThan(parseEntryDate('May 1', 2026));
  });

  it('keeps the year in numeric dates that write it with two or four digits', () => {
    expect(parseEntryDate('4/30/26', 2000)).toBe(new Date(2026, 3, 30).getTime());
    expect(parseEntryDate('4/30/26')).toBe(new Date(2026, 3, 30).getTime());
    expect(parseEntryDate('4/30/2026', 2000)).toBe(new Date(2026, 3, 30).getTime());
    expect(parseEntryDate('2026/04/30', 2000)).toBe(new Date(2026, 3, 30).getTime());
  });

  it.each(['4/30/26', '４／３０／２６', '4-30-26', '4.30.26'])(
    'uses the written year in %s to order neighbouring year-less dates', date => {
      const entries = [{ date: 'May 1' }, { date }, { date: 'April 29' }];
      expect(dominantYear(entries.map(entry => entry.date))).toBe(2026);
      expect(sortDiaryEntries(entries, entry => entry).map(entry => entry.date)).toEqual(['April 29', date, 'May 1']);
    },
  );

  it('keeps two-digit century handling and the existing frequency/tie policy', () => {
    expect(dominantYear(['4/30/99', 'May 1'])).toBe(1999);
    expect(dominantYear(['4/30/26', '5/1/26', 'April 1, 2025'])).toBe(2026);
    expect(dominantYear(['4/30/26', 'April 1, 2025'])).toBe(2025);
    expect(dominantYear(['4/30', '???, 26', '2/30/26'])).toBeNull();
  });

  it('sorts a page of mixed numeric and English dates with no explicit year', () => {
    const entries = [{ date: 'May 1' }, { date: '4/30' }, { date: 'April 29' }, { date: '5/2' }];
    expect(sortDiaryEntries(entries, entry => entry).map(entry => entry.date)).toEqual([
      'April 29', '4/30', 'May 1', '5/2',
    ]);
  });

  it('still reads ISO dates now that the guard no longer special-cases them', () => {
    expect(Number.isFinite(parseEntryDate('2026-04-30'))).toBe(true);
  });

  it('reads full-width and prefixed week numbers', () => {
    expect(parseEntryWeek('３')).toBe(3);
    expect(parseEntryWeek('Week １０')).toBe(10);
    expect(parseEntryWeek('week3')).toBe(3);
    expect(parseEntryWeek('[WEEK]')).toBe(Infinity);
  });

  it('orders entries with equal date and week by entryId, whatever the input order', () => {
    const tied = [
      { entryId: 'c', date: 'N/A' }, { entryId: 'a', date: 'N/A' }, { entryId: 'b', date: 'N/A' },
    ];
    const expected = ['a', 'b', 'c'];
    expect(sortDiaryEntries(tied, entry => entry).map(entry => entry.entryId)).toEqual(expected);
    expect(sortDiaryEntries([...tied].reverse(), entry => entry).map(entry => entry.entryId)).toEqual(expected);
  });

  it('keeps input order for tied entries that carry no entryId', () => {
    const tied = [{ date: 'N/A', n: 2 }, { date: 'N/A', n: 1 }];
    expect(sortDiaryEntries(tied, entry => entry).map(entry => entry.n)).toEqual([2, 1]);
  });

  it('infers years per page rather than borrowing a different class year', () => {
    const entries = [
      { pageId: 'old', date: 'May 5', weekNumber: '2' },
      { pageId: 'new', date: 'April 1, 2026', weekNumber: '1' },
      { pageId: 'old', date: 'April 24, 2020', weekNumber: '1' },
    ];
    expect(sortDiaryEntries(entries, entry => entry).map(entry => entry.date)).toEqual([
      'April 24, 2020', 'May 5', 'April 1, 2026',
    ]);
  });

  it('does not borrow a two-digit year across pages', () => {
    const entries = [
      { pageId: 'new', date: 'May 1' }, { pageId: 'old', date: 'May 1' },
      { pageId: 'new', date: '4/30/26' }, { pageId: 'old', date: '4/30/20' },
    ];
    expect(sortDiaryEntries(entries, entry => entry).map(entry => `${entry.pageId}:${entry.date}`)).toEqual([
      'old:4/30/20', 'old:May 1', 'new:4/30/26', 'new:May 1',
    ]);
  });
});
