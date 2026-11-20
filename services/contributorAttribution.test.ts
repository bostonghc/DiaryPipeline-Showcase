import { describe, it, expect } from 'vitest';
import {
  attributeComments,
  attributionCoverage,
  buildGroupGrids,
  buildRomajiIndex,
  contributorKey,
  extractRomajiName,
  fillPageIdentity,
  filterCurrentAcademicYear,
  normalizeLabel,
  resolveEffectiveEntries,
  suggestDepartures,
  termForTime,
  type InternProfile,
} from './contributorAttribution';
import type { PageSyncRecord, PeerFeedback, StoredDiaryEntry } from '../types';

const entry = (overrides: Partial<StoredDiaryEntry> & { peer?: Array<[string, string]> } = {}): StoredDiaryEntry => {
  const { peer = [], ...rest } = overrides;
  return {
    entryId: 'e1',
    pageId: 'p1',
    pageTitle: '1000001 - 山田陽菜 (Yamada Hina)',
    classId: 'c1',
    diaryGroupId: 'g1',
    diaryGroupName: 'Diary Group 1',
    studentName: '山田陽菜 (Yamada Hina)',
    studentUpn: 'ak1000001@example.ac.jp',
    date: 'May 1, 2026',
    weekNumber: '3',
    weather: '',
    diaryText: 'text',
    diaryTextCorrected: '',
    teacherFeedback: {},
    peerFeedback: peer.map(([contributor, feedback]): PeerFeedback => ({ contributor, feedback })),
    translations: [],
    vocabCount: 0,
    sentiment: '',
    topics: [],
    vocabItems: [],
    photoCount: 0,
    translationCount: 0,
    chatbotFeedback: { present: false, data: '' },
    status: 'draft',
    parserMode: 'label-first',
    templateVersion: 'labeled-diary-v1',
    updatedAt: '2026-05-02T00:00:00.000Z',
    ...rest,
  };
};

const pageRecord = (overrides: Partial<PageSyncRecord> = {}): PageSyncRecord => ({
  pageId: 'p1',
  classId: 'c1',
  pageTitle: '',
  studentName: '',
  parserMode: 'label-first',
  templateVersion: 'labeled-diary-v1',
  syncState: 'saved',
  entryCount: 1,
  updatedAt: '2026-05-02T00:00:00.000Z',
  ...overrides,
});

// A four-student group, every author's page titled with romaji.
const student = (n: number, family: string, given: string, kanji = '学生') => ({
  upn: `ak100000${n}@example.ac.jp`,
  pageId: `p${n}`,
  pageTitle: `100000${n} - ${kanji} (${family} ${given})`,
  studentName: `${kanji} (${family} ${given})`,
});
const HINA = student(1, 'Yamada', 'Hina');
const KANOKO = student(2, 'Sato', 'Kanoko');
const KAISEI = student(3, 'Ito', 'Kaisei');
const JUN = student(4, 'Mori', 'Jun');

const authored = (who: ReturnType<typeof student>, overrides: Parameters<typeof entry>[0] = {}) =>
  entry({
    entryId: `${who.pageId}_w3`,
    pageId: who.pageId,
    pageTitle: who.pageTitle,
    studentName: who.studentName,
    studentUpn: who.upn,
    ...overrides,
  });

describe('normalizeLabel', () => {
  it('folds case, width, diacritics, honorifics and long vowels to one form', () => {
    expect(normalizeLabel('Hina')).toBe('hina');
    expect(normalizeLabel('ｈｉｎａ')).toBe('hina');
    expect(normalizeLabel(' kanoko-san ')).toBe('kanoko');
    expect(normalizeLabel('Yūto')).toBe(normalizeLabel('Yuuto'));
    expect(normalizeLabel('Yuuto')).toBe(normalizeLabel('Yuto'));
    expect(normalizeLabel('Shouhei')).toBe(normalizeLabel('Shohei'));
    expect(normalizeLabel('Ms. Emma')).toBe('emma');
    expect(normalizeLabel('陽菜さん')).toBe('陽菜');
  });

  it('folds Kunrei spellings onto Hepburn', () => {
    expect(normalizeLabel('Syoji')).toBe(normalizeLabel('Shoji'));
    expect(normalizeLabel('isikawa')).toBe(normalizeLabel('Ishikawa'));
    expect(normalizeLabel('Matuda')).toBe(normalizeLabel('Matsuda'));
    expect(normalizeLabel('Kadoguti')).toBe(normalizeLabel('Kadoguchi'));
  });

  it('folds look-alike Cyrillic letters typed on the wrong keyboard', () => {
    expect(normalizeLabel('Ноnока')).toBe(normalizeLabel('Honoka'));
  });

  it('does not strip a name that merely ends in an honorific-like syllable', () => {
    expect(normalizeLabel('Kensan')).toBe('kensan');
  });
});

describe('extractRomajiName', () => {
  it('reads the bracketed family–given convention, knowing the given name', () => {
    expect(extractRomajiName('1234570 - 山田陽菜 (Yamada Hina)')).toEqual({
      tokens: ['yamada', 'hina'],
      display: 'Yamada Hina',
      given: 'hina',
    });
    expect(extractRomajiName('1234570 - 山田陽菜（Yamada Hina）')?.given).toBe('hina');
  });

  it('reads romaji-only titles in either order, without claiming which is the given name', () => {
    expect(extractRomajiName('1234570 - Hina Yamada')).toEqual({ tokens: ['hina', 'yamada'], display: 'Hina Yamada' });
    expect(extractRomajiName('1234570 - yamada')).toEqual({ tokens: ['yamada'], display: 'yamada' });
    expect(extractRomajiName('1234570 - 山田陽菜 (Hina)')?.tokens).toEqual(['hina']);
  });

  it('ignores the ID and non-name words, and returns null for kanji-only titles', () => {
    expect(extractRomajiName('At 1234570 Hina diary')?.tokens).toEqual(['hina']);
    expect(extractRomajiName('1234570 - Hina Yamada grop 3')?.tokens).toEqual(['hina', 'yamada']);
    expect(extractRomajiName('12345702 Hina Yamada')?.tokens).toEqual(['hina', 'yamada']);
    expect(extractRomajiName('1234570 - 山田陽菜')).toBeNull();
    expect(extractRomajiName('Untitled Page')).toBeNull();
    expect(extractRomajiName('[SEMESTER_START] 1')).toBeNull();
  });

  it('recovers a name OneNote glued an "At" onto, without breaking Atsu- names', () => {
    expect(extractRomajiName('1234570 - Atrenji mori')?.tokens).toContain('renji');
    expect(extractRomajiName('1234570 - Atsushi mori')?.tokens).toEqual(['atsushi', 'mori']);
  });

  it('splits two names written as one word, keeping the joined form', () => {
    expect(extractRomajiName('1234576 - TanakaYu')?.tokens.sort()).toEqual(['tanaka', 'tanakayu', 'yu']);
  });
});

describe('buildRomajiIndex', () => {
  it('merges partial names across copies of the same author', () => {
    const index = buildRomajiIndex([
      authored(HINA, { pageId: 'old', pageTitle: '1000001 - Hina', studentName: 'Hina' }),
      authored(HINA, { pageId: 'new', pageTitle: '1000001 - Yamada Hina', studentName: 'Yamada Hina' }),
    ]);
    expect(index.get(HINA.upn)?.tokens.sort()).toEqual(['hina', 'yamada']);
  });
});

describe('fillPageIdentity', () => {
  it('fills a missing title and name from the page record, keeping what the entry has', () => {
    const bare = authored(HINA, { pageTitle: '', studentName: '', studentUpn: undefined });
    const [filled] = fillPageIdentity([bare], [
      pageRecord({ pageId: HINA.pageId, pageTitle: HINA.pageTitle, studentName: 'From record', studentUpn: HINA.upn }),
    ]);
    expect(filled).toMatchObject({ pageTitle: HINA.pageTitle, studentName: 'From record', studentUpn: HINA.upn });
    expect(fillPageIdentity([authored(KANOKO)], [pageRecord({ pageId: KANOKO.pageId, pageTitle: 'other' })])[0].pageTitle).toBe(KANOKO.pageTitle);
  });
});

describe('filterCurrentAcademicYear', () => {
  it('drops entries from earlier academic years, such as old sample diaries', () => {
    const sample = entry({ entryId: 's1', pageId: 'sample', date: 'April 24, 2020' });
    const current = [authored(HINA, { date: 'May 1, 2026' }), authored(KANOKO, { date: 'October 8, 2026' })];
    const { kept, dropped } = filterCurrentAcademicYear([sample, ...current]);
    expect(kept).toEqual(current);
    expect(dropped).toEqual([sample]);
  });

  it('treats January–March as the end of the previous academic year', () => {
    const late = authored(HINA, { date: 'February 10, 2027' });
    const { kept } = filterCurrentAcademicYear([authored(KANOKO, { date: 'June 1, 2026' }), late]);
    expect(kept).toContain(late);
  });

  it('drops a sample copied onto several pages even when students write no year', () => {
    const edited = '2026-05-01T00:00:00Z';
    const sampleOnHina = authored(HINA, { entryId: 'x1', date: 'April 16, 2020', diaryText: 'Sample diary', oneNoteLastModified: edited });
    const sampleOnKanoko = authored(KANOKO, { entryId: 'x3', date: 'April 16, 2020', diaryText: 'Sample diary', oneNoteLastModified: edited });
    const ownWork = authored(HINA, { entryId: 'x2', date: 'April 23', weekNumber: '2', oneNoteLastModified: edited });
    const { kept, dropped } = filterCurrentAcademicYear([sampleOnHina, sampleOnKanoko, ownWork]);
    expect(kept).toEqual([ownWork]);
    expect(dropped).toEqual([sampleOnHina, sampleOnKanoko]);
  });

  it('is not thrown by a typo year later than any OneNote edit', () => {
    const edited = '2026-06-01T00:00:00Z';
    const real = [
      authored(HINA, { entryId: 'r1', date: 'April 2, 2026', oneNoteLastModified: edited }),
      authored(KANOKO, { entryId: 'r2', date: 'May 1, 2026', oneNoteLastModified: edited }),
    ];
    const typo = authored(KAISEI, { entryId: 't1', date: 'May 8, 2062', oneNoteLastModified: edited });
    const sample = authored(JUN, { entryId: 's1', date: 'April 24, 2020', oneNoteLastModified: edited });
    const { kept, dropped } = filterCurrentAcademicYear([...real, typo, sample]);
    expect(kept).toEqual([...real, typo]);
    expect(dropped).toEqual([sample]);
  });

  it('keeps an old class\'s own year even if its notebook was edited recently', () => {
    const old = [
      authored(HINA, { entryId: 'o1', date: 'May 1, 2024', oneNoteLastModified: '2026-09-01T00:00:00Z' }),
      authored(KANOKO, { entryId: 'o2', date: 'April 24, 2020', oneNoteLastModified: '2026-09-01T00:00:00Z' }),
    ];
    expect(filterCurrentAcademicYear(old).dropped.map((e) => e.entryId)).toEqual(['o2']);
  });

  it('drops nothing when the only written years are old and nothing says otherwise', () => {
    const old = [authored(HINA, { date: 'April 16, 2020' }), authored(KANOKO, { date: 'May 1, 2020' })];
    expect(filterCurrentAcademicYear(old).dropped).toEqual([]);
  });
});

describe('resolveEffectiveEntries', () => {
  it('collapses a moved page: content from the live copy, group from the orphaned copy', () => {
    const before = authored(HINA, {
      pageId: 'old',
      diaryGroupId: 'g1',
      diaryGroupName: 'Group 1',
      diaryText: 'stale',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
    const after = authored(HINA, {
      pageId: 'new',
      diaryGroupId: 'g2',
      diaryGroupName: 'Group 2',
      diaryText: 'current',
      updatedAt: '2026-10-05T00:00:00.000Z',
    });
    const records = [
      pageRecord({ pageId: 'old', orphanedAt: '2026-09-20T00:00:00.000Z' }),
      pageRecord({ pageId: 'new' }),
    ];

    const [effective, ...rest] = resolveEffectiveEntries([before, after], records);

    expect(rest).toHaveLength(0);
    expect(effective.entry.diaryText).toBe('current');
    expect(effective.groupId).toBe('g1');
    expect(effective.collapsedCopies).toBe(1);
  });

  it('keeps term-2 entries that exist only on the moved page in the new group', () => {
    const term2 = authored(HINA, { pageId: 'new', diaryGroupId: 'g2', date: 'October 10, 2026', weekNumber: '2' });
    const [effective] = resolveEffectiveEntries([term2], [pageRecord({ pageId: 'new' })], {
      termBoundaries: ['2026-10-01'],
    });
    expect(effective.groupId).toBe('g2');
    expect(effective.term).toBe(2);
  });

  it('gives a year-less author the class year rather than 2001', () => {
    const items = resolveEffectiveEntries(
      [authored(HINA, { date: 'April 15' }), authored(KANOKO, { date: 'May 1, 2026' })],
      []
    );
    expect(new Date(items.find((i) => i.authorKey === HINA.upn)!.time).getFullYear()).toBe(2026);
  });

  it('does not collapse distinct weeks or different students', () => {
    const items = resolveEffectiveEntries(
      [authored(HINA), authored(HINA, { weekNumber: '4', date: 'May 8, 2026' }), authored(KANOKO)],
      []
    );
    expect(items).toHaveLength(3);
  });
});

describe('attributeComments', () => {
  const group = () => [
    authored(HINA, { peer: [['Kanoko', 'nice'], ['Kaisei', 'good'], ['Jun', 'wow']] }),
    authored(KANOKO, { peer: [['Hina', 'a'], ['Kaisei', 'b'], ['Jun', 'c']] }),
    authored(KAISEI, { peer: [['Hina', 'a'], ['Kanoko', 'b'], ['Jun', 'c']] }),
    authored(JUN, { peer: [['Hina', 'a'], ['Kanoko', 'b'], ['Kaisei', 'c']] }),
  ];

  it('suggests group members from romaji page titles', () => {
    const entries = group();
    const effective = resolveEffectiveEntries(entries, []);
    const comments = attributeComments(effective, { romajiIndex: buildRomajiIndex(entries) });

    const onHina = comments.filter((c) => c.pageId === HINA.pageId);
    expect(onHina.map((c) => [c.labelRaw, c.commenter, c.basis])).toEqual([
      ['Kanoko', { kind: 'student', key: KANOKO.upn }, 'romaji-title'],
      ['Kaisei', { kind: 'student', key: KAISEI.upn }, 'romaji-title'],
      ['Jun', { kind: 'student', key: JUN.upn }, 'romaji-title'],
    ]);
    expect(attributionCoverage(comments)).toEqual({ total: 12, confirmed: 0, suggested: 12, unresolved: 0, unspecified: 0 });
  });

  it('matches romaji-only titles written in either order', () => {
    const entries = group().map((e) => ({ ...e, pageTitle: e.pageTitle.replace(/^(\d+) - .*\((\w+) (\w+)\)$/, '$1 - $3 $2'), studentName: '' }));
    const comments = attributeComments(resolveEffectiveEntries(entries, []), { romajiIndex: buildRomajiIndex(entries) });
    expect(comments.every((c) => c.status === 'suggested' && c.basis === 'romaji-title')).toBe(true);
  });

  it('falls back to self-exclusion when titles carry no romaji', () => {
    const entries = group().map((e) => ({ ...e, pageTitle: e.pageTitle.replace(/ \(.*\)$/, ''), studentName: '学生' }));
    const comments = attributeComments(resolveEffectiveEntries(entries, []), {});

    // "Hina" appears on everyone's page but Hina's own — so it is Hina.
    const hinaLabels = comments.filter((c) => c.label === 'hina');
    expect(hinaLabels).toHaveLength(3);
    expect(hinaLabels.every((c) => c.basis === 'self-exclusion' && c.commenter?.kind === 'student' && c.commenter.key === HINA.upn)).toBe(true);
  });

  it('withholds self-exclusion when more than one member could be the author', () => {
    const entries = [
      authored(HINA, { pageTitle: 'x', studentName: 'x', peer: [['Ren', 'a']] }),
      authored(KANOKO, { pageTitle: 'x', studentName: 'x', peer: [['Ren', 'b']] }),
      authored(KAISEI, { pageTitle: 'x', studentName: 'x' }),
      authored(JUN, { pageTitle: 'x', studentName: 'x' }),
    ];
    const comments = attributeComments(resolveEffectiveEntries(entries, []), {});
    expect(comments.every((c) => c.status === 'unresolved')).toBe(true);
  });

  it('matches active interns by label, and ignores them outside their dates', () => {
    const interns: InternProfile[] = [
      { upn: 'emma@example.ac.jp', displayName: 'Emma B', labels: ['Emma'], activeFrom: '2026-04-01' },
      { upn: 'old@example.ac.jp', displayName: 'Legacy', labels: ['Sam'], activeUntil: '2026-03-31' },
    ];
    const entries = [authored(HINA, { peer: [['Emma', 'great'], ['Sam', 'hi']] })];
    const comments = attributeComments(resolveEffectiveEntries(entries, []), { interns });

    expect(comments[0]).toMatchObject({ status: 'suggested', basis: 'intern-label', commenter: { kind: 'intern', upn: 'emma@example.ac.jp' } });
    expect(comments[1]).toMatchObject({ status: 'unresolved', commenter: null });
  });

  it('prefers a group-scoped alias over a class-scoped one and marks it confirmed', () => {
    const entries = group();
    const comments = attributeComments(resolveEffectiveEntries(entries, []), {
      aliases: [
        { classId: 'c1', label: 'jun', target: { kind: 'student', key: 'someone-else' } },
        { classId: 'c1', label: 'jun', target: { kind: 'student', key: JUN.upn }, groupId: 'g1' },
      ],
    });
    const jun = comments.find((c) => c.label === 'jun')!;
    expect(jun).toMatchObject({ status: 'confirmed', basis: 'alias', commenter: { kind: 'student', key: JUN.upn } });
  });

  it('refuses to guess when a first name matches two people', () => {
    const twin = student(5, 'Abe', 'Hina');
    const entries = [...group(), authored(twin)];
    const comments = attributeComments(resolveEffectiveEntries(entries, []), { romajiIndex: buildRomajiIndex(entries) });
    const hina = comments.filter((c) => c.label === 'hina');
    expect(hina.every((c) => c.status === 'unresolved' && c.flags.includes('ambiguous'))).toBe(true);
  });

  it('suggests a match one typo away within the group', () => {
    const entries = [authored(HINA, { peer: [['Kanako', 'x']] }), authored(KANOKO), authored(KAISEI)];
    const comments = attributeComments(resolveEffectiveEntries(entries, []), { romajiIndex: buildRomajiIndex(entries) });
    expect(comments[0]).toMatchObject({ status: 'suggested', basis: 'close-spelling', commenter: { kind: 'student', key: KANOKO.upn } });
  });

  it('does not use typo tolerance on short names', () => {
    const entries = [authored(HINA, { peer: [['Jin', 'x']] }), authored(JUN)];
    const comments = attributeComments(resolveEffectiveEntries(entries, []), { romajiIndex: buildRomajiIndex(entries) });
    expect(comments[0].status).toBe('unresolved');
  });

  it('treats template tokens and headings as comments without a name', () => {
    const entries = [authored(HINA, { peer: [['AI_FEEDBACK', 'x'], ["Member's questions and answered", 'y']] })];
    const comments = attributeComments(resolveEffectiveEntries(entries, []), {});
    expect(comments.map((c) => c.status)).toEqual(['unspecified', 'unspecified']);
  });

  it('drops template and stray pages from authors and membership', () => {
    const stray = entry({ entryId: 'u1', pageId: 'u', pageTitle: 'Untitled Page', studentName: 'Untitled Page', studentUpn: undefined });
    const effective = resolveEffectiveEntries([authored(HINA), stray], []);
    expect(effective.map((item) => item.authorKey)).toEqual([HINA.upn]);
  });

  it('follows several regroups by date without any term boundary', () => {
    // Group g1 holds Hina+Kanoko in May, Hina+Kaisei in July. "Kaisei" on Hina's
    // May entry has no romaji match in May's group; in July it does.
    const entries = [
      authored(HINA, { diaryGroupId: 'g1', date: 'May 1, 2026', peer: [['Kanoko', 'a']] }),
      authored(KANOKO, { diaryGroupId: 'g1', date: 'May 1, 2026' }),
      authored(HINA, { diaryGroupId: 'g1', date: 'July 10, 2026', weekNumber: '12', peer: [['Kaisei', 'b']] }),
      authored(KAISEI, { diaryGroupId: 'g1', date: 'July 10, 2026', weekNumber: '12' }),
      authored(KANOKO, { diaryGroupId: 'g2', date: 'July 10, 2026', weekNumber: '12', peer: [['Hina', 'c']] }),
    ];
    const comments = attributeComments(resolveEffectiveEntries(entries, []), { romajiIndex: buildRomajiIndex(entries) });
    const byLabel = Object.fromEntries(comments.map((c) => [c.label, c]));
    expect(byLabel.kanoko.flags).not.toContain('cross-group');
    expect(byLabel.kaisei.flags).not.toContain('cross-group');
    // Hina was never in g2, so her comment on Kanoko's g2 page is a cross-group match.
    expect(byLabel.hina.flags).toContain('cross-group');
  });

  it('keeps Unspecified labels out of matching but in the totals', () => {
    const entries = [authored(HINA, { peer: [['Unspecified 1', 'x']] })];
    const comments = attributeComments(resolveEffectiveEntries(entries, []), {});
    expect(comments).toEqual([expect.objectContaining({ status: 'unspecified', commenter: null })]);
  });

  it('flags a label that no page title in the class could belong to', () => {
    const entries = [authored(HINA, { peer: [['Olivia', 'hi'], ['Kanoka', 'x']] }), authored(KANOKO)];
    const comments = attributeComments(resolveEffectiveEntries(entries, []), { romajiIndex: buildRomajiIndex(entries) });
    expect(comments[0].flags).toContain('no-author-match');
    expect(comments[1].flags).not.toContain('no-author-match');
  });

  it('scopes membership by term after a regroup', () => {
    // Term 1: Hina and Kanoko share g1. Term 2: Hina has moved to g2 with Jun.
    const boundaries = ['2026-10-01'];
    const entries = [
      authored(HINA, { diaryGroupId: 'g1', peer: [['Kanoko', 'a']] }),
      authored(KANOKO, { diaryGroupId: 'g1', peer: [['Hina', 'a']] }),
      authored(HINA, { diaryGroupId: 'g2', date: 'October 8, 2026', weekNumber: '1', peer: [['Jun', 'b']] }),
      authored(JUN, { diaryGroupId: 'g2', date: 'October 8, 2026', weekNumber: '1', peer: [['Hina', 'b']] }),
    ];
    const effective = resolveEffectiveEntries(entries, [], { termBoundaries: boundaries });
    const comments = attributeComments(effective, { romajiIndex: buildRomajiIndex(entries) });
    expect(comments.every((c) => c.status === 'suggested' && !c.flags.includes('cross-group'))).toBe(true);

    const grids = buildGroupGrids(effective, comments);
    const term2 = grids.find((g) => g.groupId === 'g2' && g.term === 2)!;
    expect(term2.members).toEqual([HINA.upn, JUN.upn].sort());
    expect(term2.cells.get(contributorKey({ kind: 'student', key: JUN.upn }))?.get(HINA.upn)).toBe(1);
  });
});

describe('buildGroupGrids', () => {
  it('counts unattributed comments per author instead of dropping them', () => {
    const entries = [authored(HINA, { peer: [['Unspecified 1', 'x'], ['Zed', 'y']] })];
    const effective = resolveEffectiveEntries(entries, []);
    const [grid] = buildGroupGrids(effective, attributeComments(effective, {}));
    expect(grid.cells.size).toBe(0);
    expect(grid.unattributedByAuthor.get(HINA.upn)).toBe(2);
  });

  it('can exclude suggestions so only confirmed matches fill cells', () => {
    const entries = [authored(HINA, { peer: [['Kanoko', 'x']] }), authored(KANOKO)];
    const effective = resolveEffectiveEntries(entries, []);
    const comments = attributeComments(effective, { romajiIndex: buildRomajiIndex(entries) });
    const [grid] = buildGroupGrids(effective, comments, { includeSuggested: false });
    expect(grid.cells.size).toBe(0);
  });
});

describe('departures', () => {
  it('ends group membership on the departure date', () => {
    // Kanoko leaves on 2026-06-01; "Kanoko" on Hina's July entry is no longer in-group.
    const entries = [
      authored(HINA, { date: 'May 1, 2026', peer: [['Kanoko', 'a']] }),
      authored(KANOKO, { date: 'May 1, 2026' }),
      authored(HINA, { date: 'June 10, 2026', weekNumber: '9', peer: [['Kanoko', 'b']] }),
      authored(KANOKO, { date: 'June 10, 2026', weekNumber: '9' }),
    ];
    const effective = resolveEffectiveEntries(entries, []);
    const romajiIndex = buildRomajiIndex(entries);
    const before = attributeComments(effective, { romajiIndex });
    const after = attributeComments(effective, { romajiIndex, departures: { [`c1|${KANOKO.upn}`]: '2026-06-01' } });
    expect(before.every((c) => !c.flags.includes('cross-group'))).toBe(true);
    expect(after.find((c) => c.date === 'May 1, 2026')!.flags).not.toContain('cross-group');
    expect(after.find((c) => c.date === 'June 10, 2026')!.flags).toContain('cross-group');
  });

  it('suggests a student whose diary left the shared groups, with their last entry date', () => {
    const entries = [
      authored(HINA, { pageId: 'hina-old', date: 'May 1, 2026' }),
      authored(HINA, { pageId: 'hina-old', date: 'May 8, 2026', weekNumber: '4' }),
      authored(KANOKO, { date: 'May 1, 2026' }),
      authored(KAISEI, { date: 'May 1, 2026' }),
    ];
    const records = [
      pageRecord({ pageId: 'hina-old', diaryGroupId: 'g1', orphanedAt: '2026-09-20T00:00:00Z' }),
      pageRecord({ pageId: KANOKO.pageId, diaryGroupId: 'g1' }),
      pageRecord({ pageId: KAISEI.pageId, diaryGroupId: 'g1' }),
    ];
    const suggestions = suggestDepartures(resolveEffectiveEntries(entries, records), records);
    expect(suggestions).toEqual([{ classId: 'c1', authorKey: HINA.upn, lastEntryDate: '2026-05-08' }]);
  });

  it('still suggests when the diary reappears alone in the student\'s own section', () => {
    const entries = [
      authored(HINA, { pageId: 'own', diaryGroupId: 'own-section', date: 'May 1, 2026' }),
      authored(KANOKO, { date: 'May 1, 2026' }),
      authored(KAISEI, { date: 'May 1, 2026' }),
    ];
    const records = [
      pageRecord({ pageId: 'own', diaryGroupId: 'own-section' }),
      pageRecord({ pageId: KANOKO.pageId, diaryGroupId: 'g1' }),
      pageRecord({ pageId: KAISEI.pageId, diaryGroupId: 'g1' }),
    ];
    expect(suggestDepartures(resolveEffectiveEntries(entries, records), records).map((s) => s.authorKey)).toEqual([HINA.upn]);
  });

  it('does not suggest students whose page was only moved to another group, or who were skipped', () => {
    const entries = [authored(HINA, { pageId: 'new', diaryGroupId: 'g2' }), authored(KANOKO, { diaryGroupId: 'g2' })];
    const records = [pageRecord({ pageId: 'new', diaryGroupId: 'g2' }), pageRecord({ pageId: KANOKO.pageId, diaryGroupId: 'g2' })];
    expect(suggestDepartures(resolveEffectiveEntries(entries, records), records)).toEqual([]);
    const orphanOnly = [pageRecord({ pageId: HINA.pageId, orphanedAt: '2026-09-20T00:00:00Z' })];
    expect(suggestDepartures(resolveEffectiveEntries([authored(HINA)], orphanOnly), orphanOnly, new Set([`c1|${HINA.upn}`]))).toEqual([]);
  });
});

describe('intern group coverage', () => {
  it('matches groups by number and treats an empty list as the whole class', async () => {
    const { diaryGroupKey, internCoversGroup } = await import('./contributorAttribution');
    expect(diaryGroupKey('Diary Group 1 - 10-08')).toBe(diaryGroupKey('Diary Group 1'));
    expect(diaryGroupKey('Diary Group １')).toBe('group-1');
    const intern = {
      upn: 'a@x.jp',
      displayName: 'Ahlan',
      labels: ['Ahlan'],
      assignments: [{ classId: 'eduB', groups: ['Diary Group 1', 'Diary Group 2'] }, { classId: 'nutri', groups: [] }],
    };
    expect(internCoversGroup(intern, 'eduB', 'Diary Group 2')).toBe(true);
    expect(internCoversGroup(intern, 'eduB', 'Diary Group 3')).toBe(false);
    expect(internCoversGroup(intern, 'nutri', 'Diary Group 3')).toBe(true);
    expect(internCoversGroup(intern, 'eduA', 'Diary Group 1')).toBe(false);
  });
});
