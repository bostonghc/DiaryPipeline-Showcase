import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { Firestore } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { GraphService } from '../services/graphService';
import { draftFieldFeedback } from '../services/geminiService';
import {
  compileStructuredFeedback,
  renderBatchFeedbackToHTML,
  renderFeedbackToHTML,
  StructuredFeedback,
  FEEDBACK_FORMAT_VERSION,
} from '../services/feedbackFormatter';
import {
  getReadyEligibility,
  hasTeacherFeedbackText,
  hasTeacherFeedbackChanges,
  summarizePageWorkflow,
  type PageWorkflowSummary,
} from '../services/feedbackWorkflowService';
import {
  fetchFeedbackReviewDecisionsForPage,
  fetchRecentFeedbackForPage,
  saveFeedbackHistoryRecord,
  saveFeedbackReviewDecisionRecord,
} from '../services/firestoreDataService';
import type {
  EmailResolutionSource,
  EntryStatus,
  FeedbackHistoryRecord,
  FeedbackReviewDecisionRecord,
  FFItemCount,
  ParsedDiaryEntry,
  PriorFeedbackMode,
  TeacherFeedbackFields,
  UserConfig,
} from '../types';

export type FeedbackBatchDecision =
  | 'include_feedback'
  | 'reviewed_no_feedback'
  | 'pending';

export interface FeedbackBatchEntryOption {
  entryId: string;
  label: string;
  decision: FeedbackBatchDecision;
  isCurrent: boolean;
  hasTeacherFeedback: boolean;
}

export interface FeedbackBatchPreviewItem {
  entryId: string;
  label: string;
  isCurrent: boolean;
  feedback: StructuredFeedback;
}

export interface UseFeedbackCompositionParams {
  // Auth / persistence context
  accessToken: string | null;
  firebaseUser: User | null;
  db: Firestore;

  // User settings context
  account: any | null;
  userConfig: UserConfig;
  aiPrompts: { peerFeedback: string; vocab: string; translations: string; diaryText: string; overall: string };

  // Page-selection state
  parsedPageContent: ParsedDiaryEntry[] | null;
  activeStudentName: string;
  activeClassId: string;
  activePageId: string;
  selectedPageTitle: string;

  // Persistent per-entry edit store (owned by App.tsx, consumed here)
  teacherFeedback: Record<string, TeacherFeedbackFields>;
  setTeacherFeedback: Dispatch<
    SetStateAction<Record<string, TeacherFeedbackFields>>
  >;
  entryStatus: Record<string, EntryStatus>;

  // Persistence callback for entry-level write. App.tsx implements this
  // because the write depends on page/identity context that lives there;
  // the hook's workflow handlers invoke it. App.tsx's implementation
  // updates entryStatus and calls setSavedTeacherFeedback (returned below)
  // to commit the dirty-state baseline.
  saveEntry: (
    entry: ParsedDiaryEntry,
    entryIndex: number,
    status: EntryStatus
  ) => Promise<void>;

  // Session controls (from FeedbackWorkspace)
  ffItemCount: FFItemCount;
  priorFeedback: PriorFeedbackMode;
  pastFeedbackForStudent: FeedbackHistoryRecord[];
  onFeedbackHistorySaved?: (record: FeedbackHistoryRecord) => void;

  // Cross-cutting
  setError: (msg: string | null) => void;
  addLog: (msg: string) => void;
}

export interface UseFeedbackCompositionResult {
  // Modal + composition state
  showFeedbackModal: boolean;
  compiledFeedback: StructuredFeedback | null;
  setCompiledFeedback: Dispatch<
    SetStateAction<StructuredFeedback | null>
  >;
  activeFeedbackEntryId: string | null;
  isSendingFeedback: boolean;
  isResolvingEmail: boolean;
  emailResolutionSource: EmailResolutionSource | null;
  isDrafting: Record<string, boolean>;
  batchEntryOptions: FeedbackBatchEntryOption[];
  includedBatchPreviewItems: FeedbackBatchPreviewItem[];
  updateBatchEntryDecision: (
    entryId: string,
    decision: FeedbackBatchDecision
  ) => void;

  // Actions
  reviewAndSend: (entryId: string) => Promise<void>;
  sendFeedback: (method: 'email' | 'teams') => Promise<void>;
  draftFeedback: (
    entryId: string,
    fieldName: string,
    fieldValue: any
  ) => Promise<void>;
  closeModal: () => void;
  markEmailManuallyEdited: () => void;

  // Persistence baseline owned by the hook. Exposed so App.tsx's
  // saveEntryToFirebase and DB-load paths can read and write it.
  savedTeacherFeedback: Record<string, TeacherFeedbackFields>;
  setSavedTeacherFeedback: Dispatch<
    SetStateAction<Record<string, TeacherFeedbackFields>>
  >;

  // Derived signals for the page header and dirty-state UI
  currentPageHasUnsavedFeedback: boolean;
  pageWorkflowSummary: PageWorkflowSummary | null;
  pageFeedbackHistory: FeedbackHistoryRecord[];

  // Workflow actions for the active entry
  confirmDiscardCurrentFeedbackChanges: () => boolean;
  updateTeacherFeedbackField: (
    entryKey: string,
    field: keyof TeacherFeedbackFields,
    value: string
  ) => void;
  handleSaveDraft: (
    entry: ParsedDiaryEntry,
    entryIndex: number
  ) => Promise<void>;
  handleSaveAndMarkReady: (
    entry: ParsedDiaryEntry,
    entryIndex: number
  ) => Promise<boolean>;
  handleReviewAndSendEntry: (
    entry: ParsedDiaryEntry,
    entryIndex: number,
    entryKey: string
  ) => Promise<void>;
}

const ITEM_COUNT_HINTS: Record<FFItemCount, string> = {
  '1-2': 'Limit to 1–2 of the most impactful points. Appropriate when the student is at high cognitive load, is affectively fragile, or when a single error pattern dominates and deserves focused attention.',
  '3-4': 'Aim for 3–4 targeted, specific points — the formative-weekly default. Research on focused corrective feedback (Sheen, Ferris) supports this range for sustained improvement over a semester when paired with revision opportunity.',
  '5+': 'Provide comprehensive coverage with 5 or more specific observations. Appropriate for summative or grading-cycle feedback, exam preparation, or when the teacher is calibrating against a rubric. Less effective for formative weekly cycles where attention is the bottleneck.',
};

const createRecordId = (prefix: string): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const getEntryKey = (entry: ParsedDiaryEntry, index: number): string =>
  entry.id || String(index);

const getEntryLabel = (entry: ParsedDiaryEntry, index: number): string => {
  const date = String(entry.date || '').trim();
  const week = String(entry.weekNumber || '').trim();
  if (date && week) return `${date} (Week ${week})`;
  if (date) return date;
  if (week) return `Week ${week}`;
  return `Entry ${index + 1}`;
};

const getFieldsAddressed = (feedback: StructuredFeedback): string[] => {
  const fieldsAddressed: string[] = [];
  if (feedback.includeDiary && feedback.diaryFeedback)
    fieldsAddressed.push('diaryText');
  if (feedback.includePeer && feedback.peerFeedback)
    fieldsAddressed.push('peerFeedback');
  if (feedback.includeVocab && feedback.vocabFeedback)
    fieldsAddressed.push('vocab');
  if (feedback.includeTranslations && feedback.translationsFeedback)
    fieldsAddressed.push('translations');
  if (feedback.includeChatbot && feedback.chatbotFeedback)
    fieldsAddressed.push('chatbot');
  if (feedback.includeOverall && feedback.overallFeedback)
    fieldsAddressed.push('overall');
  return fieldsAddressed;
};

// Extracts all teacher comment text from a record for AI context injection.
const extractPriorContext = (record: FeedbackHistoryRecord): string => {
  if (record.structuredFeedback) {
    const sf = record.structuredFeedback;
    const parts: string[] = [];
    if (sf.includeDiary && sf.diaryFeedback) parts.push(`Diary: ${sf.diaryFeedback}`);
    if (sf.includeVocab && sf.vocabFeedback) parts.push(`Vocabulary: ${sf.vocabFeedback}`);
    if (sf.includeOverall && sf.overallFeedback) parts.push(`Overall: ${sf.overallFeedback}`);
    return parts.join('\n');
  }
  return record.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
};

// Extracts a short student-facing excerpt from the most recent record for
// the 'include' mode append. Takes the first non-empty field comment.
const extractPriorExcerpt = (record: FeedbackHistoryRecord): string => {
  if (record.structuredFeedback) {
    const sf = record.structuredFeedback;
    const first = [
      sf.includeDiary && sf.diaryFeedback,
      sf.includeVocab && sf.vocabFeedback,
      sf.includeOverall && sf.overallFeedback,
    ].find(Boolean) || '';
    return first.length > 220 ? first.slice(0, 220) + '…' : first;
  }
  const stripped = record.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.slice(0, 220);
};

/**
 * Owns all state and side-effects for the feedback composition + delivery
 * subsystem. App.tsx provides cross-cutting context (auth, current page,
 * persistent edit store) and consumes the returned state + actions.
 *
 * Established in Slice 5.5 to prevent orchestration state from continuing
 * to accumulate in App.tsx. Extended on 2026-05-30 to also own the
 * dirty-state baseline (savedTeacherFeedback), the page feedback history,
 * the derived workflow summary + unsaved signals, and the per-entry
 * Save Draft / Save & Mark Ready / Review & Send handlers. See
 * FEEDBACK_ANNOTATION_DESIGN.md and ARCHITECTURE.md §34.
 */
export function useFeedbackComposition(
  params: UseFeedbackCompositionParams
): UseFeedbackCompositionResult {
  const {
    accessToken,
    firebaseUser,
    db,
    account,
    userConfig,
    aiPrompts,
    parsedPageContent,
    activeStudentName,
    activeClassId,
    activePageId,
    selectedPageTitle,
    teacherFeedback,
    setTeacherFeedback,
    entryStatus,
    saveEntry,
    ffItemCount,
    priorFeedback,
    pastFeedbackForStudent,
    onFeedbackHistorySaved,
    setError,
    addLog,
  } = params;

  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [compiledFeedback, setCompiledFeedback] =
    useState<StructuredFeedback | null>(null);
  const [activeFeedbackEntryId, setActiveFeedbackEntryId] = useState<
    string | null
  >(null);
  const [isSendingFeedback, setIsSendingFeedback] = useState(false);
  const [isResolvingEmail, setIsResolvingEmail] = useState(false);
  const [emailResolutionSource, setEmailResolutionSource] =
    useState<EmailResolutionSource | null>(null);
  const [isDrafting, setIsDrafting] = useState<Record<string, boolean>>({});
  const [batchEntryDecisions, setBatchEntryDecisions] = useState<
    Record<string, FeedbackBatchDecision>
  >({});

  // Persistence baseline for dirty-state detection. App.tsx reads this
  // through the return and writes through setSavedTeacherFeedback on save
  // and on DB load.
  const [savedTeacherFeedback, setSavedTeacherFeedback] = useState<
    Record<string, TeacherFeedbackFields>
  >({});

  // Page-scoped feedback history (powers the SENT count in the page badge
  // and stays fresh after a successful send).
  const [pageFeedbackHistory, setPageFeedbackHistory] = useState<
    FeedbackHistoryRecord[]
  >([]);
  const [pageFeedbackReviewDecisions, setPageFeedbackReviewDecisions] =
    useState<FeedbackReviewDecisionRecord[]>([]);

  useEffect(() => {
    if (!firebaseUser || !activePageId) {
      setPageFeedbackHistory([]);
      setPageFeedbackReviewDecisions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [records, decisions] = await Promise.all([
          fetchRecentFeedbackForPage(db, firebaseUser.uid, activePageId, 100),
          fetchFeedbackReviewDecisionsForPage(
            db,
            firebaseUser.uid,
            activePageId,
            100
          ),
        ]);
        if (!cancelled) {
          setPageFeedbackHistory(records);
          setPageFeedbackReviewDecisions(decisions);
        }
      } catch (e: any) {
        if (cancelled) return;
        addLog(`[PageFeedback] Error: ${e?.message || String(e)}`);
        console.error('Could not load page feedback history', e);
        setPageFeedbackHistory([]);
        setPageFeedbackReviewDecisions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseUser?.uid, activePageId]);

  const currentPageHasUnsavedFeedback = useMemo(() => {
    if (!parsedPageContent) return false;
    return parsedPageContent.some((entry, index) => {
      const entryKey = entry.id || String(index);
      return hasTeacherFeedbackChanges(
        teacherFeedback[entryKey],
        savedTeacherFeedback[entryKey]
      );
    });
  }, [parsedPageContent, teacherFeedback, savedTeacherFeedback]);

  const pageSentEntryIds = useMemo(() => {
    const sentEntryIds = new Set<string>();
    pageFeedbackHistory.forEach((record) => {
      if (record.pageId === activePageId && record.entryId) {
        sentEntryIds.add(record.entryId);
      }
    });
    return sentEntryIds;
  }, [activePageId, pageFeedbackHistory]);

  const pageReviewedNoFeedbackEntryIds = useMemo(() => {
    const reviewedEntryIds = new Set<string>();
    pageFeedbackReviewDecisions.forEach((record) => {
      if (
        record.pageId === activePageId &&
        record.entryId &&
        record.decision === 'reviewed_no_feedback'
      ) {
        reviewedEntryIds.add(record.entryId);
      }
    });
    return reviewedEntryIds;
  }, [activePageId, pageFeedbackReviewDecisions]);

  const pageWorkflowSummary = useMemo<PageWorkflowSummary | null>(() => {
    return summarizePageWorkflow(
      parsedPageContent,
      entryStatus,
      teacherFeedback,
      savedTeacherFeedback,
      pageSentEntryIds
    );
  }, [
    entryStatus,
    pageSentEntryIds,
    parsedPageContent,
    savedTeacherFeedback,
    teacherFeedback,
  ]);

  const batchEntryOptions = useMemo<FeedbackBatchEntryOption[]>(() => {
    if (!parsedPageContent || !activeFeedbackEntryId) return [];
    return parsedPageContent
      .map((entry, index) => {
        const entryKey = getEntryKey(entry, index);
        const isCurrent = entryKey === activeFeedbackEntryId;
        const isEligible =
          isCurrent ||
          (entryStatus[entryKey] === 'approved' &&
            !pageSentEntryIds.has(entryKey) &&
            !pageReviewedNoFeedbackEntryIds.has(entryKey) &&
            !hasTeacherFeedbackChanges(
              teacherFeedback[entryKey],
              savedTeacherFeedback[entryKey]
            ));
        if (!isEligible) return null;
        return {
          entryId: entryKey,
          label: getEntryLabel(entry, index),
          decision:
            batchEntryDecisions[entryKey] ||
            (isCurrent ? 'include_feedback' : 'pending'),
          isCurrent,
          hasTeacherFeedback: hasTeacherFeedbackText(teacherFeedback[entryKey]),
        };
      })
      .filter((option): option is FeedbackBatchEntryOption => Boolean(option));
  }, [
    activeFeedbackEntryId,
    batchEntryDecisions,
    entryStatus,
    pageSentEntryIds,
    pageReviewedNoFeedbackEntryIds,
    parsedPageContent,
    savedTeacherFeedback,
    teacherFeedback,
  ]);

  const updateBatchEntryDecision = useCallback(
    (entryId: string, decision: FeedbackBatchDecision) => {
      setBatchEntryDecisions((prev) => ({ ...prev, [entryId]: decision }));
    },
    []
  );

  const includedBatchPreviewItems = useMemo<FeedbackBatchPreviewItem[]>(() => {
    if (!parsedPageContent || !activeFeedbackEntryId || !compiledFeedback)
      return [];

    return batchEntryOptions
      .filter((option) => option.decision === 'include_feedback')
      .map((option) => {
        const indexedEntry = parsedPageContent
          .map((entry, index) => ({
            entry,
            index,
            entryKey: getEntryKey(entry, index),
          }))
          .find((item) => item.entryKey === option.entryId);
        if (!indexedEntry) return null;

        const feedback =
          option.entryId === activeFeedbackEntryId
            ? compiledFeedback
            : compileStructuredFeedback(
                activeStudentName,
                indexedEntry.entry,
                teacherFeedback[option.entryId],
                userConfig.teacherDisplayName || account?.name || 'Your Teacher',
                userConfig.customSignOff
              );

        return {
          entryId: option.entryId,
          label: option.label,
          isCurrent: option.entryId === activeFeedbackEntryId,
          feedback: {
            ...feedback,
            studentEmail: compiledFeedback.studentEmail,
            priorExcerpt:
              option.entryId === activeFeedbackEntryId
                ? feedback.priorExcerpt
                : undefined,
          },
        };
      })
      .filter((item): item is FeedbackBatchPreviewItem => Boolean(item));
  }, [
    account?.name,
    activeFeedbackEntryId,
    activeStudentName,
    batchEntryOptions,
    compiledFeedback,
    parsedPageContent,
    teacherFeedback,
    userConfig.customSignOff,
    userConfig.teacherDisplayName,
  ]);

  useEffect(() => {
    if (!currentPageHasUnsavedFeedback) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () =>
      window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [currentPageHasUnsavedFeedback]);

  const confirmDiscardCurrentFeedbackChanges = useCallback(
    (): boolean =>
      !currentPageHasUnsavedFeedback ||
      window.confirm(
        'You have unsaved feedback changes on this page. Leave without saving them?'
      ),
    [currentPageHasUnsavedFeedback]
  );

  const updateTeacherFeedbackField = useCallback(
    (
      entryKey: string,
      field: keyof TeacherFeedbackFields,
      value: string
    ) => {
      setTeacherFeedback((prev) => ({
        ...prev,
        [entryKey]: {
          ...prev[entryKey],
          [field]: value,
        },
      }));
    },
    [setTeacherFeedback]
  );

  const closeModal = useCallback(() => {
    setShowFeedbackModal(false);
    setBatchEntryDecisions({});
  }, []);

  const reviewAndSend = useCallback(
    async (entryId: string) => {
      if (!parsedPageContent) return;
      const entry = parsedPageContent.find((e) => e.id === entryId);
      if (!entry) return;

      const feedback = teacherFeedback[entryId];
      const structured = compileStructuredFeedback(
        activeStudentName,
        entry,
        feedback,
        userConfig.teacherDisplayName || account?.name || 'Your Teacher',
        userConfig.customSignOff
      );
      if (priorFeedback === 'include' && pastFeedbackForStudent.length > 0) {
        structured.priorExcerpt = extractPriorExcerpt(pastFeedbackForStudent[0]);
      }
      setCompiledFeedback(structured);
      setActiveFeedbackEntryId(entryId);
      setBatchEntryDecisions({ [entryId]: 'include_feedback' });
      setEmailResolutionSource(null);
      setShowFeedbackModal(true);

      // Try to resolve the student's email in the background.
      // Include selectedPageTitle so that extractStudentNumber can pull the
      // 7-digit ID (e.g. "1234570" from "1234570 - 山田花子") and Strategy A
      // (UPN substring match) finds ak1234567@school.edu even
      // when display names are ID-only.
      setIsResolvingEmail(true);
      try {
        const graph = new GraphService(accessToken || undefined, true);
        const query = [selectedPageTitle, activeStudentName]
          .filter(Boolean)
          .join(' ')
          .trim();
        const result = await graph.findStudentEmail(
          query,
          activeClassId || undefined
        );
        if (result) {
          setCompiledFeedback((prev) =>
            prev ? { ...prev, studentEmail: result.email } : null
          );
          setEmailResolutionSource(result.source);
        }
      } catch (e) {
        console.error('Could not resolve student email automatically', e);
      } finally {
        setIsResolvingEmail(false);
      }
    },
    [
      parsedPageContent,
      teacherFeedback,
      activeStudentName,
      account,
      userConfig.customSignOff,
      accessToken,
      selectedPageTitle,
      activeClassId,
      priorFeedback,
      pastFeedbackForStudent,
    ]
  );

  const sendFeedback = useCallback(
    async (method: 'email' | 'teams') => {
      if (!compiledFeedback || !compiledFeedback.studentEmail) {
        alert('Please provide a valid student email address.');
        return;
      }

      const indexedEntries =
        parsedPageContent?.map((entry, index) => ({
          entry,
          index,
          entryKey: getEntryKey(entry, index),
        })) || [];
      const selectedOptions = batchEntryOptions.filter(
        (option) => option.decision !== 'pending'
      );
      const includedEntries = selectedOptions
        .filter((option) => option.decision === 'include_feedback')
        .map((option) =>
          indexedEntries.find((item) => item.entryKey === option.entryId)
        )
        .filter(
          (
            item
          ): item is {
            entry: ParsedDiaryEntry;
            index: number;
            entryKey: string;
          } => Boolean(item)
        );
      const reviewedNoFeedbackEntries = selectedOptions
        .filter((option) => option.decision === 'reviewed_no_feedback')
        .map((option) =>
          indexedEntries.find((item) => item.entryKey === option.entryId)
        )
        .filter(
          (
            item
          ): item is {
            entry: ParsedDiaryEntry;
            index: number;
            entryKey: string;
          } => Boolean(item)
        );
      if (includedEntries.length === 0) {
        alert('Select at least one entry to include in the feedback message.');
        return;
      }

      setIsSendingFeedback(true);
      try {
        const compiledByEntry = includedEntries.map((item) => {
          const feedback =
            item.entryKey === activeFeedbackEntryId
              ? compiledFeedback
              : compileStructuredFeedback(
                  activeStudentName,
                  item.entry,
                  teacherFeedback[item.entryKey],
                  userConfig.teacherDisplayName ||
                    account?.name ||
                    'Your Teacher',
                  userConfig.customSignOff
                );
          return {
            ...item,
            feedback: {
              ...feedback,
              studentEmail: compiledFeedback.studentEmail,
              priorExcerpt:
                item.entryKey === activeFeedbackEntryId
                  ? feedback.priorExcerpt
                  : undefined,
            },
          };
        });
        const isBatchSend =
          includedEntries.length > 1 || reviewedNoFeedbackEntries.length > 0;
        const batchId = isBatchSend
          ? createRecordId('feedback_batch')
          : undefined;
        const htmlBody = isBatchSend
          ? renderBatchFeedbackToHTML(
              compiledByEntry.map((item) => ({
                label: getEntryLabel(item.entry, item.index),
                feedback: item.feedback,
                entry: item.entry,
              })),
              compiledFeedback.greeting,
              compiledFeedback.closing,
              compiledFeedback.priorExcerpt
            )
          : renderFeedbackToHTML(compiledFeedback, includedEntries[0].entry);
        const graph = new GraphService(accessToken || undefined, true);

        if (method === 'email') {
          const subjectLabel = isBatchSend
            ? `${includedEntries.length} Entries`
            : includedEntries[0].entry.date ||
              includedEntries[0].entry.weekNumber ||
              'Weekly Entry';
          const subject = `[Journal Feedback] ${subjectLabel} - ${activeStudentName}`;
          await graph.sendEmail(
            compiledFeedback.studentEmail,
            subject,
            htmlBody
          );
          addLog(`Email sent to ${compiledFeedback.studentEmail}`);
        } else {
          await graph.sendTeamsMessage(compiledFeedback.studentEmail, htmlBody);
          addLog(`Teams message sent to ${compiledFeedback.studentEmail}`);
        }

        if (firebaseUser) {
          try {
            const nowIso = new Date().toISOString();
            const records: FeedbackHistoryRecord[] = compiledByEntry.map((item) => ({
              feedbackId: createRecordId(`${activePageId}_${item.entry.id}`),
              classId: activeClassId,
              pageId: activePageId,
              entryId: item.entry.id,
              studentUpn: compiledFeedback.studentEmail,
              studentName: activeStudentName || 'Unknown Student',
              channel: method,
              sentAt: nowIso,
              batchId,
              source: 'human',
              fieldsAddressed: getFieldsAddressed(item.feedback),
              content: htmlBody,
              updatedAt: nowIso,
              formatVersion: FEEDBACK_FORMAT_VERSION,
              structuredFeedback: { ...item.feedback },
              entrySnapshot: {
                diaryText: item.entry.diaryText || '',
                vocabItems: item.entry.vocabItems || [],
                peerFeedback: item.entry.peerFeedback || [],
                translations: item.entry.translations || [],
                chatbotFeedback: item.entry.chatbotFeedback,
              },
              itemCountSetting: ffItemCount,
              priorFeedbackMode: priorFeedback,
              recipientResolutionSource: emailResolutionSource ?? undefined,
            }));
            const reviewDecisions: FeedbackReviewDecisionRecord[] =
              reviewedNoFeedbackEntries.map((item) => ({
                decisionId: createRecordId(
                  `${activePageId}_${item.entry.id}_reviewed`
                ),
                batchId,
                classId: activeClassId,
                pageId: activePageId,
                entryId: item.entry.id,
                studentUpn: compiledFeedback.studentEmail || '',
                studentName: activeStudentName || 'Unknown Student',
                decision: 'reviewed_no_feedback',
                decidedAt: nowIso,
                updatedAt: nowIso,
              }));
            await Promise.all([
              ...records.map((record) =>
                saveFeedbackHistoryRecord(db, firebaseUser.uid, record)
              ),
              ...reviewDecisions.map((record) =>
                saveFeedbackReviewDecisionRecord(db, firebaseUser.uid, record)
              ),
            ]);
            addLog(
              `Feedback history saved for ${records.length} entr${
                records.length === 1 ? 'y' : 'ies'
              }${
                reviewDecisions.length > 0
                  ? `; ${reviewDecisions.length} reviewed/no-feedback decision${
                      reviewDecisions.length === 1 ? '' : 's'
                    } saved`
                  : ''
              }.`
            );
            setPageFeedbackHistory((prev) => [
              ...records,
              ...prev.filter(
                (item) =>
                  !records.some(
                    (record) => record.feedbackId === item.feedbackId
                  )
              ),
            ]);
            setPageFeedbackReviewDecisions((prev) => [
              ...reviewDecisions,
              ...prev.filter(
                (item) =>
                  !reviewDecisions.some(
                    (record) => record.decisionId === item.decisionId
                  )
              ),
            ]);
            records.forEach((record) => onFeedbackHistorySaved?.(record));
          } catch (historyError: any) {
            console.error(
              'Failed to persist feedback history record:',
              historyError
            );
            addLog(
              `Feedback sent but history record failed to save: ${historyError.message}`
            );
          }
        }

        setShowFeedbackModal(false);
        setBatchEntryDecisions({});
      } catch (error: any) {
        alert(`Failed to send feedback: ${error.message}`);
      } finally {
        setIsSendingFeedback(false);
      }
    },
    [
      compiledFeedback,
      batchEntryOptions,
      parsedPageContent,
      activeFeedbackEntryId,
      accessToken,
      activeStudentName,
      addLog,
      teacherFeedback,
      userConfig.teacherDisplayName,
      userConfig.customSignOff,
      account?.name,
      firebaseUser,
      db,
      activeClassId,
      activePageId,
      ffItemCount,
      priorFeedback,
      emailResolutionSource,
      onFeedbackHistorySaved,
    ]
  );

  const draftFeedback = useCallback(
    async (entryId: string, fieldName: string, fieldValue: any) => {
      const draftKey = `${entryId}-${fieldName}`;
      setIsDrafting((prev) => ({ ...prev, [draftKey]: true }));
      const promptInstruction =
        fieldName === 'peerFeedback'
          ? aiPrompts.peerFeedback
          : fieldName === 'vocab'
            ? aiPrompts.vocab
            : fieldName === 'translations'
              ? aiPrompts.translations
              : fieldName === 'overall'
                ? aiPrompts.overall
                : aiPrompts.diaryText;
      const priorFeedbackContext = priorFeedback !== 'off' && pastFeedbackForStudent.length > 0
        ? extractPriorContext(pastFeedbackForStudent[0])
        : undefined;

      try {
        const draft = await draftFieldFeedback(
          fieldName,
          fieldValue,
          activeStudentName,
          {
            model: userConfig.aiModelFeedback,
            tone: userConfig.feedbackTone,
            customInstruction: promptInstruction,
            itemCountHint: ITEM_COUNT_HINTS[ffItemCount],
            priorFeedbackContext,
            onRetry: (attempt, delay) => {
              addLog(
                `Drafting rate limit hit. Retrying in ${Math.round(delay / 1000)}s... (Attempt ${attempt}/3)`
              );
            },
          }
        );
        setTeacherFeedback((prev) => ({
          ...prev,
          [entryId]: {
            ...prev[entryId],
            [fieldName]: draft,
          },
        }));
      } catch (err) {
        console.error('Drafting error:', err);
      } finally {
        setIsDrafting((prev) => ({ ...prev, [draftKey]: false }));
      }
    },
    [
      aiPrompts,
      activeStudentName,
      userConfig.aiModelFeedback,
      userConfig.feedbackTone,
      ffItemCount,
      priorFeedback,
      pastFeedbackForStudent,
      addLog,
      setTeacherFeedback,
    ]
  );

  const handleSaveDraft = useCallback(
    async (entry: ParsedDiaryEntry, entryIndex: number) => {
      await saveEntry(entry, entryIndex, 'draft');
    },
    [saveEntry]
  );

  const handleSaveAndMarkReady = useCallback(
    async (entry: ParsedDiaryEntry, entryIndex: number): Promise<boolean> => {
      const entryKey = entry.id || String(entryIndex);
      const eligibility = getReadyEligibility(entry, teacherFeedback[entryKey]);

      if (eligibility === 'blocked') {
        const message =
          'Not marked ready: no student writing or student-facing teacher feedback detected.';
        setError(message);
        addLog(message);
        return false;
      }

      if (
        eligibility === 'needs_override' &&
        !window.confirm(
          'This entry has no substantial diary text. Mark it Feedback Ready anyway?'
        )
      ) {
        addLog(`Feedback Ready cancelled for entry ${entryIndex + 1}.`);
        return false;
      }

      await saveEntry(entry, entryIndex, 'approved');
      return true;
    },
    [teacherFeedback, saveEntry, setError, addLog]
  );

  const handleReviewAndSendEntry = useCallback(
    async (
      entry: ParsedDiaryEntry,
      entryIndex: number,
      entryKey: string
    ) => {
      const eligibility = getReadyEligibility(entry, teacherFeedback[entryKey]);
      if (eligibility === 'blocked') {
        const message =
          'Review & Send blocked: no student writing or student-facing teacher feedback detected.';
        setError(message);
        addLog(message);
        return;
      }

      if (
        entryStatus[entryKey] !== 'approved' ||
        hasTeacherFeedbackChanges(
          teacherFeedback[entryKey],
          savedTeacherFeedback[entryKey]
        )
      ) {
        const saved = await handleSaveAndMarkReady(entry, entryIndex);
        if (!saved) return;
      }

      await reviewAndSend(entryKey);
    },
    [
      teacherFeedback,
      savedTeacherFeedback,
      entryStatus,
      handleSaveAndMarkReady,
      reviewAndSend,
      setError,
      addLog,
    ]
  );

  const markEmailManuallyEdited = useCallback(() => {
    setEmailResolutionSource('manual');
  }, []);

  return {
    showFeedbackModal,
    compiledFeedback,
    setCompiledFeedback,
    activeFeedbackEntryId,
    isSendingFeedback,
    isResolvingEmail,
    emailResolutionSource,
    markEmailManuallyEdited,
    isDrafting,
    batchEntryOptions,
    includedBatchPreviewItems,
    updateBatchEntryDecision,
    reviewAndSend,
    sendFeedback,
    draftFeedback,
    closeModal,
    savedTeacherFeedback,
    setSavedTeacherFeedback,
    currentPageHasUnsavedFeedback,
    pageWorkflowSummary,
    pageFeedbackHistory,
    confirmDiscardCurrentFeedbackChanges,
    updateTeacherFeedbackField,
    handleSaveDraft,
    handleSaveAndMarkReady,
    handleReviewAndSendEntry,
  };
}
