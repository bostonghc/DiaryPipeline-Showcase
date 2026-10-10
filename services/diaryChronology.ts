// Shared helpers for ordering diary entries chronologically from human-readable
// date strings (e.g. "April 24, 2020", "April23.2026", "May 5"). Used both by the
// entry sort on database reload (firestoreDataService) and by the parse-time
// date↔week consistency check (parserService).

// An explicit 4-digit year if the date string carries one.
export const extractExplicitYear = (value?: string): number | null => {
  const match = String(value ?? '').match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
};

// The most common explicit year across a page's dates, used to fill in year-less
// dates. Ties break toward the earliest year (an academic year's opening term).
export const dominantYear = (dates: Array<string | undefined>): number | null => {
  const counts = new Map<number, number>();
  dates.forEach((date) => {
    const year = extractExplicitYear(date);
    if (year !== null) counts.set(year, (counts.get(year) ?? 0) + 1);
  });
  let best: number | null = null;
  let bestCount = 0;
  counts.forEach((count, year) => {
    if (count > bestCount || (count === bestCount && (best === null || year < best))) {
      best = year;
      bestCount = count;
    }
  });
  return best;
};

// Whether a string actually carries a month name or a numeric month/day, i.e. it is
// worth treating as a date. Guards against Date.parse salvaging a bare year out of
// junk like "???, 2026" (which it parses as Jan 1) once a fallback year is injected.
const looksLikeDate = (raw: string): boolean =>
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)/i.test(raw) ||
  /\d{1,2}\s*[\/.\-]\s*\d{1,2}/.test(raw);

// Chronological sort key for a human-readable date.
//
// Date.parse silently assigns year 2001 to year-less dates like "May 5", which then
// sort *before* dated entries and scramble the page. So when a date has no explicit
// year we inject the page's dominant year before parsing — but only when the string
// looks like a real date, so junk does not get salvaged into a bogus timestamp.
// Unparseable/empty dates return +Infinity so they sort to the end rather than
// jumping to the front.
export const parseEntryDate = (value?: string, fallbackYear?: number | null): number => {
  const raw = String(value ?? '').trim();
  if (!raw) return Number.POSITIVE_INFINITY;

  const hasYear = extractExplicitYear(raw) !== null;
  const shouldInject = !hasYear && fallbackYear != null && looksLikeDate(raw);
  const candidate = shouldInject ? `${raw}, ${fallbackYear}` : raw;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

// Numeric week number so "13" does not sort before "2". Missing weeks return +Infinity.
export const parseEntryWeek = (value?: string): number => {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};
