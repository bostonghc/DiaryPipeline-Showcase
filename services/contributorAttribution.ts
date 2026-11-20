import type { PageSyncRecord, StoredDiaryEntry } from '../types';
import { dominantYear, extractExplicitYear, parseEntryDate } from './diaryChronology';

/**
 * Pure attribution of bracketed peer-feedback labels (`[Hina] …`) to people.
 *
 * Labels are hand-written first names; page titles carry the author's 7-digit
 * ID and a name — kanji with a bracketed family–given romaji suffix by class
 * convention (`1234570 - 山田陽菜 (Yamada Hina)`), though many were written
 * romaji-only in either order. Graph has neither name form, so
 * attribution is scoped: a label on an entry is matched against the author's
 * diary-group co-members for that term, plus the configured interns.
 *
 * Two identity rules shape everything here (see PLANNING/peer-intern-feedback.md):
 * - A person's label is class-wide; group membership is a per-entry fact.
 *   Groups shift (between terms and within them), so "who is in group G" is
 *   asked of a group at a time — the authors writing there around that date.
 * - A page moved to another group section returns from Graph under a new page
 *   ID. The old copy survives in Firestore as an orphaned page record still
 *   carrying the old group — the only surviving evidence of where an entry
 *   was written. `resolveEffectiveEntries` collapses the duplicates, taking
 *   content from the live copy and group from the orphaned one.
 *
 * Nothing here reads Firestore; callers pass entries, page records, aliases
 * and interns, and every output is a suggestion until a teacher confirms it.
 */

export type ContributorRef =
  | { kind: 'student'; key: string }
  | { kind: 'intern'; upn: string };

/** The diary groups an intern covers in one class; no groups means the whole class. */
export interface InternAssignment {
  classId: string;
  /** Diary group display names, compared by group number (see diaryGroupKey). */
  groups: string[];
}

export interface InternProfile {
  upn: string;
  displayName: string;
  /** Labels the intern signs with in diaries (usually a first name). */
  labels: string[];
  /** Inclusive ISO date bounds; a legacy intern ends, a new one starts. */
  activeFrom?: string;
  activeUntil?: string;
  assignments?: InternAssignment[];
}

/**
 * Comparable key for a diary group name: its number when it has one, so
 * "Diary Group 1", "Diary Group 1 - 10-08" and "Group 1" are the same group.
 */
export const diaryGroupKey = (name: string): string => {
  const numbered = name.normalize('NFKC').match(/group\s*(\d+)/i);
  return numbered ? `group-${Number(numbered[1])}` : name.normalize('NFKC').trim().toLowerCase();
};

/** Whether an intern is assigned to a group (by name) in a class. */
export const internCoversGroup = (intern: InternProfile, classId: string, groupName: string): boolean =>
  (intern.assignments ?? []).some(
    (assignment) =>
      assignment.classId === classId &&
      (assignment.groups.length === 0 ||
        assignment.groups.some((group) => diaryGroupKey(group) === diaryGroupKey(groupName)))
  );

/** A teacher-confirmed label → person mapping. Group scope wins over class scope. */
export interface ContributorAlias {
  classId: string;
  /** Normalized via `normalizeLabel`. */
  label: string;
  target: ContributorRef;
  /** Set only to disambiguate a first name shared across groups. */
  groupId?: string;
}

export type AttributionStatus = 'confirmed' | 'suggested' | 'unresolved' | 'unspecified';
export type AttributionBasis = 'alias' | 'intern-label' | 'romaji-title' | 'close-spelling' | 'self-exclusion';
export type AttributionFlag = 'ambiguous' | 'self-label' | 'cross-group' | 'no-author-match';

export interface EffectiveEntry {
  entry: StoredDiaryEntry;
  authorKey: string;
  groupId: string;
  groupName: string;
  term: number;
  /** Entry timestamp in ms, or NaN when the date is unparseable. */
  time: number;
  /** Other stored copies of this entry (moved pages) collapsed into this one. */
  collapsedCopies: number;
}

export interface AttributedComment {
  classId: string;
  entryId: string;
  pageId: string;
  authorKey: string;
  groupId: string;
  term: number;
  date: string;
  weekNumber: string;
  time: number;
  labelRaw: string;
  label: string;
  feedback: string;
  commenter: ContributorRef | null;
  status: AttributionStatus;
  basis?: AttributionBasis;
  flags: AttributionFlag[];
}

/**
 * Romaji tokens known for one author, order-free: most titles were written
 * romaji-only, in either order, often incomplete. `given` is set only when the
 * bracketed family–given convention makes the order certain.
 */
export interface RomajiName {
  tokens: string[];
  display: string;
  given?: string;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const HONORIFIC_SUFFIX = /(?:[\s-]+(?:san|chan|kun|sama|sensei|senpai|sempai)|さん|ちゃん|くん|君|様|先生)$/;
const TITLE_PREFIX = /^(?:mr|mrs|ms|miss|dr)\.?\s+/;

/**
 * Cyrillic letters that look Latin, as typed by a student switching keyboard
 * layouts ("Ноnока" for Honoka). Folded so the name still matches.
 */
const CYRILLIC_LOOKALIKES: Record<string, string> = {
  А: 'a', В: 'b', Е: 'e', К: 'k', М: 'm', Н: 'h', О: 'o', Р: 'p', С: 'c', Т: 't', У: 'y', Х: 'x',
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
};
const foldLookalikes = (value: string): string => value.replace(/[\u0400-\u04ff]/g, (ch) => CYRILLIC_LOOKALIKES[ch] ?? ch);

/** Fold romaji long vowels so Yūto, Yuuto and Yuto compare equal. */
const foldLongVowels = (token: string): string =>
  token
    .replace(/ou/g, 'o')
    .replace(/oo/g, 'o')
    .replace(/uu/g, 'u')
    .replace(/oh(?=[^aeiou]|$)/g, 'o');

/**
 * Fold Kunrei/Nihon-shiki spellings onto Hepburn, so students who write
 * "isikawa", "syoji" or "Kadoguti" compare equal to "ishikawa", "shoji" and
 * "Kadoguchi". Applied to both sides, so English names fold consistently too.
 */
const foldSpelling = (token: string): string =>
  token
    .replace(/sy/g, 'sh')
    .replace(/ty/g, 'ch')
    .replace(/zy/g, 'j')
    .replace(/si/g, 'shi')
    .replace(/ti/g, 'chi')
    .replace(/tu/g, 'tsu')
    .replace(/zi/g, 'ji')
    .replace(/(?<![cs])hu/g, 'fu');

/**
 * Canonical comparison form for a label or a romaji name: NFKC width folding,
 * diacritics stripped, case folded, honorifics and titles removed, punctuation
 * collapsed, long vowels folded. Applied identically to both sides of every
 * comparison, so the folding only has to be consistent, not linguistically exact.
 */
export const normalizeLabel = (raw: string): string => {
  let value = foldLookalikes(raw)
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .trim();
  value = value.replace(TITLE_PREFIX, '');
  value = value.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  value = value.replace(HONORIFIC_SUFFIX, '').trim();
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => foldSpelling(foldLongVowels(token)))
    .join(' ');
};

/**
 * Labels that are not a name: the parser's `Unspecified N`, template tokens that
 * leaked into the feedback cell (`AI_FEEDBACK`), and headings rather than names
 * ("Member's questions and answered"). They count as comments without a name.
 */
const isNonNameLabel = (raw: string): boolean => {
  const value = raw.trim();
  return (
    /^unspecified(?:\s+\d+)?$/i.test(value) ||
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value) ||
    value.split(/\s+/).length > 3
  );
};

// Latin words in page titles that are not names, folded like every other token.
const TITLE_STOPWORDS = new Set([
  'at', 'diary', 'journal', 'nikki', 'page', 'untitled', 'copy', 'week', 'english', 'new',
  'group', 'grop', 'gurupu', 'semester', 'start', 'end', 'member', 'members',
].map((word) => normalizeLabel(word)));

/**
 * Romaji from a page title or student name, in any of the forms students used:
 * `1234570 - 山田陽菜 (Yamada Hina)` (the convention — order known),
 * `1234570 - Hina Yamada` or `1234570 - yamada` (romaji-only, order unknown).
 * Returns null when the value carries no Latin name tokens.
 */
export const extractRomajiName = (value: string): RomajiName | null => {
  const withoutId = value.replace(/\d+/g, ' ');
  const bracketed = withoutId.match(/[(（]\s*([A-Za-zĀ-ſ][A-Za-zĀ-ſ\s'’.-]*?)\s*[)）]\s*$/);
  const source = bracketed ? bracketed[1] : (withoutId.match(/[A-Za-zĀ-ſ][A-Za-zĀ-ſ'’.-]*/g) ?? []).join(' ');
  // "TanakaYu" is two names run together; keep the joined form as well.
  const spaced = source.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
  const tokens = Array.from(new Set(normalizeLabel(spaced === source ? source : `${source} ${spaced}`).split(' ')))
    .filter((token) => token.length >= 2 && !TITLE_STOPWORDS.has(token));
  // OneNote sometimes glues an "At" onto the title ("Attaiga" for "At Taiga").
  // Romaji never has "at" before a consonant other than the "ts" of Atsushi.
  for (const token of [...tokens]) {
    const glued = token.match(/^at(?=[^aeiousy])(.{3,})$/);
    if (glued) tokens.push(glued[1]);
  }
  if (tokens.length === 0) return null;
  const display = (bracketed ? bracketed[1] : source).trim().replace(/\s+/g, ' ');
  return bracketed && tokens.length >= 2
    ? { tokens, display, given: tokens.slice(1).join(' ') }
    : { tokens, display };
};

/** Merge what several copies of an author's page say about their romaji name. */
const mergeRomaji = (a: RomajiName, b: RomajiName): RomajiName => {
  const longer = b.tokens.length > a.tokens.length ? b : a;
  return {
    tokens: Array.from(new Set([...a.tokens, ...b.tokens])),
    display: longer.display,
    given: a.given ?? b.given,
  };
};

/** Every word of the label must be one of the author's romaji tokens. */
const romajiMatches = (name: RomajiName, label: string): boolean => {
  const words = label.split(' ').filter(Boolean);
  return words.length > 0 && words.every((word) => name.tokens.includes(word));
};

/** Levenshtein distance capped at 2 (only "0, 1, or more" matters here). */
const editDistanceAtMost2 = (a: string, b: string): number => {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return Math.min(previous[b.length], 2);
};

/**
 * One typo away: every label word matches a token exactly or, for words of four
 * or more letters, within one edit ("Srena" → serena, "Rico" → riko, "Mitabi" → miyabi).
 */
const romajiCloseMatches = (name: RomajiName, label: string): boolean => {
  const words = label.split(' ').filter(Boolean);
  return (
    words.length > 0 &&
    !romajiMatches(name, label) &&
    words.every((word) =>
      name.tokens.some((token) => token === word || (word.length >= 4 && editDistanceAtMost2(word, token) <= 1))
    )
  );
};

/**
 * Whether a stored entry belongs to a student page rather than a template or
 * stray page ("Untitled Page", "[SEMESTER_START] 1"): it resolved to a student,
 * carries a student number (typos of 8 digits included), or names someone in romaji.
 */
export const isStudentPageEntry = (entry: StoredDiaryEntry): boolean =>
  Boolean(entry.studentUpn || entry.studentGraphId) ||
  /\d{7,}/.test(entry.pageTitle || '') ||
  extractRomajiName(entry.pageTitle || '') !== null;

// ---------------------------------------------------------------------------
// Identity and term helpers
// ---------------------------------------------------------------------------

/** Directory-stable when possible: UPN survives the romaji page rename, names do not. */
export const studentKeyFor = (entry: Pick<StoredDiaryEntry, 'studentUpn' | 'studentGraphId' | 'studentName'>): string =>
  entry.studentUpn?.trim().toLowerCase() ||
  entry.studentGraphId ||
  `name:${normalizeLabel(entry.studentName || '')}`;

export const contributorKey = (ref: ContributorRef): string =>
  ref.kind === 'student' ? `student:${ref.key}` : `intern:${ref.upn.toLowerCase()}`;

/**
 * Term number for a timestamp: 1 before the first boundary, 2 from it, and so
 * on. Boundaries are ISO dates of each later term's first day. Unparseable
 * dates fall into term 1 — a known approximation, surfaced by `time` being NaN.
 */
export const termForTime = (time: number, termBoundaries: string[] = []): number => {
  if (!Number.isFinite(time)) return 1;
  const starts = termBoundaries.map((b) => Date.parse(b)).filter(Number.isFinite).sort((a, b) => a - b);
  return 1 + starts.filter((start) => time >= start).length;
};

const comparable = (value?: string): string => (value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const slotKeyFor = (entry: StoredDiaryEntry): string => {
  const date = comparable(entry.date);
  const week = comparable(entry.weekNumber);
  if (date || week) return `slot:${date}|${week}`;
  return `diary:${comparable(entry.diaryText).slice(0, 160)}`;
};

/**
 * Fill an entry's missing page title / student name from its page record. Some
 * older stored entries carry neither; without them a real student page looks
 * like a stray one and its romaji is invisible. Call before anything else.
 */
export const fillPageIdentity = (entries: StoredDiaryEntry[], pageRecords: PageSyncRecord[]): StoredDiaryEntry[] => {
  const recordsByPage = new Map(pageRecords.map((record) => [record.pageId, record]));
  return entries.map((entry) => {
    const record = recordsByPage.get(entry.pageId);
    if (!record || (entry.pageTitle && entry.studentName)) return entry;
    return {
      ...entry,
      pageTitle: entry.pageTitle || record.pageTitle,
      studentName: entry.studentName || record.studentName,
      studentUpn: entry.studentUpn || record.studentUpn,
      studentGraphId: entry.studentGraphId || record.studentGraphId,
    };
  });
};

// ---------------------------------------------------------------------------
// Academic-year scope
// ---------------------------------------------------------------------------

/** Japanese academic years start in April. */
const ACADEMIC_YEAR_START_MONTH = 3; // zero-based: April

const academicYearOf = (year: number, month: number): number =>
  month >= ACADEMIC_YEAR_START_MONTH ? year : year - 1;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Academic year of a date only when the student wrote the year: "April 24, 2020"
 * yes, "April 23" no. Students often copied the teacher's dated sample entries
 * onto their own pages, so inferring a missing year from the page would make
 * their real, year-less entries look years old.
 */
const writtenAcademicYear = (date: string): number | null => {
  const year = extractExplicitYear(date);
  if (year === null) return null;
  const lower = date.toLowerCase();
  const named = MONTHS.findIndex((month) => lower.includes(month));
  const numeric = date.match(/\b(\d{1,2})[/.-]\d{1,2}\b/);
  const month = named >= 0 ? named : numeric ? Number(numeric[1]) - 1 : ACADEMIC_YEAR_START_MONTH;
  return academicYearOf(year, month >= 0 && month < 12 ? month : ACADEMIC_YEAR_START_MONTH);
};

/**
 * Keep each class's current academic year only. A class notebook can hold
 * older material — the teacher's sample diaries, and students' copies of them,
 * carry real comments from prior years — and those commenters are not this
 * cohort. Only entries with an explicitly written earlier year are dropped.
 *
 * The class's year is the latest *written* year that is not later than the
 * newest OneNote edit in the class. The cap matters: a single typo such as
 * "2062" once made the class's year look later than 2026 and hid a dozen
 * students' real work. Written years beyond the cap are kept, never trusted.
 *
 * A copied sample is also recognised directly: the same dated entry (date and
 * text) on two or more students' pages, written in a year before the cap. Real
 * entries never repeat across students, and this catches samples even when
 * students' own entries carry no year at all.
 */
export const filterCurrentAcademicYear = (
  entries: StoredDiaryEntry[]
): { kept: StoredDiaryEntry[]; dropped: StoredDiaryEntry[] } => {
  const editedCap = new Map<string, number>();
  for (const entry of entries) {
    const edited = entry.oneNoteLastModified ? new Date(entry.oneNoteLastModified) : null;
    if (edited && Number.isFinite(edited.getTime())) {
      const year = academicYearOf(edited.getFullYear(), edited.getMonth());
      editedCap.set(entry.classId, Math.max(editedCap.get(entry.classId) ?? -Infinity, year));
    }
  }
  const now = new Date();
  const capFor = (classId: string) => editedCap.get(classId) ?? academicYearOf(now.getFullYear(), now.getMonth());

  const currentYear = new Map<string, number>();
  for (const entry of entries) {
    const year = writtenAcademicYear(entry.date || '');
    if (year === null || year > capFor(entry.classId)) continue;
    currentYear.set(entry.classId, Math.max(currentYear.get(entry.classId) ?? -Infinity, year));
  }

  const sampleKey = (entry: StoredDiaryEntry) =>
    `${entry.classId}|${comparable(entry.date)}|${comparable(entry.diaryText).slice(0, 200)}`;
  const authorsBySample = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!comparable(entry.diaryText)) continue;
    const key = sampleKey(entry);
    if (!authorsBySample.has(key)) authorsBySample.set(key, new Set());
    authorsBySample.get(key)!.add(studentKeyFor(entry));
  }

  const kept: StoredDiaryEntry[] = [];
  const dropped: StoredDiaryEntry[] = [];
  for (const entry of entries) {
    const year = writtenAcademicYear(entry.date || '');
    const current = currentYear.get(entry.classId);
    const earlierYear = year !== null && current !== undefined && year < current;
    const copiedSample =
      year !== null &&
      year < capFor(entry.classId) &&
      (authorsBySample.get(sampleKey(entry))?.size ?? 0) >= 2;
    if (earlierYear || copiedSample) dropped.push(entry);
    else kept.push(entry);
  }
  return { kept, dropped };
};

// ---------------------------------------------------------------------------
// Moved-page collapse
// ---------------------------------------------------------------------------

export interface EffectiveEntryOptions {
  termBoundaries?: string[];
}

/**
 * One effective entry per (class, author, date/week slot).
 *
 * Content comes from the newest live (non-orphaned) copy, because that is the
 * page students and the teacher still edit. Group comes from the orphaned copy
 * whose page disappeared earliest — the section the entry was written in. If
 * no copy is orphaned, the content copy's group is used. A page never synced
 * before it moved leaves no orphaned copy, so its pre-move entries are
 * attributed to the new group; that loss is not recoverable from stored data.
 * Template and stray pages (see `isStudentPageEntry`) are dropped first.
 */
export const resolveEffectiveEntries = (
  entries: StoredDiaryEntry[],
  pageRecords: PageSyncRecord[],
  options: EffectiveEntryOptions = {}
): EffectiveEntry[] => {
  entries = entries.filter(isStudentPageEntry);
  const recordsByPage = new Map(pageRecords.map((record) => [record.pageId, record]));
  const yearByAuthor = new Map<string, number | null>();
  const datesByAuthor = new Map<string, string[]>();
  for (const entry of entries) {
    const key = `${entry.classId}|${studentKeyFor(entry)}`;
    datesByAuthor.set(key, [...(datesByAuthor.get(key) ?? []), entry.date]);
  }
  datesByAuthor.forEach((dates, key) => yearByAuthor.set(key, dominantYear(dates)));
  // An author who never wrote a year borrows the class's usual year, else the
  // year their page was last edited — never Date.parse's default of 2001.
  const yearByClass = new Map<string, number | null>();
  const classDates = new Map<string, string[]>();
  for (const entry of entries) classDates.set(entry.classId, [...(classDates.get(entry.classId) ?? []), entry.date]);
  classDates.forEach((dates, classId) => yearByClass.set(classId, dominantYear(dates)));
  const fallbackYear = (entry: StoredDiaryEntry): number | null => {
    const edited = entry.oneNoteLastModified ? new Date(entry.oneNoteLastModified).getFullYear() : NaN;
    return yearByClass.get(entry.classId) ?? (Number.isFinite(edited) ? edited : null);
  };

  const buckets = new Map<string, StoredDiaryEntry[]>();
  for (const entry of entries) {
    const key = `${entry.classId}|${studentKeyFor(entry)}|${slotKeyFor(entry)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), entry]);
  }

  const orphanedAt = (entry: StoredDiaryEntry): string | undefined => recordsByPage.get(entry.pageId)?.orphanedAt;

  return Array.from(buckets.values()).map((copies) => {
    const byNewest = [...copies].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const content = byNewest.find((copy) => !orphanedAt(copy)) ?? byNewest[0];
    const origin = copies
      .filter((copy) => orphanedAt(copy))
      .sort((a, b) => (orphanedAt(a) || '').localeCompare(orphanedAt(b) || ''))[0] ?? content;
    const originRecord = recordsByPage.get(origin.pageId);
    const authorKey = studentKeyFor(content);
    const time = parseEntryDate(content.date, yearByAuthor.get(`${content.classId}|${authorKey}`) ?? fallbackYear(content));
    const finiteTime = Number.isFinite(time) ? time : Number.NaN;

    return {
      entry: content,
      authorKey,
      groupId: origin.diaryGroupId || originRecord?.diaryGroupId || `page:${origin.pageId}`,
      groupName: origin.diaryGroupName || originRecord?.diaryGroupName || '',
      term: termForTime(finiteTime, options.termBoundaries),
      time: finiteTime,
      collapsedCopies: copies.length - 1,
    };
  });
};

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export const membershipKey = (classId: string, groupId: string, term: number): string =>
  `${classId}|${groupId}|${term}`;

/** Authors observed writing in each (class, group, term) — the grid's display scope. */
export const buildGroupMembership = (effective: EffectiveEntry[]): Map<string, Set<string>> => {
  const membership = new Map<string, Set<string>>();
  for (const item of effective) {
    const key = membershipKey(item.entry.classId, item.groupId, item.term);
    if (!membership.has(key)) membership.set(key, new Set());
    membership.get(key)!.add(item.authorKey);
  }
  return membership;
};

/**
 * Romaji names per author, merged across every stored copy: orphaned copies
 * keep the pre-rename title, and an early title may carry only part of a name.
 */
/** Days either side of an author's first/last entry in a group that still count as membership. */
const MEMBERSHIP_SLACK_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * Time-local membership: who was in a group when an entry was written. Each
 * author's stay in a group is the span of their entries there (plus slack), so
 * any number of regroups — at term start, mid-term, or after a page was copied
 * into the wrong section — needs no teacher-set dates. Entries with no
 * parseable date fall back to everyone ever seen in the group.
 */
const buildMembersAt = (effective: EffectiveEntry[], departures: Map<string, number> = new Map()) => {
  const spans = new Map<string, Map<string, { first: number; last: number }>>();
  for (const item of effective) {
    const groupKey = `${item.entry.classId}|${item.groupId}`;
    if (!spans.has(groupKey)) spans.set(groupKey, new Map());
    const authors = spans.get(groupKey)!;
    const span = authors.get(item.authorKey) ?? { first: Infinity, last: -Infinity };
    if (Number.isFinite(item.time)) {
      span.first = Math.min(span.first, item.time);
      span.last = Math.max(span.last, item.time);
    }
    authors.set(item.authorKey, span);
  }
  return (item: EffectiveEntry): Set<string> => {
    const authors = spans.get(`${item.entry.classId}|${item.groupId}`) ?? new Map();
    const members = new Set<string>([item.authorKey]);
    authors.forEach((span, author) => {
      const undated = !Number.isFinite(span.first);
      // A student no longer in class stops being a member on their departure date.
      const departed = departures.get(`${item.entry.classId}|${author}`);
      if (departed !== undefined && Number.isFinite(item.time) && item.time >= departed) return;
      if (
        !Number.isFinite(item.time) ||
        undated ||
        (item.time >= span.first - MEMBERSHIP_SLACK_MS && item.time <= span.last + MEMBERSHIP_SLACK_MS)
      ) {
        members.add(author);
      }
    });
    return members;
  };
};

export const buildRomajiIndex = (entries: StoredDiaryEntry[]): Map<string, RomajiName> => {
  const index = new Map<string, RomajiName>();
  for (const entry of entries) {
    const key = studentKeyFor(entry);
    for (const value of [entry.pageTitle, entry.studentName]) {
      const name = extractRomajiName(value || '');
      if (!name) continue;
      const existing = index.get(key);
      index.set(key, existing ? mergeRomaji(existing, name) : name);
    }
  }
  return index;
};

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export interface AttributionOptions {
  aliases?: ContributorAlias[];
  interns?: InternProfile[];
  romajiIndex?: Map<string, RomajiName>;
  /** Minimum occurrences before self-exclusion may suggest a match. */
  selfExclusionMinOccurrences?: number;
  /** `${classId}|${authorKey}` → ISO date the student left the class. */
  departures?: Record<string, string>;
}

const internActiveAt = (intern: InternProfile, time: number): boolean => {
  if (!Number.isFinite(time)) return true;
  const from = intern.activeFrom ? Date.parse(intern.activeFrom) : Number.NEGATIVE_INFINITY;
  const until = intern.activeUntil ? Date.parse(intern.activeUntil) : Number.POSITIVE_INFINITY;
  return time >= from && time <= until;
};

export const attributeComments = (
  effective: EffectiveEntry[],
  options: AttributionOptions = {}
): AttributedComment[] => {
  const {
    aliases = [],
    interns = [],
    romajiIndex = new Map(),
    selfExclusionMinOccurrences = 2,
    departures = {},
  } = options;

  const departureTimes = new Map(
    Object.entries(departures)
      .map(([key, date]) => [key, Date.parse(`${date}T00:00:00`)] as const)
      .filter(([, time]) => Number.isFinite(time))
  );
  const membersAt = buildMembersAt(effective, departureTimes);
  const authorsByClass = new Map<string, Set<string>>();
  for (const item of effective) {
    if (!authorsByClass.has(item.entry.classId)) authorsByClass.set(item.entry.classId, new Set());
    authorsByClass.get(item.entry.classId)!.add(item.authorKey);
  }

  // Evidence for self-exclusion: who carries each label, and where.
  const carriers = new Map<string, Set<string>>();
  const occurrences = new Map<string, number>();
  for (const item of effective) {
    for (const fb of item.entry.peerFeedback || []) {
      if (isNonNameLabel(fb.contributor)) continue;
      const label = normalizeLabel(fb.contributor);
      if (!label) continue;
      const scope = `${item.entry.classId}|${item.groupId}|${label}`;
      if (!carriers.has(scope)) carriers.set(scope, new Set());
      carriers.get(scope)!.add(item.authorKey);
      occurrences.set(scope, (occurrences.get(scope) ?? 0) + 1);
    }
  }

  const internLabels = interns.map((intern) => ({
    intern,
    labels: new Set(intern.labels.map(normalizeLabel).filter(Boolean)),
  }));

  const comments: AttributedComment[] = [];
  for (const item of effective) {
    const { entry } = item;
    const members = membersAt(item);

    for (const fb of entry.peerFeedback || []) {
      const base = {
        classId: entry.classId,
        entryId: entry.entryId,
        pageId: entry.pageId,
        authorKey: item.authorKey,
        groupId: item.groupId,
        term: item.term,
        date: entry.date,
        weekNumber: entry.weekNumber,
        time: item.time,
        labelRaw: fb.contributor,
        feedback: fb.feedback,
      };

      if (isNonNameLabel(fb.contributor)) {
        comments.push({ ...base, label: '', commenter: null, status: 'unspecified', flags: [] });
        continue;
      }

      const label = normalizeLabel(fb.contributor);
      const flags: AttributionFlag[] = [];
      const resolve = (commenter: ContributorRef, status: AttributionStatus, basis: AttributionBasis) => {
        if (commenter.kind === 'student' && commenter.key === item.authorKey) flags.push('self-label');
        comments.push({ ...base, label, commenter, status, basis, flags });
      };

      const alias =
        aliases.find((a) => a.classId === entry.classId && a.label === label && a.groupId === item.groupId) ??
        aliases.find((a) => a.classId === entry.classId && a.label === label && !a.groupId);
      if (alias) {
        resolve(alias.target, 'confirmed', 'alias');
        continue;
      }

      const internHits = internLabels
        .filter(({ intern, labels }) => labels.has(label) && internActiveAt(intern, item.time))
        .map(({ intern }) => intern);
      const romajiInGroup = [...members].filter(
        (key) => key !== item.authorKey && romajiIndex.get(key) && romajiMatches(romajiIndex.get(key)!, label)
      );

      if (internHits.length + romajiInGroup.length > 1) {
        comments.push({ ...base, label, commenter: null, status: 'unresolved', flags: ['ambiguous'] });
        continue;
      }
      if (internHits.length === 1) {
        resolve({ kind: 'intern', upn: internHits[0].upn }, 'suggested', 'intern-label');
        continue;
      }
      if (romajiInGroup.length === 1) {
        resolve({ kind: 'student', key: romajiInGroup[0] }, 'suggested', 'romaji-title');
        continue;
      }

      // A student outside the group commenting: allowed, but only on a unique class-wide match.
      const romajiInClass = [...(authorsByClass.get(entry.classId) ?? [])].filter(
        (key) => key !== item.authorKey && !members.has(key) && romajiIndex.get(key) && romajiMatches(romajiIndex.get(key)!, label)
      );
      if (romajiInClass.length === 1) {
        flags.push('cross-group');
        resolve({ kind: 'student', key: romajiInClass[0] }, 'suggested', 'romaji-title');
        continue;
      }
      if (romajiInClass.length > 1) {
        comments.push({ ...base, label, commenter: null, status: 'unresolved', flags: ['ambiguous'] });
        continue;
      }

      // One typo away, within the group only — spelling slips are common, but a
      // near-miss across the whole class is too loose to suggest.
      const closeInGroup = [...members].filter(
        (key) => key !== item.authorKey && romajiIndex.get(key) && romajiCloseMatches(romajiIndex.get(key)!, label)
      );
      if (closeInGroup.length === 1) {
        resolve({ kind: 'student', key: closeInGroup[0] }, 'suggested', 'close-spelling');
        continue;
      }

      // Self-exclusion: nobody comments on their own diary, so the one member
      // whose pages never carry this label is the likeliest author of it.
      const scope = `${entry.classId}|${item.groupId}|${label}`;
      const seenOn = carriers.get(scope) ?? new Set<string>();
      const candidates = [...members].filter((key) => !seenOn.has(key));
      if (
        members.size >= 2 &&
        candidates.length === 1 &&
        (occurrences.get(scope) ?? 0) >= selfExclusionMinOccurrences
      ) {
        resolve({ kind: 'student', key: candidates[0] }, 'suggested', 'self-exclusion');
        continue;
      }

      // Nobody in the class has a page title this label could belong to: a test
      // page's made-up commenters, a kanji-only title, a page never captured, or
      // an intern not yet on the list. Said plainly rather than guessed at.
      const anyAuthorFits = [...(authorsByClass.get(entry.classId) ?? [])].some((key) => {
        const name = romajiIndex.get(key);
        return name && (romajiMatches(name, label) || romajiCloseMatches(name, label));
      });
      if (!anyAuthorFits) flags.push('no-author-match');
      comments.push({ ...base, label, commenter: null, status: 'unresolved', flags });
    }
  }

  return comments;
};

// ---------------------------------------------------------------------------
// Departures
// ---------------------------------------------------------------------------

export interface DepartureSuggestion {
  classId: string;
  authorKey: string;
  /** Local ISO date of the student's last entry, the suggested departure date. */
  lastEntryDate: string;
}

const toLocalIsoDate = (time: number): string => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Students who may no longer be in the class: none of their pages remains in a
 * shared diary group. Moving a departed student's diary out of Collaboration
 * Space (into Teacher Only, or their own section) leaves only the orphaned
 * copy. A live page counts only when its group holds other students' pages,
 * so a diary picked up from the student's own section by an Assignments sync
 * does not hide the suggestion. Suggestions only — the teacher confirms.
 */
export const suggestDepartures = (
  effective: EffectiveEntry[],
  pageRecords: PageSyncRecord[],
  skip: Set<string> = new Set()
): DepartureSuggestion[] => {
  const recordsByPage = new Map(pageRecords.map((record) => [record.pageId, record]));
  const authorsByGroup = new Map<string, Set<string>>();
  const pagesByAuthor = new Map<string, Set<string>>();
  const lastTime = new Map<string, number>();
  for (const item of effective) {
    const authorKey = `${item.entry.classId}|${item.authorKey}`;
    const record = recordsByPage.get(item.entry.pageId);
    const liveGroup = record && !record.orphanedAt ? `${item.entry.classId}|${record.diaryGroupId ?? item.groupId}` : null;
    if (liveGroup) {
      if (!authorsByGroup.has(liveGroup)) authorsByGroup.set(liveGroup, new Set());
      authorsByGroup.get(liveGroup)!.add(item.authorKey);
    }
    if (!pagesByAuthor.has(authorKey)) pagesByAuthor.set(authorKey, new Set());
    pagesByAuthor.get(authorKey)!.add(item.entry.pageId);
    if (Number.isFinite(item.time)) lastTime.set(authorKey, Math.max(lastTime.get(authorKey) ?? -Infinity, item.time));
  }

  const suggestions: DepartureSuggestion[] = [];
  pagesByAuthor.forEach((pageIds, authorKey) => {
    if (skip.has(authorKey)) return;
    const [classId, ...rest] = authorKey.split('|');
    const author = rest.join('|');
    const hasSharedLivePage = [...pageIds].some((pageId) => {
      const record = recordsByPage.get(pageId);
      if (!record || record.orphanedAt) return false;
      const groupAuthors = authorsByGroup.get(`${classId}|${record.diaryGroupId}`);
      return (groupAuthors?.size ?? 0) > 1;
    });
    const knownToRecords = [...pageIds].some((pageId) => recordsByPage.has(pageId));
    const last = lastTime.get(authorKey);
    if (!hasSharedLivePage && knownToRecords && last !== undefined) {
      suggestions.push({ classId, authorKey: author, lastEntryDate: toLocalIsoDate(last) });
    }
  });
  return suggestions.sort((a, b) => a.lastEntryDate.localeCompare(b.lastEntryDate));
};

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export interface AttributionCoverage {
  total: number;
  confirmed: number;
  suggested: number;
  unresolved: number;
  unspecified: number;
}

export const attributionCoverage = (comments: AttributedComment[]): AttributionCoverage => {
  const coverage: AttributionCoverage = { total: comments.length, confirmed: 0, suggested: 0, unresolved: 0, unspecified: 0 };
  for (const comment of comments) coverage[comment.status] += 1;
  return coverage;
};

export interface GroupGrid {
  classId: string;
  groupId: string;
  term: number;
  members: string[];
  /** contributorKey(commenter) → author key → count. Interns appear as commenter rows. */
  cells: Map<string, Map<string, number>>;
  unattributedByAuthor: Map<string, number>;
}

/**
 * Commenter × author grid per (class, group, term). Only confirmed and
 * suggested attributions fill cells; callers decide whether suggestions count.
 */
export const buildGroupGrids = (
  effective: EffectiveEntry[],
  comments: AttributedComment[],
  { includeSuggested = true }: { includeSuggested?: boolean } = {}
): GroupGrid[] => {
  const membership = buildGroupMembership(effective);
  const grids = new Map<string, GroupGrid>();
  membership.forEach((members, key) => {
    const [classId, groupId, term] = key.split('|');
    grids.set(key, {
      classId,
      groupId,
      term: Number(term),
      members: [...members].sort(),
      cells: new Map(),
      unattributedByAuthor: new Map(),
    });
  });

  for (const comment of comments) {
    const grid = grids.get(membershipKey(comment.classId, comment.groupId, comment.term));
    if (!grid) continue;
    const counts = comment.commenter && (comment.status === 'confirmed' || (includeSuggested && comment.status === 'suggested'));
    if (!counts) {
      grid.unattributedByAuthor.set(comment.authorKey, (grid.unattributedByAuthor.get(comment.authorKey) ?? 0) + 1);
      continue;
    }
    const row = contributorKey(comment.commenter!);
    if (!grid.cells.has(row)) grid.cells.set(row, new Map());
    const cellRow = grid.cells.get(row)!;
    cellRow.set(comment.authorKey, (cellRow.get(comment.authorKey) ?? 0) + 1);
  }

  return [...grids.values()];
};
