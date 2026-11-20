import type { EducationClass } from '../types';

/** Case-, width- and spacing-insensitive form used to match class names. */
export const normalizeRosterSearch = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export const isSavedClass = (cls: EducationClass): boolean => cls.rosterStatus === 'saved';

/**
 * Roster order was once whatever order Graph returned at discovery time, so a
 * re-discovery could silently reshuffle the list. Sort explicitly: the saved
 * working set first, then natural alphanumeric order ("Class 2" before "Class 10").
 * Unless `includeUnavailable` is set, classes whose access is not confirmed (no
 * access, deferred or unknown) are left out. That is about access only; it has
 * nothing to do with saved versus discovered.
 */
export const orderRoster = (classes: EducationClass[], includeUnavailable: boolean): EducationClass[] =>
  classes
    .filter(cls => includeUnavailable || cls.accessStatus === 'accessible')
    .sort((a, b) => {
      const aSaved = isSavedClass(a) ? 0 : 1;
      const bSaved = isSavedClass(b) ? 0 : 1;
      if (aSaved !== bSaved) return aSaved - bSaved;
      return (a.displayName || '').localeCompare(b.displayName || '', undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });

/**
 * Keep classes whose name contains every word typed, in any order, so
 * "thu read" finds "Reading 3 (Thursday)". An empty query keeps everything.
 */
export const filterRoster = (classes: EducationClass[], query: string): EducationClass[] => {
  const terms = normalizeRosterSearch(query).split(' ').filter(Boolean);
  if (terms.length === 0) return classes;
  return classes.filter(cls => {
    const name = normalizeRosterSearch(cls.displayName || '');
    return terms.every(term => name.includes(term));
  });
};

export const SAVED_GROUP_LABEL = 'Your roster';
export const OTHER_GROUP_LABEL = 'Other notebooks';

/**
 * A heading for the first class of each group, null elsewhere (aligned with the
 * input by index). Headings appear only when both groups are present; a list that
 * is all one kind needs no label.
 */
export const groupHeadings = (classes: EducationClass[]): Array<string | null> => {
  const savedCount = classes.filter(isSavedClass).length;
  const mixed = savedCount > 0 && savedCount < classes.length;
  return classes.map((cls, index) => {
    if (!mixed) return null;
    if (index > 0 && isSavedClass(classes[index - 1]) === isSavedClass(cls)) return null;
    return isSavedClass(cls) ? SAVED_GROUP_LABEL : OTHER_GROUP_LABEL;
  });
};
