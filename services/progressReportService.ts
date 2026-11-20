import type { ExportFormat, NotebookNode, ParsedDiaryEntry, ParsedPageContent, ParserMode, TemplateVersion } from '../types';

export interface ProgressRubricConfig {
  entryTarget: number;
  metadataFieldsPerEntry: number;
  photoTargetPerEntry: number;
  diaryMinWords: number;
  vocabTargetPerEntry: number;
}

export interface ProgressVocabScoreOverride {
  japaneseComplete: number;
  englishOrExampleComplete: number;
}

export const DEFAULT_PROGRESS_RUBRIC: ProgressRubricConfig = {
  entryTarget: 13,
  metadataFieldsPerEntry: 3,
  photoTargetPerEntry: 2,
  diaryMinWords: 25,
  vocabTargetPerEntry: 3,
};

export interface ProgressPageSource {
  classId: string;
  className: string;
  diaryGroupId?: string;
  diaryGroupName?: string;
  pageId: string;
  pageTitle: string;
  studentName: string;
  studentNumber?: string;
  studentUpn?: string;
  oneNoteLastModified?: string;
}

export interface ProgressPageScore extends ProgressPageSource {
  scanStatus: 'scored' | 'parse_failed' | 'scan_failed';
  parserMode: ParserMode;
  templateVersion: TemplateVersion;
  entriesFound: number;
  metadataComplete: number;
  photosFound: number;
  diaryValidEntries: number;
  vocabJapaneseComplete: number;
  vocabEnglishOrExampleComplete: number;
  aiFeedbackBoosterCount: number;
  parseWarnings: string[];
  source: 'cache' | 'memory' | 'fresh';
}

export interface ProgressExportRow {
  StudentName: string;
  StudentUPN: string;
  Class: string;
  ClassID: string;
  ScanStatus: string;
  EntriesFound: number;
  EntryTarget: number;
  EntryPct: number;
  MetadataComplete: number;
  MetadataTarget: number;
  MetadataPct: number;
  PhotosFound: number;
  PhotoTarget: number;
  PhotoPct: number;
  DiaryValidEntries: number;
  DiaryTarget: number;
  DiaryPct: number;
  VocabJapaneseComplete: number;
  VocabJapaneseTarget: number;
  VocabJapanesePct: number;
  VocabEnglishOrExampleComplete: number;
  VocabEnglishOrExampleTarget: number;
  VocabEnglishOrExamplePct: number;
  AiFeedbackBoosterCount: number;
  PagesScored: number;
  PagesFromCache: number;
  PagesFetched: number;
  PagesFailed: number;
  ParseWarningCount: number;
  ProgressNotes: string;
  MissingSummary: string;
}

export interface ProgressExportStats {
  students: number;
  pages: number;
  cachedPages: number;
  memoryPages: number;
  fetchedPages: number;
  parseWarningCount: number;
}

export interface ProgressExportResult {
  rows: ProgressExportRow[];
  stats: ProgressExportStats;
}

export interface ProgressExportOptions {
  format: ExportFormat;
  scopeLabel?: string;
}

export const normalizeProgressText = (value?: string): string =>
  (value || '').replace(/\s+/g, ' ').trim();

export const countDiaryWords = (value?: string): number => {
  const text = normalizeProgressText(value);
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
};

const hasText = (value?: string): boolean => normalizeProgressText(value).length > 0;

const percent = (value: number, target: number): number =>
  target <= 0 ? 0 : Math.round((Math.min(value, target) / target) * 100);

const cappedSum = (values: number[], target: number): number =>
  Math.min(
    target,
    values.reduce((sum, value) => sum + Math.max(0, value || 0), 0),
  );

const semanticEntryKey = (entry: ParsedDiaryEntry, index: number): string => {
  const date = normalizeProgressText(entry.date).toLowerCase();
  const week = normalizeProgressText(entry.weekNumber).toLowerCase();
  if (date || week) return `slot:${date}|${week}`;
  const diary = normalizeProgressText(entry.diaryText).toLowerCase().slice(0, 160);
  return diary ? `diary:${diary}` : `idx:${index}`;
};

export const collapseProgressEntries = (entries: ParsedPageContent): ParsedPageContent => {
  const bySlot = new Map<string, ParsedDiaryEntry>();
  entries.forEach((entry, index) => {
    const key = semanticEntryKey(entry, index);
    const current = bySlot.get(key);
    if (!current) {
      bySlot.set(key, entry);
      return;
    }

    const currentScore = countEntrySignals(current);
    const candidateScore = countEntrySignals(entry);
    bySlot.set(key, candidateScore > currentScore ? entry : current);
  });
  return Array.from(bySlot.values());
};

const countEntrySignals = (entry: ParsedDiaryEntry): number =>
  [
    hasText(entry.date),
    hasText(entry.weather),
    hasText(entry.weekNumber),
    countDiaryWords(entry.diaryText) > 0,
    entry.photoCount > 0,
    entry.translations.some((item) => hasText(item.japanese)),
    entry.translations.some((item) => hasText(item.englishDefinition) || hasText(item.englishExample)),
    Boolean(entry.chatbotFeedback.present),
  ].filter(Boolean).length;

export const scoreProgressPage = (
  source: ProgressPageSource,
  entries: ParsedPageContent,
  parserMode: ParserMode,
  templateVersion: TemplateVersion,
  cacheSource: ProgressPageScore['source'],
  rubric: ProgressRubricConfig = DEFAULT_PROGRESS_RUBRIC,
  vocabOverride?: ProgressVocabScoreOverride,
): ProgressPageScore => {
  const normalizedEntries = collapseProgressEntries(entries);
  const metadataTarget = rubric.entryTarget * rubric.metadataFieldsPerEntry;
  const photoTarget = rubric.entryTarget * rubric.photoTargetPerEntry;
  const vocabTarget = rubric.entryTarget * rubric.vocabTargetPerEntry;

  const entryWarnings = normalizedEntries.flatMap((entry) => entry.parseWarnings ?? []);

  return {
    ...source,
    scanStatus: normalizedEntries.length === 0 ? 'parse_failed' : 'scored',
    parserMode,
    templateVersion,
    entriesFound: normalizedEntries.length,
    metadataComplete: cappedSum(
      normalizedEntries.map((entry) =>
        [entry.date, entry.weather, entry.weekNumber].filter((value) => hasText(value)).length,
      ),
      metadataTarget,
    ),
    photosFound: cappedSum(
      normalizedEntries.map((entry) => entry.photoCount),
      photoTarget,
    ),
    diaryValidEntries: cappedSum(
      normalizedEntries.map((entry) => countDiaryWords(entry.diaryText) >= rubric.diaryMinWords ? 1 : 0),
      rubric.entryTarget,
    ),
    vocabJapaneseComplete: vocabOverride
      ? Math.min(vocabTarget, vocabOverride.japaneseComplete)
      : cappedSum(
          normalizedEntries.map((entry) =>
            entry.translations.filter((item) => hasText(item.japanese)).length,
          ),
          vocabTarget,
        ),
    vocabEnglishOrExampleComplete: vocabOverride
      ? Math.min(vocabTarget, vocabOverride.englishOrExampleComplete)
      : cappedSum(
          normalizedEntries.map((entry) =>
            Math.max(
              entry.vocabItems.filter((item) => hasText(item.wordOrPhrase)).length,
              entry.translations.filter((item) => hasText(item.englishDefinition) || hasText(item.englishExample)).length,
            ),
          ),
          vocabTarget,
        ),
    aiFeedbackBoosterCount: normalizedEntries.filter((entry) =>
      entry.chatbotFeedback.present || hasText(entry.chatbotFeedback.data),
    ).length,
    parseWarnings:
      normalizedEntries.length === 0
        ? ['Parser returned 0 entries from this OneNote page.']
        : entryWarnings,
    source: cacheSource,
  };
};

const studentKey = (score: Pick<ProgressPageScore, 'classId' | 'studentUpn' | 'studentName'>): string => {
  const upnLocal = score.studentUpn?.split('@')[0]?.trim().toLowerCase();
  return `${score.classId}::${upnLocal || score.studentName.trim().toLowerCase()}`;
};

const missingSummary = (
  row: Omit<ProgressExportRow, 'MissingSummary'>,
): string => {
  if (row.ScanStatus === 'needs_review') {
    return 'Scan failed or parser found no entries; progress not scored';
  }

  const missing: string[] = [];
  const add = (label: string, complete: number, target: number) => {
    const deficit = Math.max(0, target - complete);
    if (deficit > 0) missing.push(`${label}: ${deficit} short`);
  };

  add('entries', Math.min(row.EntriesFound, row.EntryTarget), row.EntryTarget);
  add('metadata cells', row.MetadataComplete, row.MetadataTarget);
  add('photos', row.PhotosFound, row.PhotoTarget);
  add('valid diary entries', row.DiaryValidEntries, row.DiaryTarget);
  add('vocab Japanese', row.VocabJapaneseComplete, row.VocabJapaneseTarget);
  add('vocab English/example', row.VocabEnglishOrExampleComplete, row.VocabEnglishOrExampleTarget);

  return missing.length > 0 ? missing.join('; ') : 'Complete for target rubric';
};

export const buildProgressExport = (
  scores: ProgressPageScore[],
  rubric: ProgressRubricConfig = DEFAULT_PROGRESS_RUBRIC,
): ProgressExportResult => {
  const grouped = new Map<string, ProgressPageScore[]>();
  scores.forEach((score) => {
    const key = studentKey(score);
    const group = grouped.get(key) || [];
    group.push(score);
    grouped.set(key, group);
  });

  const metadataTarget = rubric.entryTarget * rubric.metadataFieldsPerEntry;
  const photoTarget = rubric.entryTarget * rubric.photoTargetPerEntry;
  const vocabTarget = rubric.entryTarget * rubric.vocabTargetPerEntry;

  const rows = Array.from(grouped.values())
    .map((group) => {
      const first = group[0];
      const entriesFound = group.reduce((sum, score) => sum + score.entriesFound, 0);
      const metadataComplete = Math.min(metadataTarget, group.reduce((sum, score) => sum + score.metadataComplete, 0));
      const photosFound = Math.min(photoTarget, group.reduce((sum, score) => sum + score.photosFound, 0));
      const diaryValidEntries = Math.min(rubric.entryTarget, group.reduce((sum, score) => sum + score.diaryValidEntries, 0));
      const vocabJapaneseComplete = Math.min(vocabTarget, group.reduce((sum, score) => sum + score.vocabJapaneseComplete, 0));
      const vocabEnglishOrExampleComplete = Math.min(vocabTarget, group.reduce((sum, score) => sum + score.vocabEnglishOrExampleComplete, 0));
      const aiFeedbackBoosterCount = group.reduce((sum, score) => sum + score.aiFeedbackBoosterCount, 0);
      const parseWarningCount = group.reduce((sum, score) => sum + score.parseWarnings.length, 0);
      const pagesFromCache = group.filter((score) => score.source === 'cache').length;
      const pagesFromMemory = group.filter((score) => score.source === 'memory').length;
      const pagesFailed = group.filter((score) => score.scanStatus !== 'scored').length;
      const scanStatus =
        pagesFailed === 0
          ? 'scored'
          : pagesFailed === group.length
            ? 'needs_review'
            : 'partial_review';
      const progressNotes = group
        .flatMap((score) =>
          score.parseWarnings.map((warning) =>
            `${score.pageTitle || score.studentName}: ${warning}`,
          ),
        )
        .join(' | ');
      const baseRow = {
        StudentName: first.studentName,
        StudentUPN: first.studentUpn || '',
        Class: first.className,
        ClassID: first.classId,
        ScanStatus: scanStatus,
        EntriesFound: entriesFound,
        EntryTarget: rubric.entryTarget,
        EntryPct: percent(entriesFound, rubric.entryTarget),
        MetadataComplete: metadataComplete,
        MetadataTarget: metadataTarget,
        MetadataPct: percent(metadataComplete, metadataTarget),
        PhotosFound: photosFound,
        PhotoTarget: photoTarget,
        PhotoPct: percent(photosFound, photoTarget),
        DiaryValidEntries: diaryValidEntries,
        DiaryTarget: rubric.entryTarget,
        DiaryPct: percent(diaryValidEntries, rubric.entryTarget),
        VocabJapaneseComplete: vocabJapaneseComplete,
        VocabJapaneseTarget: vocabTarget,
        VocabJapanesePct: percent(vocabJapaneseComplete, vocabTarget),
        VocabEnglishOrExampleComplete: vocabEnglishOrExampleComplete,
        VocabEnglishOrExampleTarget: vocabTarget,
        VocabEnglishOrExamplePct: percent(vocabEnglishOrExampleComplete, vocabTarget),
        AiFeedbackBoosterCount: aiFeedbackBoosterCount,
        PagesScored: group.length,
        PagesFromCache: pagesFromCache + pagesFromMemory,
        PagesFetched: group.filter((score) => score.source === 'fresh').length,
        PagesFailed: pagesFailed,
        ParseWarningCount: parseWarningCount,
        ProgressNotes: progressNotes,
      };

      return {
        ...baseRow,
        MissingSummary: missingSummary(baseRow),
      };
    })
    .sort((left, right) => {
      const classCompare = left.Class.localeCompare(right.Class);
      if (classCompare !== 0) return classCompare;
      return left.StudentName.localeCompare(right.StudentName);
    });

  return {
    rows,
    stats: {
      students: rows.length,
      pages: scores.length,
      cachedPages: scores.filter((score) => score.source === 'cache').length,
      memoryPages: scores.filter((score) => score.source === 'memory').length,
      fetchedPages: scores.filter((score) => score.source === 'fresh').length,
      parseWarningCount: scores.reduce((sum, score) => sum + score.parseWarnings.length, 0),
    },
  };
};

export const collectLoadedProgressPages = (
  notebookTree: NotebookNode[],
  selectedClassIds: Set<string>,
): ProgressPageSource[] => {
  const pages: ProgressPageSource[] = [];

  notebookTree.forEach((classNode) => {
    if (!selectedClassIds.has(classNode.id)) return;
    classNode.children?.forEach((sectionGroup) => {
      sectionGroup.children?.forEach((section) => {
        section.children?.forEach((page) => {
          if (page.type !== 'page') return;
          const studentNumber = extractStudentNumber(page.displayName);
          if (!studentNumber) return;

          const rawStudentName =
            /collaboration space|content library/i.test(sectionGroup.displayName)
              ? page.displayName
              : sectionGroup.displayName;
          pages.push({
            classId: classNode.id,
            className: classNode.displayName,
            diaryGroupId: section.id,
            diaryGroupName: section.displayName,
            pageId: page.id,
            pageTitle: cleanPageTitle(page.displayName),
            studentName: cleanStudentName(rawStudentName),
            studentNumber,
            oneNoteLastModified: page.lastModified,
          });
        });
      });
    });
  });

  return pages;
};

export const cleanPageTitle = (value: string): string =>
  value.replace(/^[*?]\s*/, '').trim();

export const cleanStudentName = (value: string): string =>
  cleanPageTitle(value).replace(/^\d{7}\s*[-:]\s*/, '').trim();

export const extractStudentNumber = (value: string): string | undefined => {
  const directMatch = value.match(/(?<!\d)(\d{7})(?!\d)/);
  if (directMatch) return directMatch[1];

  const upnStyleMatch = value.match(/[a-z]{2}(\d{7})/i);
  return upnStyleMatch ? upnStyleMatch[1] : undefined;
};

export const progressCacheKey = (
  page: Pick<ProgressPageSource, 'pageId' | 'oneNoteLastModified'>,
  parserMode: ParserMode,
  templateVersion: TemplateVersion,
  rubric: ProgressRubricConfig = DEFAULT_PROGRESS_RUBRIC,
): string =>
  [
    'progress-report-v4',
    page.pageId,
    page.oneNoteLastModified || 'unknown-version',
    parserMode,
    templateVersion,
    rubric.entryTarget,
    rubric.diaryMinWords,
    rubric.photoTargetPerEntry,
    rubric.vocabTargetPerEntry,
  ].join('::');
