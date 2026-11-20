import type { ParsedPageContent } from '../types';
import { dominantYear, parseEntryDate, parseEntryWeek, sortDiaryEntries } from './diaryChronology';

/** Every date/week conflict warning starts with this; the UI keys off it. */
export const CONFLICT_PREFIX = 'Date/week order disagree:';

export const isDateWeekConflict = (warning: string): boolean => warning.startsWith(CONFLICT_PREFIX);

/** Display-only ordering and advice; never corrects student dates or renumbers weeks. */
export const orderDiaryEntriesForDisplay = (entries: ParsedPageContent): ParsedPageContent => {
  const ordered = sortDiaryEntries(entries, entry => entry);
  const year = dominantYear(ordered.map(entry => entry.date));
  const warnings = new Map<number, Set<string>>();
  let previous: { index: number; time: number; week: number } | null = null;
  ordered.forEach((entry, index) => {
    const time = parseEntryDate(entry.date, year);
    const week = parseEntryWeek(entry.weekNumber);
    if (!Number.isFinite(time) || !Number.isFinite(week)) return;
    // A reset to week 1–3 can begin another term. A higher-numbered week
    // falling behind another within three weeks is worth checking, without
    // claiming which of the two student-written fields is wrong.
    if (previous && week < previous.week && week > 3 && time - previous.time <= 21 * 86400_000) {
      const earlier = ordered[previous.index];
      const warning = `${CONFLICT_PREFIX} week ${earlier.weekNumber} (${earlier.date}) comes before week ${entry.weekNumber} (${entry.date}). Entries are shown by date; check the original notebook.`;
      for (const at of [previous.index, index]) {
        if (!warnings.has(at)) warnings.set(at, new Set());
        warnings.get(at)!.add(warning);
      }
    }
    previous = { index, time, week };
  });
  return ordered.map((entry, index) => {
    const existing = (entry.parseWarnings ?? []).filter(warning => !isDateWeekConflict(warning));
    const next = [...existing, ...(warnings.get(index) ?? [])];
    return next.length || entry.parseWarnings ? { ...entry, parseWarnings: next } : entry;
  });
};
