// Shared helpers for ordering diary entries chronologically from human-readable
// date strings (e.g. "April 24, 2020", "April23.2026", "May 5"). Used both by the
// entry sort on database reload (firestoreDataService) and by the parse-time
// date↔week consistency check (parserService).

// An explicit 4-digit year if the date string carries one.
export const extractExplicitYear = (value?: string): number | null => {
  const match = String(value ?? '').normalize('NFKC').match(/\b(?:19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
};

// Numeric dates with two-digit years follow the same century convention as
// parseEntryDate. Only valid month/day dates may lend a year to nearby entries.
const yearForDateInference = (value?: string): number | null => {
  const fullYear = extractExplicitYear(value);
  if (fullYear !== null) return fullYear;
  const raw = String(value ?? '').normalize('NFKC').trim();
  const numeric = raw.match(/^(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*\d{2}$/);
  if (!numeric) return null;
  const date = new Date(Date.parse(raw));
  return date.getMonth() === Number(numeric[1]) - 1 && date.getDate() === Number(numeric[2])
    ? date.getFullYear() : null;
};

// The most common written year across a page's dates, used to fill in year-less
// dates. Ties break toward the earliest year (an academic year's opening term).
export const dominantYear = (dates: Array<string | undefined>): number | null => {
  const counts = new Map<number, number>();
  dates.forEach((date) => {
    const year = yearForDateInference(date);
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

// Year assumed for a date with no year when the page offers none to borrow. One
// value for every parsing path so mixed formats compare consistently; a leap
// year so a year-less "Feb 29" stays valid.
const YEARLESS_FALLBACK_YEAR = 2000;

// Chronological sort key for a human-readable date.
//
// Date.parse silently assigns year 2001 to year-less dates like "May 5", which then
// sort *before* dated entries and scramble the page. So when a date has no explicit
// year we inject the page's dominant year before parsing — but only when the string
// looks like a real date, so junk does not get salvaged into a bogus timestamp.
// Unparseable/empty dates return +Infinity so they sort to the end rather than
// jumping to the front.
export const parseEntryDate = (value?: string, fallbackYear?: number | null): number => {
  const raw = String(value ?? '').normalize('NFKC').trim()
    .replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1');
  if (!raw) return Number.POSITIVE_INFINITY;

  // Student-written dates regularly omit spaces, use periods/full-width
  // punctuation, or put the day first. Parse these explicitly: Date.parse
  // rejects "April30.2026" and "June 21st", and silently repairs some invalid
  // calendar dates. Keep the student's original text unchanged.
  const monthName = '(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec)';
  const monthFirst = raw.match(new RegExp(`^${monthName}[\\s.,/\\-]*(\\d{1,2})(?:[\\s.,/\\-]+(\\d{4}))?[\\s.,]*$`, 'i'));
  const dayFirst = raw.match(new RegExp(`^(\\d{1,2})[\\s.,/\\-]*${monthName}(?:[\\s.,/\\-]+(\\d{4}))?[\\s.,]*$`, 'i'));
  if (monthFirst || dayFirst) {
    const monthText = monthFirst?.[1] ?? dayFirst![2];
    const day = Number(monthFirst?.[2] ?? dayFirst![1]);
    const year = Number((monthFirst ?? dayFirst)![3] ?? fallbackYear ?? YEARLESS_FALLBACK_YEAR);
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(monthText.slice(0, 3).toLowerCase());
    const date = new Date(year, month, day);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
      ? date.getTime() : Number.POSITIVE_INFINITY;
  }

  if (!looksLikeDate(raw)) return Number.POSITIVE_INFINITY;
  const hasYear = extractExplicitYear(raw) !== null;
  // A three-part numeric date ("4/30/26") already carries its year, which
  // extractExplicitYear cannot see when it is two digits. Leave those to Date.parse.
  const hasNumericYear = /\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2}/.test(raw);
  // Otherwise always inject a year when the text has none. Left to itself
  // Date.parse picks 2001, which would disagree with the English month-name path
  // above and sort "4/30" after "May 1" on a page with no explicit year.
  const candidate = hasYear || hasNumericYear ? raw : `${raw}, ${fallbackYear ?? YEARLESS_FALLBACK_YEAR}`;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

// Numeric week number so "13" does not sort before "2". Missing weeks return +Infinity.
export const parseEntryWeek = (value?: string): number => {
  const normalized = String(value ?? '').normalize('NFKC').trim().replace(/^week\s*/i, '');
  const parsed = parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

export interface DiaryChronologyFields {
  date?: string;
  weekNumber?: string;
  pageId?: string;
  /** Final tiebreaker when date and week are equal; omit to keep input order. */
  entryId?: string;
}

/** One ordering policy for saved and freshly parsed entries, with year inference per page. */
export const sortDiaryEntries = <T>(entries: T[], fields: (entry: T) => DiaryChronologyFields): T[] => {
  const datesByPage = new Map<string, Array<string | undefined>>();
  for (const entry of entries) {
    const item = fields(entry);
    const key = item.pageId || '';
    datesByPage.set(key, [...(datesByPage.get(key) ?? []), item.date]);
  }
  const years = new Map([...datesByPage].map(([page, dates]) => [page, dominantYear(dates)]));
  return [...entries].sort((a, b) => {
    const left = fields(a);
    const right = fields(b);
    const dateA = parseEntryDate(left.date, years.get(left.pageId || ''));
    const dateB = parseEntryDate(right.date, years.get(right.pageId || ''));
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    const weekA = parseEntryWeek(left.weekNumber);
    const weekB = parseEntryWeek(right.weekNumber);
    if (weekA !== weekB) return weekA < weekB ? -1 : 1;
    // Without this, tied entries (e.g. unparseable date and no week) keep the
    // hydration order, which can differ between loads.
    return left.entryId && right.entryId ? left.entryId.localeCompare(right.entryId) : 0;
  });
};
