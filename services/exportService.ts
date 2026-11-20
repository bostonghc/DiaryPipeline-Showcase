
import * as XLSX from 'xlsx';
import { ExportFieldGroup, ExportFormat, ExportPreset, PageSyncRecord, StoredDiaryEntry, TeacherFeedbackFields } from '../types';
import type { ProgressExportOptions, ProgressExportRow } from './progressReportService';

const stringifyFeedback = (feedback: TeacherFeedbackFields) =>
  (Object.entries(feedback) as [string, string | undefined][])
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

const sanitizeFilenamePart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'export';

const formatExportTimestamp = (date = new Date()): string => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}_${hh}${min}`;
};

const normalizeDateTimeValue = (value?: string): string => {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString();
};

const deriveStudentKey = (entry: StoredDiaryEntry): string => {
  const upnLocalPart = entry.studentUpn?.split('@')[0]?.trim().toLowerCase();
  if (upnLocalPart) return upnLocalPart;
  if (entry.studentGraphId) return entry.studentGraphId;
  return sanitizeFilenamePart(entry.studentName || 'student');
};

const semanticEntryKey = (entry: StoredDiaryEntry): string => {
  const prefix = `${entry.pageId}_`;
  return entry.entryId.startsWith(prefix) ? entry.entryId.slice(prefix.length) : entry.entryId;
};

const entryQualityScore = (entry: StoredDiaryEntry): number =>
  [
    entry.pageTitle,
    entry.diaryGroupId,
    entry.diaryGroupName,
    entry.studentName,
    entry.studentGraphId,
    entry.studentUpn,
    entry.date,
    entry.weekNumber,
    entry.weather,
    entry.diaryText,
    entry.peerFeedback.length ? 'peer' : '',
    entry.vocabItems.length ? 'vocab' : '',
    entry.translations.length ? 'translations' : '',
    entry.chatbotFeedback.present ? 'chatbot' : '',
    entry.oneNoteLastModified,
    entry.approvedAt,
  ].filter(Boolean).length;

const compareEntries = (left: StoredDiaryEntry, right: StoredDiaryEntry): number => {
  const updatedDiff =
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  if (updatedDiff !== 0) return updatedDiff;

  const approvedDiff =
    new Date(right.approvedAt || 0).getTime() - new Date(left.approvedAt || 0).getTime();
  if (approvedDiff !== 0) return approvedDiff;

  return entryQualityScore(right) - entryQualityScore(left);
};

const mergeDuplicateEntries = (entries: StoredDiaryEntry[]): StoredDiaryEntry => {
  const ordered = [...entries].sort(compareEntries);
  const primary = ordered[0];
  const firstNonEmpty = <T>(picker: (entry: StoredDiaryEntry) => T): T => {
    for (const entry of ordered) {
      const value = picker(entry);
      if (Array.isArray(value)) {
        if (value.length > 0) return value as T;
      } else if (value && value !== '') {
        return value;
      }
    }
    return picker(primary);
  };

  return {
    ...primary,
    pageTitle: firstNonEmpty((entry) => entry.pageTitle),
    diaryGroupId: firstNonEmpty((entry) => entry.diaryGroupId || ''),
    diaryGroupName: firstNonEmpty((entry) => entry.diaryGroupName || ''),
    studentName: firstNonEmpty((entry) => entry.studentName),
    studentGraphId: firstNonEmpty((entry) => entry.studentGraphId || ''),
    studentUpn: firstNonEmpty((entry) => entry.studentUpn || ''),
    date: firstNonEmpty((entry) => entry.date),
    weekNumber: firstNonEmpty((entry) => entry.weekNumber),
    weather: firstNonEmpty((entry) => entry.weather),
    diaryText: firstNonEmpty((entry) => entry.diaryText),
    peerFeedback: firstNonEmpty((entry) => entry.peerFeedback),
    translations: firstNonEmpty((entry) => entry.translations),
    vocabItems: firstNonEmpty((entry) => entry.vocabItems),
    vocabCount: Math.max(...ordered.map((entry) => entry.vocabCount || 0)),
    photoCount: Math.max(...ordered.map((entry) => entry.photoCount || 0)),
    translationCount: Math.max(...ordered.map((entry) => entry.translationCount || 0)),
    chatbotFeedback: firstNonEmpty((entry) => (entry.chatbotFeedback.present ? entry.chatbotFeedback : null)) || primary.chatbotFeedback,
    teacherFeedback: ordered.reduceRight((acc, entry) => ({ ...acc, ...entry.teacherFeedback }), {}),
    oneNoteLastModified: firstNonEmpty((entry) => entry.oneNoteLastModified || ''),
    approvedAt: firstNonEmpty((entry) => entry.approvedAt || ''),
    updatedAt: ordered
      .map((entry) => entry.updatedAt)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || primary.updatedAt,
  };
};

const dedupeAndSortEntries = (entries: StoredDiaryEntry[]): StoredDiaryEntry[] => {
  const grouped = new Map<string, StoredDiaryEntry[]>();
  entries.forEach((entry) => {
    const key = `${entry.pageId}::${semanticEntryKey(entry)}`;
    const group = grouped.get(key) || [];
    group.push(entry);
    grouped.set(key, group);
  });

  return Array.from(grouped.values())
    .map((group) => mergeDuplicateEntries(group))
    .sort((left, right) => {
      const classCompare = left.classId.localeCompare(right.classId);
      if (classCompare !== 0) return classCompare;
      const studentCompare = left.studentName.localeCompare(right.studentName);
      if (studentCompare !== 0) return studentCompare;
      const pageCompare = left.pageId.localeCompare(right.pageId);
      if (pageCompare !== 0) return pageCompare;
      return semanticEntryKey(left).localeCompare(semanticEntryKey(right));
    });
};

type ExportOptions = {
  scopeLabel?: string;
};

const downloadRows = (
  rows: Record<string, string | number>[],
  format: ExportFormat,
  fileStem: string,
  sheetName = 'Journal Entries',
): void => {
  if (format === ExportFormat.JSON) {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileStem}.json`;
    a.click();
  } else if (format === ExportFormat.CSV) {
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const csv = XLSX.utils.sheet_to_csv(worksheet);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileStem}.csv`;
    a.click();
  } else {
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    XLSX.writeFile(workbook, `${fileStem}.xlsx`);
  }
};

export const exportData = (
  entries: StoredDiaryEntry[],
  format: ExportFormat,
  options: ExportOptions = {}
) => {
  const normalizedEntries = dedupeAndSortEntries(entries);
  const rows = normalizedEntries.map((entry) => ({
    EntryID: entry.entryId,
    ClassID: entry.classId,
    DiaryGroupID: entry.diaryGroupId || '',
    DiaryGroupName: entry.diaryGroupName || '',
    PageID: entry.pageId,
    PageTitle: entry.pageTitle,
    StudentName: entry.studentName,
    StudentGraphId: entry.studentGraphId || '',
    StudentUPN: entry.studentUpn || '',
    StudentKey: deriveStudentKey(entry),
    Date: entry.date,
    WeekNumber: entry.weekNumber,
    Weather: entry.weather,
    DiaryText: entry.diaryText,
    VocabCount: entry.vocabCount,
    PhotoCount: entry.photoCount,
    TranslationCount: entry.translationCount,
    PeerFeedback: entry.peerFeedback.map((item) => `[${item.contributor}] ${item.feedback}`).join('\n'),
    VocabularyItems: entry.vocabItems.map((item) => item.wordOrPhrase).join(' | '),
    Translations: entry.translations
      .map((item) => [item.japanese, item.englishDefinition, item.englishExample].filter(Boolean).join(' | '))
      .join('\n'),
    ChatbotFeedback: entry.chatbotFeedback.present ? (entry.chatbotFeedback.data ?? '') : '',
    TeacherFeedback: stringifyFeedback(entry.teacherFeedback),
    Status: entry.status,
    ParserMode: entry.parserMode,
    TemplateVersion: entry.templateVersion,
    OneNoteLastModified: normalizeDateTimeValue(entry.oneNoteLastModified),
    ApprovedAt: normalizeDateTimeValue(entry.approvedAt),
    UpdatedAt: normalizeDateTimeValue(entry.updatedAt),
  }));
  const fileStem = [
    'journal-export',
    formatExportTimestamp(),
    sanitizeFilenamePart(options.scopeLabel || `${normalizedEntries.length}-entries`),
    `${normalizedEntries.length}entries`,
  ].join('_');
  downloadRows(rows, format, fileStem);
};

const buildRowForGroups = (
  entry: StoredDiaryEntry,
  groups: ExportFieldGroup[],
): Record<string, string | number> => {
  const row: Record<string, string | number> = {};

  if (groups.includes('identity')) {
    row.StudentName = entry.studentName;
    row.StudentUPN = entry.studentUpn || '';
    row.StudentKey = deriveStudentKey(entry);
    row.ClassID = entry.classId;
    row.DiaryGroupName = entry.diaryGroupName || '';
  }
  if (groups.includes('dates')) {
    row.Date = entry.date;
    row.WeekNumber = entry.weekNumber;
  }
  if (groups.includes('status')) {
    row.Status = entry.status;
    row.ApprovedAt = normalizeDateTimeValue(entry.approvedAt);
    row.UpdatedAt = normalizeDateTimeValue(entry.updatedAt);
  }
  if (groups.includes('counts')) {
    row.VocabCount = entry.vocabCount;
    row.PhotoCount = entry.photoCount;
    row.TranslationCount = entry.translationCount;
    row.PeerFeedbackCount = entry.peerFeedback.length;
  }
  if (groups.includes('content')) {
    row.DiaryText = entry.diaryText;
    row.PeerFeedback = entry.peerFeedback
      .map((p) => `[${p.contributor}] ${p.feedback}`)
      .join('\n');
    row.VocabularyItems = entry.vocabItems.map((v) => v.wordOrPhrase).join(' | ');
    row.Translations = entry.translations
      .map((t) => [t.japanese, t.englishDefinition, t.englishExample].filter(Boolean).join(' | '))
      .join('\n');
    row.ChatbotFeedback = entry.chatbotFeedback.present ? (entry.chatbotFeedback.data ?? '') : '';
  }
  if (groups.includes('feedback')) {
    row.Feedback_DiaryText = entry.teacherFeedback.diaryText ?? '';
    row.Feedback_PeerFeedback = entry.teacherFeedback.peerFeedback ?? '';
    row.Feedback_Vocab = entry.teacherFeedback.vocab ?? '';
    row.Feedback_Translations = entry.teacherFeedback.translations ?? '';
    row.Feedback_Chatbot = entry.teacherFeedback.chatbot ?? '';
    row.Feedback_Overall = entry.teacherFeedback.overall ?? '';
  }
  if (groups.includes('metadata')) {
    row.EntryID = entry.entryId;
    row.PageID = entry.pageId;
    row.PageTitle = entry.pageTitle;
    row.DiaryGroupID = entry.diaryGroupId || '';
    row.StudentGraphId = entry.studentGraphId || '';
    row.ParserMode = entry.parserMode;
    row.TemplateVersion = entry.templateVersion;
    row.OneNoteLastModified = normalizeDateTimeValue(entry.oneNoteLastModified);
    row.ParseWarnings = (entry.parseWarnings ?? []).join(' | ');
  }

  return row;
};

export const exportDataWithPreset = (
  entries: StoredDiaryEntry[],
  preset: ExportPreset,
  studentKeyFilter: Set<string> | null,
  options: ExportOptions = {},
): void => {
  const statusFiltered =
    preset.statusFilter === 'all'
      ? entries
      : entries.filter((e) => (preset.statusFilter as string[]).includes(e.status));

  const studentFiltered =
    studentKeyFilter === null
      ? statusFiltered
      : statusFiltered.filter((e) => studentKeyFilter.has(deriveStudentKey(e)));

  const normalized = dedupeAndSortEntries(studentFiltered);
  const rows = normalized.map((e) => buildRowForGroups(e, preset.fieldGroups));

  const fileStem = [
    `journal-${sanitizeFilenamePart(preset.name)}`,
    formatExportTimestamp(),
    sanitizeFilenamePart(options.scopeLabel || `${normalized.length}-entries`),
    `${normalized.length}entries`,
  ].join('_');

  downloadRows(rows, preset.format, fileStem);
};

type CoverageOptions = ExportOptions & {
  format: ExportFormat;
  classNameById: Record<string, string>;
};

/**
 * Page-record coverage export. Unlike the entry exports above, this operates on
 * PageSyncRecord rows, not saved entries — one row per discovered page. It makes
 * the discovered-vs-produced gap explicit: pages that synced but parsed to zero
 * entries, error/rate-limited pages, and which page records are represented in
 * the entry export. EntryCount is the actual count of saved entries for the page
 * (not the record's stored count), and HasSavedEntries is derived from that, so
 * the export is stable and understandable on its own, independent of any entry
 * preset. It does NOT include roster students with no discovered page record.
 */
export const exportCoverage = (
  pageRecords: PageSyncRecord[],
  entries: StoredDiaryEntry[],
  options: CoverageOptions,
): void => {
  const entryCountByPage = entries.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.pageId] = (acc[entry.pageId] ?? 0) + 1;
    return acc;
  }, {});

  const classNameFor = (classId: string) => options.classNameById[classId] ?? classId;

  const sorted = [...pageRecords].sort((a, b) => {
    const classCompare = classNameFor(a.classId).localeCompare(classNameFor(b.classId));
    if (classCompare !== 0) return classCompare;
    const studentCompare = (a.studentName || '').localeCompare(b.studentName || '');
    if (studentCompare !== 0) return studentCompare;
    return (a.pageTitle || '').localeCompare(b.pageTitle || '');
  });

  const rows = sorted.map((record) => {
    const entryCount = entryCountByPage[record.pageId] ?? 0;
    return {
      Class: classNameFor(record.classId),
      StudentName: record.studentName || '',
      StudentUPN: record.studentUpn || '',
      StudentGraphId: record.studentGraphId || '',
      DiaryGroupName: record.diaryGroupName || '',
      PageTitle: record.pageTitle || '',
      SyncState: record.syncState,
      EntryCount: entryCount,
      HasSavedEntries: entryCount > 0 ? 'yes' : 'no',
      ParserMode: record.parserMode,
      TemplateVersion: record.templateVersion,
      OneNoteLastModified: normalizeDateTimeValue(record.oneNoteLastModified),
      LastParsedAt: normalizeDateTimeValue(record.lastParsedAt),
      LastError: record.lastError || '',
    };
  });

  const fileStem = [
    'coverage',
    formatExportTimestamp(),
    sanitizeFilenamePart(options.scopeLabel || `${sorted.length}-pages`),
    `${sorted.length}pages`,
  ].join('_');

  downloadRows(rows, options.format, fileStem, 'Coverage');
};

export const exportProgressRows = (
  rows: ProgressExportRow[],
  options: ProgressExportOptions,
): void => {
  const fileStem = [
    'progress',
    formatExportTimestamp(),
    sanitizeFilenamePart(options.scopeLabel || `${rows.length}-students`),
    `${rows.length}students`,
  ].join('_');

  downloadRows(rows as unknown as Record<string, string | number>[], options.format, fileStem, 'Progress');
};
