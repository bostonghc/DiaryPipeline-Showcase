import { useMemo, useState } from 'react';
import type { EducationClass } from '../types';
import { filterRoster, groupHeadings, isSavedClass, normalizeRosterSearch, orderRoster } from '../services/classRosterView';

/**
 * Everything the class roster menu shows: which classes, in what order, under
 * which headings. Owns the filter text and the show-unavailable toggle, which
 * nothing outside the roster uses. The two are independent: the toggle widens the
 * list by access status, the filter narrows whatever the toggle lets through, and
 * neither changes which classes are ticked. The caller supplies the classes and
 * the current selection.
 */
export const useRosterView = (classes: EducationClass[], selectedIds: ReadonlySet<string>) => {
  const [query, setQuery] = useState('');
  const [showUnavailable, setShowUnavailable] = useState(false);

  const ordered = useMemo(() => orderRoster(classes, showUnavailable), [classes, showUnavailable]);
  const visibleClasses = useMemo(() => filterRoster(ordered, query), [ordered, query]);
  const headings = useMemo(() => groupHeadings(visibleClasses), [visibleClasses]);
  const filtering = normalizeRosterSearch(query) !== '';

  // "Sync All Selected" acts on the whole selection, not just what is visible, so
  // say when the filter is hiding some of it.
  const hiddenSelectedCount = useMemo(() => {
    if (!filtering) return 0;
    const visible = new Set(visibleClasses.map(cls => cls.id));
    return ordered.filter(cls => selectedIds.has(cls.id) && !visible.has(cls.id)).length;
  }, [filtering, ordered, visibleClasses, selectedIds]);

  const savedCount = useMemo(() => classes.filter(isSavedClass).length, [classes]);
  // Notebooks the toggle would add to the list. Zero while it is already on.
  const unavailableCount = useMemo(
    () => (showUnavailable ? 0 : classes.filter(cls => cls.accessStatus !== 'accessible').length),
    [classes, showUnavailable]
  );

  return {
    query,
    setQuery,
    filtering,
    showUnavailable,
    toggleShowUnavailable: () => setShowUnavailable(current => !current),
    unavailableCount,
    visibleClasses,
    headings,
    totalCount: ordered.length,
    hiddenSelectedCount,
    savedCount,
    discoveredCount: classes.length - savedCount,
  };
};
