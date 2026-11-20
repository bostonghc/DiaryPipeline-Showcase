import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { IdentityClaims } from '../services/identityClaims';
import type { Firestore } from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { GraphService } from '../services/graphService';
import { ITEM_COUNT_HINTS } from '../services/aiFeedbackReview';
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
import type { CollaborationAccessProfile } from '../services/collaborationAccess';
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
  /**
   * Resolved collaboration profile, passed rather than read from context:
   * this hook is called from App's body, which renders
   * CollaborationAccessProvider and therefore sits above it in the tree.
   * Reading the context here throws.
   */
  accessProfile: CollaborationAccessProfile | null;
  /**
   * Identity claims on the Firebase sign-in, once bound to the live Microsoft
   * account (hooks/useIdentityBinding.ts); null until then. Author fields on
   * sent-feedback records are written from these attested values, and sending
   * waits for them, so a message never goes out without a record the rules
   * can verify (docs/reference/feedback-attribution-plan.md).
   */
  identityClaims: Partial<IdentityClaims> | null;

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
  /** Ids of AI reviews run on an entry this session; recorded on the sent record. */
  getAiReviewRefsForEntry?: (entryId: string) => { ids: string[]; omitted: number };

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
  batchEntryOptions: FeedbackBatchEntryOption[];
  includedBatchPreviewItems: FeedbackBatchPreviewItem[];
  updateBatchEntryDecision: (
    entryId: string,
    decision: FeedbackBatchDecision
  ) => void;

  // Actions
  reviewAndSend: (entryId: string) => Promise<void>;
  sendFeedback: (method: 'email' | 'teams') => Promise<void>;
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

const createRecordId = (prefix: string): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** The `aiReviewIds` field for a sent record: omitted when empty, at most 20. */
export const aiReviewIdsField = (
  ids: string[] | undefined,
  omitted = 0
): { aiReviewIds?: string[]; aiReviewIdsOmitted?: number } => {
  const list = ids ?? [];
  const totalOmitted = Math.max(0, omitted) + Math.max(0, list.length - 20);
  return {
    ...(list.length > 0 ? { aiReviewIds: list.slice(0, 20) } : {}),
    // Recorded explicitly (0 included) whenever any review was linked or excluded.
    ...(list.length > 0 || totalOmitted > 0 ? { aiReviewIdsOmitted: totalOmitted } : {}),
  };
};

export const getEntryKey = (entry: ParsedDiaryEntry, index: number): string =>
  entry.id || String(index);

/**
 * Resolve an entry by the key the UI actually addresses it with.
 *
 * Exported so the resolution is testable on its own: matching on `entry.id`
 * alone is not equivalent, because getEntryKey falls back to the index for
 * entries with no id, and duplicate ids do occur (App.tsx has
 * ensureUniqueEntryIds for exactly that). First match wins, mirroring the
 * Array.prototype.find this replaced.
 */
export const findEntryByKey = (
  entries: ParsedDiaryEntry[],
  entryKey: string
): ParsedDiaryEntry | null => {
  for (let index = 0; index < entries.length; index += 1) {
    if (getEntryKey(entries[index], index) === entryKey) return entries[index];
  }
  return null;
};

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
    accessProfile,
    identityClaims,
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
    getAiReviewRefsForEntry,
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

        const previewItem: FeedbackBatchPreviewItem = {
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
        return previewItem;
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
      // Resolve by the same key every other lookup in this file uses. Matching
      // on `e.id` alone is not equivalent: getEntryKey falls back to the index
      // for entries without an id, and duplicate ids do occur (App.tsx has
      // ensureUniqueEntryIds for exactly that). A mismatch here compiles the
      // drafts of the requested entry against a *different* entry object, so
      // the review notice names the wrong week — and the notice is the one
      // field the review modal does not preview.
      const entry = findEntryByKey(parsedPageContent, entryId);
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
      // 7-digit ID (e.g. "1234570" from "1234570 - 山田陽菜") and Strategy A
      // (UPN substring match) finds ak1234570@school.edu even
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
      if (!identityClaims) {
        // Checked before delivery: sending without attested identity would
        // deliver a message whose history record the rules may reject.
        alert('Your sign-in is still being verified. Wait a moment and try again; if this persists, reload the page or sign out and back in.');
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
            // Provenance, captured at send time. In the collaboration pilot the
            // sender is often an intern rather than the account that owns this
            // Firestore subtree, and roles change — so the record carries the
            // Microsoft identity that sent the message, the Firebase identity
            // that owns the document, and the role as it stood right now.
            // Written from the attested claims, not the browser's own view of
            // the Microsoft session, so the rules can compare them exactly.
            // Written verbatim: the rules require each field and compare it to
            // its claim, so dropping an empty one (e.g. a blank display name)
            // would reject the record after the message was already delivered.
            const author = {
              authorUpn: identityClaims.ms_upn,
              authorName: identityClaims.ms_name,
              authorRole: identityClaims.ms_role,
              authorFirebaseUid: firebaseUser.uid,
            };
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
              ...author,
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
              ...(() => {
                const refs = getAiReviewRefsForEntry?.(item.entry.id);
                return aiReviewIdsField(refs?.ids, refs?.omitted);
              })(),
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
        } else {
          // Silent skip here is indistinguishable from success: the message
          // reaches the student, no record is written, and the entry stays in
          // the review queue as unsent with no explanation anywhere.
          addLog(
            'Feedback sent, but NO history record was saved: not connected to saved records. ' +
            'Connect Firestore and re-send if this entry must appear in the review queue and audit trail.'
          );
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
      identityClaims,
      firebaseUser,
      db,
      activeClassId,
      activePageId,
      ffItemCount,
      priorFeedback,
      emailResolutionSource,
      onFeedbackHistorySaved,
      getAiReviewRefsForEntry,
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
    batchEntryOptions,
    includedBatchPreviewItems,
    updateBatchEntryDecision,
    reviewAndSend,
    sendFeedback,
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
