import type {
  EntryStatus,
  ParsedDiaryEntry,
  ParsedPageContent,
  TeacherFeedbackFields,
} from '../types';

export const BULK_READY_MIN_DIARY_CHARS = 30;

export type EntryWorkflowUiState = 'draft' | 'unsaved' | 'ready';
export type ReadyEligibility = 'ready' | 'needs_override' | 'blocked';

export interface BulkReadyCandidate {
  entry: ParsedDiaryEntry;
  index: number;
}

export interface BulkReadySelection {
  ready: BulkReadyCandidate[];
  skipped: BulkReadyCandidate[];
}

export interface PageWorkflowSummary {
  total: number;
  sent: number;
  ready: number;
  unsaved: number;
  draft: number;
}

export const normalizeStudentWriting = (value?: string): string =>
  (value || '').replace(/\s+/g, ' ').trim();

export const hasStudentDiaryWriting = (
  entry: Pick<ParsedDiaryEntry, 'diaryText'>,
  minChars = BULK_READY_MIN_DIARY_CHARS
): boolean => normalizeStudentWriting(entry.diaryText).length >= minChars;

export const hasParsedStudentFacingContent = (entry: ParsedDiaryEntry): boolean =>
  normalizeStudentWriting(entry.diaryText).length > 0 ||
  (entry.peerFeedback || []).length > 0 ||
  (entry.vocabItems || []).length > 0 ||
  (entry.translations || []).length > 0 ||
  Boolean(entry.chatbotFeedback?.present && normalizeStudentWriting(entry.chatbotFeedback.data).length > 0);

export const selectBulkReadyEntries = (
  entries: ParsedPageContent,
  minChars = BULK_READY_MIN_DIARY_CHARS
): BulkReadySelection =>
  entries.reduce<BulkReadySelection>(
    (selection, entry, index) => {
      const bucket = hasStudentDiaryWriting(entry, minChars)
        ? selection.ready
        : selection.skipped;
      bucket.push({ entry, index });
      return selection;
    },
    { ready: [], skipped: [] }
  );

const TEACHER_FEEDBACK_COMPARE_KEYS: Array<keyof TeacherFeedbackFields> = [
  'diaryText',
  'peerFeedback',
  'vocab',
  'translations',
  'chatbot',
  'overall',
  'date',
  'weather',
  'weekNumber',
  'photos',
];

const STUDENT_FACING_FEEDBACK_KEYS: Array<keyof TeacherFeedbackFields> = [
  'diaryText',
  'peerFeedback',
  'vocab',
  'translations',
  'chatbot',
  'overall',
];

const normalizeFeedbackValue = (value?: string): string =>
  (value || '').replace(/\s+/g, ' ').trim();

export const hasTeacherFeedbackText = (
  feedback?: TeacherFeedbackFields,
  keys: Array<keyof TeacherFeedbackFields> = STUDENT_FACING_FEEDBACK_KEYS
): boolean => keys.some((key) => normalizeFeedbackValue(feedback?.[key]).length > 0);

export const hasTeacherFeedbackChanges = (
  current?: TeacherFeedbackFields,
  saved?: TeacherFeedbackFields
): boolean =>
  TEACHER_FEEDBACK_COMPARE_KEYS.some(
    (key) => normalizeFeedbackValue(current?.[key]) !== normalizeFeedbackValue(saved?.[key])
  );

export const getEntryWorkflowUiState = (
  status: EntryStatus | undefined,
  currentFeedback?: TeacherFeedbackFields,
  savedFeedback?: TeacherFeedbackFields
): EntryWorkflowUiState => {
  if (hasTeacherFeedbackChanges(currentFeedback, savedFeedback)) return 'unsaved';
  return status === 'approved' ? 'ready' : 'draft';
};

export const getEntryWorkflowLabel = (state: EntryWorkflowUiState): string => {
  switch (state) {
    case 'ready':
      return 'Feedback Ready';
    case 'unsaved':
      return 'Unsaved Changes';
    default:
      return 'Draft';
  }
};

export const getReadyEligibility = (
  entry: ParsedDiaryEntry,
  feedback?: TeacherFeedbackFields
): ReadyEligibility => {
  if (hasStudentDiaryWriting(entry)) return 'ready';
  if (hasParsedStudentFacingContent(entry) || hasTeacherFeedbackText(feedback)) {
    return 'needs_override';
  }
  return 'blocked';
};

export const getEntryWorkflowLogLabel = (status: EntryStatus): string =>
  status === 'approved' ? 'feedback ready' : 'draft';

export const summarizePageWorkflow = (
  entries: ParsedPageContent | null,
  entryStatus: Record<string, EntryStatus>,
  teacherFeedback: Record<string, TeacherFeedbackFields>,
  savedTeacherFeedback: Record<string, TeacherFeedbackFields>,
  sentEntryIds: ReadonlySet<string>
): PageWorkflowSummary | null => {
  if (!entries || entries.length === 0) return null;

  const summary: PageWorkflowSummary = {
    total: entries.length,
    sent: 0,
    ready: 0,
    unsaved: 0,
    draft: 0,
  };

  entries.forEach((entry, index) => {
    const entryKey = entry.id || String(index);
    const uiState = getEntryWorkflowUiState(
      entryStatus[entryKey],
      teacherFeedback[entryKey],
      savedTeacherFeedback[entryKey]
    );

    if (uiState === 'unsaved') {
      summary.unsaved += 1;
    } else if (entry.id && sentEntryIds.has(entry.id)) {
      summary.sent += 1;
    } else if (uiState === 'ready') {
      summary.ready += 1;
    } else {
      summary.draft += 1;
    }
  });

  return summary;
};

export const getWorkflowSummaryLabel = (summary: PageWorkflowSummary): string => {
  const parts: string[] = [];
  if (summary.sent > 0) parts.push(`${summary.sent} sent`);
  if (summary.ready > 0) parts.push(`${summary.ready} ready`);
  if (summary.unsaved > 0) parts.push(`${summary.unsaved} unsaved`);
  if (summary.draft > 0) parts.push(`${summary.draft} draft`);
  return parts.length > 0 ? parts.join(' · ') : `${summary.total} entries`;
};

export const getWorkflowSummaryClassName = (summary: PageWorkflowSummary): string => {
  if (summary.unsaved > 0) return 'bg-amber-50 text-amber-700 border-amber-200';
  if (summary.draft > 0 && (summary.ready > 0 || summary.sent > 0)) {
    return 'bg-indigo-50 text-indigo-700 border-indigo-200';
  }
  if (summary.draft > 0) return 'bg-slate-100 text-slate-600 border-slate-200';
  return 'bg-emerald-50 text-emerald-700 border-emerald-200';
};

export const getWorkflowSummaryTooltip = (summary: PageWorkflowSummary): string =>
  `${summary.total} entries on this page: ${summary.sent} sent, ${summary.ready} ready to send, ${summary.unsaved} unsaved, ${summary.draft} draft.`;
