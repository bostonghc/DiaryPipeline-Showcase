import { describe, expect, it } from 'vitest';
import type { ParsedDiaryEntry } from '../types';
import { aiReviewIdsField, findEntryByKey, getEntryKey } from './useFeedbackComposition';
import { hydrateFeedbackHistoryRecord, sanitizeFeedbackHistoryWire } from '../services/firestoreDataService';
import type { FeedbackHistoryRecord } from '../types';

const entry = (fields: Partial<ParsedDiaryEntry>): ParsedDiaryEntry =>
  fields as ParsedDiaryEntry;

describe('getEntryKey', () => {
  it('uses the id when there is one', () => {
    expect(getEntryKey(entry({ id: 'abc' }), 3)).toBe('abc');
  });

  it('falls back to the index when the entry has no id', () => {
    expect(getEntryKey(entry({}), 3)).toBe('3');
    expect(getEntryKey(entry({ id: '' }), 0)).toBe('0');
  });
});

describe('findEntryByKey — the lookup reviewAndSend uses', () => {
  it('finds an entry addressed by its id', () => {
    const entries = [
      entry({ id: 'a', weekNumber: '5' }),
      entry({ id: 'b', weekNumber: '6' }),
    ];
    expect(findEntryByKey(entries, 'b')?.weekNumber).toBe('6');
  });

  it('finds an id-less entry by its index key', () => {
    // Regression: reviewAndSend used find(e => e.id === entryId), which cannot
    // match an entry the UI addresses as "1" because it has no id at all. The
    // send silently returned and nothing opened.
    const entries = [entry({ id: 'a' }), entry({ weekNumber: '6' })];
    expect(findEntryByKey(entries, 'b')).toBeNull();
    expect(findEntryByKey(entries, '1')?.weekNumber).toBe('6');
  });

  it('does not mistake an index key for a later entry that owns that id', () => {
    // The sharp case: entry 0 has no id so its key is "0", while a *different*
    // entry literally carries the id "0". Key order must win, or the drafts of
    // one entry are compiled against the other's date and the review notice
    // names the wrong week — the one field the modal never previews.
    const entries = [
      entry({ weekNumber: '6', date: 'May 28, 2020' }),
      entry({ id: '0', weekNumber: '7', date: 'June 4, 2020' }),
    ];
    const found = findEntryByKey(entries, '0');
    expect(found?.weekNumber).toBe('6');
    expect(found?.date).toBe('May 28, 2020');
  });

  it('resolves duplicate ids to the first match, as find did', () => {
    // App.tsx has ensureUniqueEntryIds because duplicates do occur upstream.
    // Behaviour here is not better than find() — it is deliberately identical,
    // so the fix changed only which key is compared, not which entry wins.
    const entries = [
      entry({ id: 'dup', weekNumber: '6' }),
      entry({ id: 'dup', weekNumber: '7' }),
    ];
    expect(findEntryByKey(entries, 'dup')?.weekNumber).toBe('6');
  });

  it('returns null rather than a wrong entry when nothing matches', () => {
    expect(findEntryByKey([entry({ id: 'a' })], 'missing')).toBeNull();
    expect(findEntryByKey([], '0')).toBeNull();
  });

  it('agrees with getEntryKey for every entry in a mixed list', () => {
    const entries = [
      entry({ weekNumber: '5' }),
      entry({ id: 'x', weekNumber: '6' }),
      entry({ id: '', weekNumber: '7' }),
    ];
    entries.forEach((item, index) => {
      expect(findEntryByKey(entries, getEntryKey(item, index))).toBe(item);
    });
  });
});

describe('aiReviewIdsField — link from sent feedback to the reviews used', () => {
  it('omits the field when there are no reviews', () => {
    expect(aiReviewIdsField([])).toEqual({});
    expect(aiReviewIdsField(undefined)).toEqual({});
  });

  it('includes the ids, capped at 20', () => {
    expect(aiReviewIdsField(['a', 'b'])).toEqual({ aiReviewIds: ['a', 'b'], aiReviewIdsOmitted: 0 });
    const many = Array.from({ length: 25 }, (_, i) => `r${i}`);
    expect(aiReviewIdsField(many).aiReviewIds).toHaveLength(20);
  });

  it('reports omitted ids explicitly, including overflow beyond the cap', () => {
    expect(aiReviewIdsField(['a'], 1)).toEqual({ aiReviewIds: ['a'], aiReviewIdsOmitted: 1 });
    expect(aiReviewIdsField(['a'], 0)).toEqual({ aiReviewIds: ['a'], aiReviewIdsOmitted: 0 });
    const many = Array.from({ length: 22 }, (_, i) => `r${i}`);
    expect(aiReviewIdsField(many, 1)).toMatchObject({ aiReviewIdsOmitted: 3 });
    expect(aiReviewIdsField([], 2)).toEqual({ aiReviewIdsOmitted: 2 });
  });

  it('aiReviewIdsOmitted round-trips through the wire and hydration', () => {
    const record = {
      feedbackId: 'f1', classId: 'c', pageId: 'p', entryId: 'e', studentUpn: 's@x', studentName: 'S',
      channel: 'email', sentAt: 't', source: 'human', fieldsAddressed: [], content: '', updatedAt: 't',
      formatVersion: 1, ...aiReviewIdsField(['r1'], 2),
    } as FeedbackHistoryRecord;
    const wire = sanitizeFeedbackHistoryWire(record);
    expect(wire.aiReviewIdsOmitted).toBe(2);
    expect(sanitizeFeedbackHistoryWire({ ...record, aiReviewIdsOmitted: 0 }).aiReviewIdsOmitted).toBe(0);
    expect('aiReviewIdsOmitted' in sanitizeFeedbackHistoryWire({ ...record, aiReviewIdsOmitted: -1 })).toBe(false);
    expect('aiReviewIdsOmitted' in sanitizeFeedbackHistoryWire({ ...record, aiReviewIdsOmitted: 1.5 })).toBe(false);
    expect(hydrateFeedbackHistoryRecord({ ...wire }).aiReviewIdsOmitted).toBe(2);
    expect(hydrateFeedbackHistoryRecord({ ...wire, aiReviewIdsOmitted: 0 }).aiReviewIdsOmitted).toBe(0);
  });

  it('older records without aiReviewIdsOmitted hydrate to zero', () => {
    const { aiReviewIdsOmitted: _omit, ...legacy } = sanitizeFeedbackHistoryWire({
      feedbackId: 'f0', classId: 'c', pageId: 'p', entryId: 'e', studentUpn: 's@x', studentName: 'S',
      channel: 'email', sentAt: 't', source: 'human', fieldsAddressed: [], content: '', updatedAt: 't',
      formatVersion: 1,
    } as FeedbackHistoryRecord);
    expect(hydrateFeedbackHistoryRecord(legacy).aiReviewIdsOmitted).toBe(0);
  });

  it('a sent record with review links records an explicit zero omitted count', () => {
    expect(aiReviewIdsField(['a'])).toEqual({ aiReviewIds: ['a'], aiReviewIdsOmitted: 0 });
    expect(aiReviewIdsField([])).toEqual({});
  });

  it('a sent record carries aiReviewIds to the wire while source stays human', () => {
    const record = {
      feedbackId: 'f1', classId: 'c', pageId: 'p', entryId: 'e', studentUpn: 's@x', studentName: 'S',
      channel: 'email', sentAt: 't', source: 'human', fieldsAddressed: [], content: '', updatedAt: 't',
      formatVersion: 1, ...aiReviewIdsField(['r1']),
    } as FeedbackHistoryRecord;
    const wire = sanitizeFeedbackHistoryWire(record);
    expect(wire.source).toBe('human');
    expect(wire.aiReviewIds).toEqual(['r1']);
    expect('aiReviewIds' in sanitizeFeedbackHistoryWire({ ...record, aiReviewIds: undefined })).toBe(false);
  });
});
