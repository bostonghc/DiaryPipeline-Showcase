import { describe, expect, it } from 'vitest';
import type { EducationClass } from '../types';
import {
  filterRoster,
  groupHeadings,
  normalizeRosterSearch,
  orderRoster,
  OTHER_GROUP_LABEL,
  SAVED_GROUP_LABEL,
} from './classRosterView';

const cls = (displayName: string, extra: Partial<EducationClass> = {}): EducationClass => ({
  id: displayName, displayName, description: '', accessStatus: 'accessible', rosterStatus: 'discovered', ...extra,
});
const names = (list: EducationClass[]) => list.map(item => item.displayName);

describe('orderRoster', () => {
  it('puts the saved working set first, then natural alphanumeric order', () => {
    const list = [cls('Reading 10'), cls('Reading 2'), cls('Writing', { rosterStatus: 'saved' }), cls('Art', { rosterStatus: 'saved' })];
    expect(names(orderRoster(list, false))).toEqual(['Art', 'Writing', 'Reading 2', 'Reading 10']);
  });

  it('hides classes the person cannot open unless showing all', () => {
    const list = [cls('Open'), cls('Locked', { accessStatus: 'inaccessible' }), cls('Unknown', { accessStatus: 'unknown' })];
    expect(names(orderRoster(list, false))).toEqual(['Open']);
    expect(names(orderRoster(list, true))).toEqual(['Locked', 'Open', 'Unknown']);
  });

  it('does not reorder the list it was given', () => {
    const list = [cls('B'), cls('A')];
    orderRoster(list, true);
    expect(names(list)).toEqual(['B', 'A']);
  });
});

describe('filterRoster', () => {
  const list = [cls('Reading 3 (Thursday)'), cls('Writing 1 (Monday)'), cls('ＪＡＬＴ Seminar')];

  it('returns everything for an empty or blank query', () => {
    expect(filterRoster(list, '')).toBe(list);
    expect(filterRoster(list, '   ')).toBe(list);
  });

  it('matches case-insensitively and by any part of the name', () => {
    expect(names(filterRoster(list, 'THURS'))).toEqual(['Reading 3 (Thursday)']);
  });

  it('requires every typed word, in any order', () => {
    expect(names(filterRoster(list, 'thu read'))).toEqual(['Reading 3 (Thursday)']);
    expect(names(filterRoster(list, 'read mon'))).toEqual([]);
  });

  it('treats full-width and half-width characters as the same', () => {
    expect(names(filterRoster(list, 'jalt'))).toEqual(['ＪＡＬＴ Seminar']);
    expect(names(filterRoster([cls('Reading ３')], 'reading 3'))).toEqual(['Reading ３']);
  });

  it('ignores extra spacing', () => {
    expect(names(filterRoster(list, '  reading    3 '))).toEqual(['Reading 3 (Thursday)']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterRoster(list, 'zzz')).toEqual([]);
  });
});

describe('normalizeRosterSearch', () => {
  it('folds case, width and whitespace', () => {
    expect(normalizeRosterSearch('  ＲＥＡＤ　ing  ')).toBe('read ing');
  });
});

describe('groupHeadings', () => {
  it('labels the first class of each group when both groups are present', () => {
    const list = [cls('A', { rosterStatus: 'saved' }), cls('B', { rosterStatus: 'saved' }), cls('C'), cls('D')];
    expect(groupHeadings(list)).toEqual([SAVED_GROUP_LABEL, null, OTHER_GROUP_LABEL, null]);
  });

  it('adds no headings when the list is all one kind or empty', () => {
    expect(groupHeadings([cls('A'), cls('B')])).toEqual([null, null]);
    expect(groupHeadings([cls('A', { rosterStatus: 'saved' })])).toEqual([null]);
    expect(groupHeadings([])).toEqual([]);
  });
});
