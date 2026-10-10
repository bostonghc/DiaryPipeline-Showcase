import React, { useEffect, useMemo, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import {
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  Clock3,
  Database,
  FileText,
  ListChecks,
  Loader2,
  MessageSquare,
  Send,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import {
  fieldCoverage,
  itemCountDistribution,
  priorFeedbackModeDistribution,
  uptakeRate,
} from '../../services/dashboardDataService';
import { hasTeacherFeedbackText } from '../../services/feedbackWorkflowService';
import {
  listEntriesForClasses,
  listFeedbackHistoryForClasses,
  listPageSyncRecordsForClasses,
} from '../../services/firestoreDataService';
import type {
  EducationClass,
  EmailResolutionSource,
  FeedbackChannel,
  FeedbackHistoryRecord,
  FFItemCount,
  PageSyncRecord,
  PageSyncState,
  ParserMode,
  PriorFeedbackMode,
  StoredDiaryEntry,
  TemplateVersion,
} from '../../types';
import { StructureAuditPanel } from './StructureAuditPanel';

interface ClassDashboardProps {
  db: Firestore;
  uid: string;
  classes: EducationClass[];
  selectedClassIds: string[];
  onClose: () => void;
  embedded?: boolean;
  accessToken?: string;
  onOpenPage?: (target: {
    pageId: string;
    pageTitle: string;
    classId: string;
    studentName?: string;
    lastModified?: string;
  }) => void;
}

type DashboardTab = 'review-queue' | 'data-health' | 'teacher-practice' | 'student-trajectories' | 'class-patterns';
type SortDirection = 'asc' | 'desc';
type DataHealthSortKey =
  | 'studentName'
  | 'pageTitle'
  | 'syncState'
  | 'entryCount'
  | 'warningCount'
  | 'parserMode'
  | 'templateVersion'
  | 'lastParsedAt';
type ClassPatternsSortKey =
  | 'studentName'
  | 'classDisplayName'
  | 'weekNumber'
  | 'date'
  | 'vocabCount'
  | 'peerFeedbackCount'
  | 'translationCount'
  | 'photoCount';
type ClassPatternsFieldFilter = 'all' | 'peerFeedback' | 'vocab' | 'translations' | 'photos' | 'chatbot' | 'warnings';
type TrajectoryEventKind = 'entry' | 'feedback';

// Session-scoped read cache for the dashboard's full-corpus fetch. The dashboard
// pulls every entry, page record, and feedback record for all selected classes on
// open — its heaviest Firestore read. Without this, closing and reopening (a common
// review motion) re-reads the whole corpus each time. Cached at module scope (not in
// component state, which is lost on unmount) keyed by uid + class set, with a short
// TTL so a reopen after a sync still refreshes. Online one-shot getDocs do not hit the
// SDK's persistent cache, so this is what actually saves the repeated reads.
const DASHBOARD_CACHE_TTL_MS = 120_000; // 2 minutes
type DashboardDataset = {
  entries: StoredDiaryEntry[];
  pageRecords: PageSyncRecord[];
  feedbackRecords: FeedbackHistoryRecord[];
};
const dashboardDatasetCache = new Map<string, { fetchedAt: number; data: DashboardDataset }>();

const PAGE_SYNC_STATES: PageSyncState[] = ['saved', 'rate_limited', 'error', 'queued', 'syncing', 'idle'];
const FEEDBACK_FIELDS = [
  { key: 'diaryText', label: 'Diary text' },
  { key: 'peerFeedback', label: 'Peer feedback' },
  { key: 'vocab', label: 'Vocabulary' },
  { key: 'translations', label: 'Definitions & examples' },
  { key: 'chatbot', label: 'Chatbot exchange' },
  { key: 'overall', label: 'Overall comments' },
];
const ITEM_COUNT_SETTINGS: Array<FFItemCount | 'unknown'> = ['1-2', '3-4', '5+', 'unknown'];
const PRIOR_FEEDBACK_MODES: Array<PriorFeedbackMode | 'unknown'> = ['off', 'reference', 'include', 'unknown'];
const FEEDBACK_CHANNELS: FeedbackChannel[] = ['email', 'teams'];
const RECIPIENT_RESOLUTION_SOURCES: Array<EmailResolutionSource | 'unknown'> = ['roster', 'graph_search', 'manual', 'unknown'];

const formatPercent = (count: number, total: number): string =>
  total === 0 ? '0%' : `${Math.round((count / total) * 100)}%`;

const formatTimestamp = (value?: string): string => {
  if (!value) return 'Not captured';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Not captured';
  return parsed.toLocaleString();
};

const parseSortableTime = (value?: string): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const compareValues = (a: string | number | boolean, b: string | number | boolean): number => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
};

const deriveStudentKey = (identity: {
  studentUpn?: string;
  studentGraphId?: string;
  studentName?: string;
}): string =>
  (identity.studentUpn || identity.studentGraphId || identity.studentName || 'unknown-student')
    .trim()
    .toLowerCase();

const formatShortDate = (value?: string): string => {
  if (!value) return 'No date';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const fieldLabelForKey = (key: string): string =>
  FEEDBACK_FIELDS.find((field) => field.key === key)?.label ?? key;

const truncateText = (value: string, maxLength = 180): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
};

const countBy = <T,>(items: T[], keyForItem: (item: T) => string): Record<string, number> =>
  items.reduce<Record<string, number>>((counts, item) => {
    const key = keyForItem(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

const isRecordStale = (record: PageSyncRecord): boolean => {
  if (!record.oneNoteLastModified || !record.lastParsedAt) return false;
  const modified = Date.parse(record.oneNoteLastModified);
  const parsed = Date.parse(record.lastParsedAt);
  return Number.isFinite(modified) && Number.isFinite(parsed) && modified > parsed;
};

export const ClassDashboard: React.FC<ClassDashboardProps> = ({
  db,
  uid,
  classes,
  selectedClassIds,
  onClose,
  embedded = false,
  accessToken,
  onOpenPage,
}) => {
  const [activeTab, setActiveTab] = useState<DashboardTab>('review-queue');
  const [entries, setEntries] = useState<StoredDiaryEntry[]>([]);
  const [pageRecords, setPageRecords] = useState<PageSyncRecord[]>([]);
  const [feedbackRecords, setFeedbackRecords] = useState<FeedbackHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stabilise the effect key: Array.from(selectedNotebookIds) creates a new
  // reference on every App.tsx render, which would re-query Firestore on every
  // sync-progress tick while the dashboard is open.
  const classIdsKey = useMemo(
    () => JSON.stringify([...selectedClassIds].sort()),
    [selectedClassIds]
  );

  useEffect(() => {
    const ids = JSON.parse(classIdsKey) as string[];
    let cancelled = false;

    // Serve from the session cache when fresh, so closing and reopening the
    // dashboard within the TTL does not re-read the whole corpus.
    const cacheKey = `${uid}|${classIdsKey}`;
    const cached = dashboardDatasetCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < DASHBOARD_CACHE_TTL_MS) {
      setEntries(cached.data.entries);
      setPageRecords(cached.data.pageRecords);
      setFeedbackRecords(cached.data.feedbackRecords);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    Promise.all([
      listEntriesForClasses(db, uid, ids),
      listPageSyncRecordsForClasses(db, uid, ids),
      listFeedbackHistoryForClasses(db, uid, ids),
    ])
      .then(([nextEntries, nextPageRecords, nextFeedbackRecords]) => {
        dashboardDatasetCache.set(cacheKey, {
          fetchedAt: Date.now(),
          data: { entries: nextEntries, pageRecords: nextPageRecords, feedbackRecords: nextFeedbackRecords },
        });
        if (cancelled) return;
        setEntries(nextEntries);
        setPageRecords(nextPageRecords);
        setFeedbackRecords(nextFeedbackRecords);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [db, uid, classIdsKey]);

  const selectedClasses = useMemo(
    () => selectedClassIds.map((id) => classes.find((cls) => cls.id === id)).filter(Boolean) as EducationClass[],
    [classes, selectedClassIds]
  );

  const dataHealth = useMemo(() => {
    const pageStateCounts = countBy<PageSyncRecord>(pageRecords, (record) => record.syncState);
    const entryStatusCounts = countBy<StoredDiaryEntry>(entries, (entry) => entry.status);
    const parserModeCounts = countBy<PageSyncRecord>(pageRecords, (record) => record.parserMode);
    const templateCounts = countBy<PageSyncRecord>(pageRecords, (record) => record.templateVersion);
    const entriesWithWarnings = entries.filter((entry) => (entry.parseWarnings ?? []).length > 0).length;
    // Identity stability: an entry is grouped on a directory-stable key when it
    // carries a UPN or Graph ID. Name-only entries are a measurement condition,
    // not a quality judgement about the student — they just make cross-entry
    // grouping less reliable until directory identity is resolved.
    const entriesWithStableIdentity = entries.filter(
      (entry) => Boolean(entry.studentUpn) || Boolean(entry.studentGraphId)
    ).length;
    const stalePages = pageRecords.filter(isRecordStale).length;
    const studentsRepresented = new Set(
      entries.map((entry) => entry.studentUpn || entry.studentGraphId || entry.studentName).filter(Boolean)
    ).size;
    const pageIdsWithEntries = new Set(entries.map((entry) => entry.pageId));
    const pagesWithEntries = pageIdsWithEntries.size;
    // Coverage gap: page records are pages the app discovered/tracked; saved
    // entries are what actually parsed and persisted. Students-with-page-records
    // vs students-with-saved-entries, and pages that synced but produced zero
    // entries, are the honest "what this instrument missed" signals. The entry
    // export only sees saved entries, so this gap is otherwise invisible.
    const studentsWithPageRecords = new Set(
      pageRecords.map((record) => deriveStudentKey(record)).filter(Boolean)
    ).size;
    const pagesWithoutEntries = pageRecords.filter(
      (record) => !pageIdsWithEntries.has(record.pageId)
    ).length;
    const lastPageUpdate = pageRecords
      .map((record) => record.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1);

    return {
      pageStateCounts,
      entryStatusCounts,
      parserModeCounts,
      templateCounts,
      entriesWithWarnings,
      entriesWithStableIdentity,
      stalePages,
      studentsRepresented,
      studentsWithPageRecords,
      pagesWithEntries,
      pagesWithoutEntries,
      lastPageUpdate,
    };
  }, [entries, pageRecords]);

  const tabs: Array<{ id: DashboardTab; label: string; disabled?: boolean }> = [
    { id: 'review-queue', label: 'Review Queue' },
    { id: 'data-health', label: 'Data Health' },
    { id: 'teacher-practice', label: 'Teacher Practice' },
    { id: 'student-trajectories', label: 'Student Trajectories' },
    { id: 'class-patterns', label: 'Class Patterns' },
  ];

  const frameClassName = embedded
    ? 'flex h-full min-h-0 w-full flex-col overflow-hidden bg-white'
    : 'm-auto flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl';

  const dashboard = (
      <section className={frameClassName}>
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
                <BarChart3 size={16} />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                  Class Dashboard
                </p>
                <h2 className="truncate text-lg font-black tracking-tight text-slate-900">
                  Measurement and reflection
                </h2>
              </div>
            </div>
            <p className="mt-1 max-w-4xl text-xs font-semibold leading-relaxed text-slate-500">
              Read-only observables for selected classes. Counts describe data coverage and workflow state; they are not student scores or diagnostic claims.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
            title="Close dashboard"
            aria-label="Close dashboard"
          >
            <X size={20} />
          </button>
        </header>

        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-white px-5 py-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => !tab.disabled && setActiveTab(tab.id)}
              disabled={tab.disabled}
              className={`shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] font-black uppercase tracking-wider transition-colors ${
                activeTab === tab.id
                  ? 'bg-indigo-50 text-indigo-700'
                  : tab.disabled
                  ? 'cursor-not-allowed text-slate-300'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
              }`}
              title={tab.disabled ? 'Planned for a later dashboard slice' : undefined}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto bg-slate-50/70 px-5 py-3">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 text-sm font-bold text-slate-600 shadow-sm">
                <Loader2 size={18} className="animate-spin text-indigo-500" />
                Loading saved dashboard records...
              </div>
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-red-100 bg-white p-5 text-sm font-semibold text-red-700 shadow-sm">
              Dashboard records could not be loaded: {error}
            </div>
          ) : activeTab === 'teacher-practice' ? (
            <TeacherPracticeTab records={feedbackRecords} />
          ) : activeTab === 'review-queue' ? (
            <ReviewQueueTab
              entries={entries}
              pageRecords={pageRecords}
              feedbackRecords={feedbackRecords}
              selectedClasses={selectedClasses}
              onOpenPage={onOpenPage}
            />
          ) : activeTab === 'student-trajectories' ? (
            <StudentTrajectoriesTab
              entries={entries}
              pageRecords={pageRecords}
              feedbackRecords={feedbackRecords}
              selectedClasses={selectedClasses}
            />
          ) : activeTab === 'class-patterns' ? (
            <ClassPatternsTab
              entries={entries}
              pageRecords={pageRecords}
              feedbackRecords={feedbackRecords}
              selectedClasses={selectedClasses}
            />
          ) : (
            <DataHealthTab
              selectedClasses={selectedClasses}
              accessToken={accessToken}
              pageRecords={pageRecords}
              entries={entries}
              dataHealth={dataHealth}
            />
          )}
        </div>
      </section>
  );

  if (embedded) return dashboard;

  return (
    <div className="fixed inset-0 z-[90] flex bg-slate-950/45 p-4 backdrop-blur-sm">
      {dashboard}
    </div>
  );
};

interface ReviewQueueTabProps {
  entries: StoredDiaryEntry[];
  pageRecords: PageSyncRecord[];
  feedbackRecords: FeedbackHistoryRecord[];
  selectedClasses: EducationClass[];
  onOpenPage?: ClassDashboardProps['onOpenPage'];
}

type ReviewQueueKind = 'ready' | 'draft' | 'capture';

interface ReviewQueueRow {
  id: string;
  kind: ReviewQueueKind;
  classDisplayName: string;
  classId: string;
  studentName: string;
  pageId: string;
  pageTitle: string;
  entryLabel?: string;
  statusLabel: string;
  detail: string;
  updatedAt?: string;
  lastModified?: string;
  priority: number;
}

const getEntryLabel = (entry: StoredDiaryEntry): string => {
  const date = entry.date?.trim();
  const week = entry.weekNumber?.trim();
  if (date && week) return `${date} (Week ${week})`;
  if (date) return date;
  if (week) return `Week ${week}`;
  return entry.pageTitle || 'Saved entry';
};

const entrySortTime = (entry: StoredDiaryEntry): number =>
  parseSortableTime(entry.approvedAt) ||
  parseSortableTime(entry.updatedAt) ||
  parseSortableTime(entry.oneNoteLastModified);

const ReviewQueueTab: React.FC<ReviewQueueTabProps> = ({
  entries,
  pageRecords,
  feedbackRecords,
  selectedClasses,
  onOpenPage,
}) => {
  const queue = useMemo(() => {
    const classNameById = Object.fromEntries(
      selectedClasses.map((cls) => [cls.id, cls.displayName] as const)
    );
    const pageRecordById = Object.fromEntries(
      pageRecords.map((record) => [record.pageId, record] as const)
    );
    const pageIdsWithEntries = new Set(entries.map((entry) => entry.pageId));
    const sentEntryIds = new Set(
      feedbackRecords.map((record) => record.entryId).filter(Boolean)
    );

    const readyRows: ReviewQueueRow[] = [];
    const draftRows: ReviewQueueRow[] = [];
    const captureRows: ReviewQueueRow[] = [];

    entries.forEach((entry) => {
      if (sentEntryIds.has(entry.entryId)) return;
      const pageRecord = pageRecordById[entry.pageId];
      const classDisplayName = classNameById[entry.classId] ?? entry.classId;
      const base = {
        classDisplayName,
        classId: entry.classId,
        studentName: entry.studentName || 'Unknown student',
        pageId: entry.pageId,
        pageTitle: entry.pageTitle || 'Untitled page',
        entryLabel: getEntryLabel(entry),
        updatedAt: entry.updatedAt,
        lastModified: pageRecord?.oneNoteLastModified || entry.oneNoteLastModified,
      };

      if (entry.status === 'approved') {
        readyRows.push({
          ...base,
          id: `ready-${entry.entryId}`,
          kind: 'ready',
          statusLabel: 'Ready to send',
          detail: 'Feedback Ready entry has not been sent yet.',
          priority: 10_000 - entrySortTime(entry),
        });
        return;
      }

      const hasFeedback = hasTeacherFeedbackText(entry.teacherFeedback);
      draftRows.push({
        ...base,
        id: `draft-${entry.entryId}`,
        kind: 'draft',
        statusLabel:
          entry.status === 'reviewed'
            ? 'Reviewed draft'
            : hasFeedback
              ? 'Draft in progress'
              : 'Needs review',
        detail: hasFeedback
          ? 'Teacher feedback exists but this entry is not Feedback Ready.'
          : 'Saved entry has not yet received student-facing feedback.',
        priority: 20_000 - entrySortTime(entry),
      });
    });

    pageRecords.forEach((record) => {
      const noSavedEntries = !pageIdsWithEntries.has(record.pageId);
      const isCaptureIssue =
        record.syncState === 'error' ||
        record.syncState === 'rate_limited' ||
        (record.syncState === 'saved' && noSavedEntries);
      if (!isCaptureIssue) return;

      captureRows.push({
        id: `capture-${record.pageId}`,
        kind: 'capture',
        classDisplayName: classNameById[record.classId] ?? record.classId,
        classId: record.classId,
        studentName: record.studentName || 'Unknown student',
        pageId: record.pageId,
        pageTitle: record.pageTitle || 'Untitled page',
        statusLabel:
          record.syncState === 'error'
            ? 'Capture error'
            : record.syncState === 'rate_limited'
              ? 'Rate limited'
              : 'No entries parsed',
        detail:
          record.syncState === 'saved' && noSavedEntries
            ? 'Page has a sync record but no saved diary entries.'
            : `Page sync state is ${record.syncState.replace('_', ' ')}.`,
        updatedAt: record.updatedAt,
        lastModified: record.oneNoteLastModified,
        priority: record.syncState === 'error' ? 30_000 : 35_000,
      });
    });

    const sortRows = (rows: ReviewQueueRow[]) =>
      [...rows].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return `${a.studentName} ${a.pageTitle}`.localeCompare(`${b.studentName} ${b.pageTitle}`);
      });

    return {
      ready: sortRows(readyRows),
      drafts: sortRows(draftRows),
      capture: sortRows(captureRows),
    };
  }, [entries, feedbackRecords, pageRecords, selectedClasses]);

  const totalActionRows = queue.ready.length + queue.drafts.length + queue.capture.length;

  return (
    <div className="space-y-3">
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<Send size={18} />}
          label="Ready To Send"
          value={String(queue.ready.length)}
          detail="approved entries without sent feedback"
          tone={queue.ready.length > 0 ? 'emerald' : 'slate'}
        />
        <MetricTile
          icon={<ListChecks size={18} />}
          label="Drafts / Review"
          value={String(queue.drafts.length)}
          detail="saved entries not yet ready"
          tone={queue.drafts.length > 0 ? 'indigo' : 'slate'}
        />
        <MetricTile
          icon={<AlertTriangle size={18} />}
          label="Capture Issues"
          value={String(queue.capture.length)}
          detail="pages needing sync attention"
          tone={queue.capture.length > 0 ? 'amber' : 'slate'}
        />
        <MetricTile
          icon={<FileText size={18} />}
          label="Queue Items"
          value={String(totalActionRows)}
          detail="navigation targets, not student scores"
        />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            Feedback Review Queue
          </p>
          <p className="mt-1 text-xs font-semibold leading-relaxed text-slate-500">
            Prioritized workflow records that open the existing content pane for evidence-centered review.
          </p>
        </div>
      </section>

      <ReviewQueueSection
        title="Ready to send"
        description="Feedback Ready entries with no sent feedback record yet. Open the page, review the evidence, then send from the content pane."
        emptyText="No Feedback Ready entries are waiting to send."
        rows={queue.ready}
        onOpenPage={onOpenPage}
      />
      <ReviewQueueSection
        title="Drafts and needs review"
        description="Saved entries that are not Feedback Ready. These are candidates for teacher review, drafting, or final approval."
        emptyText="No draft or review entries are waiting."
        rows={queue.drafts}
        onOpenPage={onOpenPage}
      />
      <ReviewQueueSection
        title="Capture issues"
        description="Page-level sync records that may need another pass, cleanup, or investigation before review work is complete."
        emptyText="No capture issues found for selected classes."
        rows={queue.capture}
        onOpenPage={onOpenPage}
      />
    </div>
  );
};

const ReviewQueueSection: React.FC<{
  title: string;
  description: string;
  emptyText: string;
  rows: ReviewQueueRow[];
  onOpenPage?: ClassDashboardProps['onOpenPage'];
}> = ({ title, description, emptyText, rows, onOpenPage }) => (
  <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="border-b border-slate-100 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-black text-slate-900">{title}</h3>
          <p className="mt-1 max-w-4xl text-xs font-medium leading-relaxed text-slate-500">
            {description}
          </p>
        </div>
        <span className="rounded-full bg-slate-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-slate-500">
          {rows.length}
        </span>
      </div>
    </div>
    {rows.length === 0 ? (
      <div className="px-5 py-6 text-sm font-semibold text-slate-400">{emptyText}</div>
    ) : (
      <div className="divide-y divide-slate-100">
        {rows.map((row) => (
          <div key={row.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${
                  row.kind === 'ready'
                    ? 'bg-emerald-50 text-emerald-700'
                    : row.kind === 'capture'
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-indigo-50 text-indigo-700'
                }`}>
                  {row.statusLabel}
                </span>
                <span className="text-xs font-bold text-slate-400">{row.classDisplayName}</span>
              </div>
              <div className="mt-2 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
                <h4 className="truncate text-sm font-black text-slate-800">{row.studentName}</h4>
                <p className="truncate text-xs font-semibold text-slate-500">{row.pageTitle}</p>
                {row.entryLabel && (
                  <p className="truncate text-xs font-semibold text-slate-400">{row.entryLabel}</p>
                )}
              </div>
              <p className="mt-1 text-xs font-medium leading-relaxed text-slate-500">{row.detail}</p>
              <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-300">
                Updated {formatTimestamp(row.updatedAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                onOpenPage?.({
                  pageId: row.pageId,
                  pageTitle: row.pageTitle,
                  classId: row.classId,
                  studentName: row.studentName,
                  lastModified: row.lastModified,
                })
              }
              disabled={!onOpenPage}
              className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-3 py-2 text-xs font-black text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              Open page
            </button>
          </div>
        ))}
      </div>
    )}
  </section>
);

interface TeacherPracticeTabProps {
  records: FeedbackHistoryRecord[];
}

const TeacherPracticeTab: React.FC<TeacherPracticeTabProps> = ({ records }) => {
  const totalRecords = records.length;
  const fieldCounts = useMemo(() => fieldCoverage(records), [records]);
  const itemCounts = useMemo(() => itemCountDistribution(records), [records]);
  const priorModes = useMemo(() => priorFeedbackModeDistribution(records), [records]);
  const uptake = useMemo(() => uptakeRate(records), [records]);
  const channelCounts = useMemo(
    () => countBy<FeedbackHistoryRecord>(records, (record) => record.channel),
    [records]
  );
  const recipientResolutionCounts = useMemo(
    () => countBy<FeedbackHistoryRecord>(records, (record) => record.recipientResolutionSource ?? 'unknown'),
    [records]
  );
  const recordsWithUnknownItemCount = itemCounts.unknown ?? 0;
  const recordsWithUnknownPriorMode = priorModes.unknown ?? 0;
  const recordsWithUnknownRecipientResolution = recipientResolutionCounts.unknown ?? 0;
  const lastSentAt = records.map((record) => record.sentAt).filter(Boolean).sort().at(-1);

  return (
    <div className="space-y-5">
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<MessageSquare size={18} />}
          label="Sent Feedback"
          value={String(totalRecords)}
          detail="feedback-history records"
        />
        <MetricTile
          icon={<ShieldCheck size={18} />}
          label="Uptake Marked"
          value={String(uptake.observed)}
          detail={`${formatPercent(uptake.observed, uptake.total)} of sent records`}
        />
        <MetricTile
          icon={<AlertTriangle size={18} />}
          label="Metadata Missing"
          value={String(recordsWithUnknownItemCount + recordsWithUnknownRecipientResolution)}
          detail="not-captured setting/resolution fields"
          tone={recordsWithUnknownItemCount + recordsWithUnknownRecipientResolution > 0 ? 'amber' : 'slate'}
        />
        <MetricTile
          icon={<Clock3 size={18} />}
          label="Last Sent"
          value={lastSentAt ? new Date(lastSentAt).toLocaleDateString() : 'None'}
          detail={formatTimestamp(lastSentAt)}
        />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              Teacher Practice
            </p>
            <h3 className="text-base font-black text-slate-900">Feedback pattern observables</h3>
          </div>
          <p className="text-xs font-semibold text-slate-400">
            Denominator: {totalRecords} sent feedback record{totalRecords === 1 ? '' : 's'}
          </p>
        </div>
        <p className="mt-3 max-w-4xl text-sm font-medium leading-relaxed text-slate-500">
          These counts describe which fields were addressed and which send-time settings were used. They do not evaluate feedback quality, student ability, or whether a feedback style worked.
        </p>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <DistributionPanel
          title="Field Coverage"
          description="How often each feedback field was addressed. A record can address multiple fields, so percentages do not add to 100."
          total={totalRecords}
          rows={FEEDBACK_FIELDS.map((field) => ({
            label: field.label,
            count: fieldCounts[field.key] ?? 0,
          }))}
        />
        <DistributionPanel
          title="Item Count Setting"
          description="Focused-feedback item count selected at composition time. Unknown means the field was not captured on an older record."
          total={totalRecords}
          rows={ITEM_COUNT_SETTINGS.map((setting) => ({
            label: setting === 'unknown' ? 'not captured' : setting,
            count: itemCounts[setting] ?? 0,
          }))}
        />
        <DistributionPanel
          title="Prior Feedback Mode"
          description="How often continuity with earlier feedback was off, referenced, or included in the sent message."
          total={totalRecords}
          rows={PRIOR_FEEDBACK_MODES.map((mode) => ({
            label: mode === 'unknown' ? 'not captured' : mode,
            count: priorModes[mode] ?? 0,
          }))}
        />
        <DistributionPanel
          title="Delivery Channel"
          description="Where sent feedback was delivered. This is delivery workflow data, not evidence of student engagement."
          total={totalRecords}
          rows={FEEDBACK_CHANNELS.map((channel) => ({
            label: channel,
            count: channelCounts[channel] ?? 0,
          }))}
        />
        <DistributionPanel
          title="Recipient Resolution"
          description="How the student recipient address was determined before sending. Not captured means older records lack this audit field."
          total={totalRecords}
          rows={RECIPIENT_RESOLUTION_SOURCES.map((source) => ({
            label: source === 'graph_search'
              ? 'Graph search'
              : source === 'unknown'
              ? 'not captured'
              : source,
            count: recipientResolutionCounts[source] ?? 0,
          }))}
        />
      </section>

      {recordsWithUnknownPriorMode > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-semibold leading-relaxed text-amber-900">
          {recordsWithUnknownPriorMode} record{recordsWithUnknownPriorMode === 1 ? '' : 's'} do not capture prior-feedback mode. Treat comparisons involving continuity as incomplete until older records are separated or backfilled.
        </div>
      )}
    </div>
  );
};

interface StudentTrajectoriesTabProps {
  entries: StoredDiaryEntry[];
  pageRecords: PageSyncRecord[];
  feedbackRecords: FeedbackHistoryRecord[];
  selectedClasses: EducationClass[];
}

interface StudentOption {
  key: string;
  name: string;
  upn?: string;
  graphId?: string;
  entryCount: number;
  feedbackCount: number;
}

interface TrajectoryEvent {
  id: string;
  kind: TrajectoryEventKind;
  sortTime: number;
  dateLabel: string;
  title: string;
  detail: string;
  chips: string[];
  excerpt?: string;
  tone?: 'slate' | 'indigo' | 'emerald' | 'amber';
}

const StudentTrajectoriesTab: React.FC<StudentTrajectoriesTabProps> = ({
  entries,
  pageRecords,
  feedbackRecords,
  selectedClasses,
}) => {
  const [selectedStudentKey, setSelectedStudentKey] = useState<string>('');
  const classNameById = useMemo(
    () => Object.fromEntries(selectedClasses.map((cls) => [cls.id, cls.displayName] as const)),
    [selectedClasses]
  );
  const pageRecordById = useMemo(
    () => Object.fromEntries(pageRecords.map((record) => [record.pageId, record] as const)),
    [pageRecords]
  );

  const studentOptions = useMemo<StudentOption[]>(() => {
    const options = new Map<string, StudentOption>();
    const ensure = (identity: { studentName?: string; studentUpn?: string; studentGraphId?: string }) => {
      const key = deriveStudentKey(identity);
      const current = options.get(key) ?? {
        key,
        name: identity.studentName || identity.studentUpn || identity.studentGraphId || 'Unknown student',
        upn: identity.studentUpn,
        graphId: identity.studentGraphId,
        entryCount: 0,
        feedbackCount: 0,
      };
      current.name = current.name || identity.studentName || 'Unknown student';
      current.upn = current.upn || identity.studentUpn;
      current.graphId = current.graphId || identity.studentGraphId;
      options.set(key, current);
      return current;
    };

    entries.forEach((entry) => {
      ensure(entry).entryCount += 1;
    });
    feedbackRecords.forEach((record) => {
      ensure(record).feedbackCount += 1;
    });

    return Array.from(options.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [entries, feedbackRecords]);

  useEffect(() => {
    if (studentOptions.length === 0) {
      setSelectedStudentKey('');
      return;
    }
    if (!studentOptions.some((option) => option.key === selectedStudentKey)) {
      setSelectedStudentKey(studentOptions[0].key);
    }
  }, [selectedStudentKey, studentOptions]);

  const selectedStudent = studentOptions.find((option) => option.key === selectedStudentKey) ?? studentOptions[0];
  const studentEntries = useMemo(
    () => entries.filter((entry) => deriveStudentKey(entry) === selectedStudent?.key),
    [entries, selectedStudent?.key]
  );
  const studentFeedback = useMemo(
    () => feedbackRecords.filter((record) => deriveStudentKey(record) === selectedStudent?.key),
    [feedbackRecords, selectedStudent?.key]
  );
  const studentPageRecords = useMemo(() => {
    const pageIds = new Set(studentEntries.map((entry) => entry.pageId));
    return pageRecords.filter((record) => pageIds.has(record.pageId) || deriveStudentKey(record) === selectedStudent?.key);
  }, [pageRecords, selectedStudent?.key, studentEntries]);

  const trajectoryEvents = useMemo<TrajectoryEvent[]>(() => {
    const entryEvents: TrajectoryEvent[] = studentEntries.map((entry) => {
      const pageRecord = pageRecordById[entry.pageId];
      const warnings = (entry.parseWarnings ?? []).length;
      const statusLabel = entry.status === 'approved' ? 'Feedback Ready' : entry.status;
      return {
        id: `entry-${entry.entryId}`,
        kind: 'entry',
        sortTime: parseSortableTime(entry.date) || parseSortableTime(entry.updatedAt),
        dateLabel: entry.date || formatShortDate(entry.updatedAt),
        title: entry.pageTitle || 'Diary entry',
        detail: `${statusLabel} entry from ${classNameById[entry.classId] ?? entry.classId}`,
        chips: [
          statusLabel,
          `week ${entry.weekNumber || 'not captured'}`,
          `${entry.vocabCount} vocab`,
          `${entry.peerFeedback.length} peer comments`,
          pageRecord?.parserMode === 'label-first' ? 'labels first' : pageRecord?.parserMode === 'ai' ? 'AI first' : entry.parserMode,
          pageRecord?.templateVersion || entry.templateVersion,
          ...(warnings > 0 ? [`${warnings} warning${warnings === 1 ? '' : 's'}`] : []),
        ],
        excerpt: entry.diaryText ? truncateText(entry.diaryText) : undefined,
        tone: warnings > 0 ? 'amber' : entry.status === 'approved' ? 'emerald' : 'slate',
      };
    });

    const feedbackEvents: TrajectoryEvent[] = studentFeedback.map((record) => {
      const addressed = (record.fieldsAddressed ?? []).map(fieldLabelForKey);
      const structured = record.structuredFeedback;
      const excerpt = structured?.overallFeedback || structured?.diaryFeedback || structured?.peerFeedback || record.content.replace(/<[^>]+>/g, ' ');
      return {
        id: `feedback-${record.feedbackId}`,
        kind: 'feedback',
        sortTime: parseSortableTime(record.sentAt),
        dateLabel: formatShortDate(record.sentAt),
        title: `Feedback sent by ${record.channel}`,
        detail: `${addressed.length} field${addressed.length === 1 ? '' : 's'} addressed`,
        chips: [
          record.channel,
          record.itemCountSetting ?? 'item count not captured',
          record.priorFeedbackMode ? `prior ${record.priorFeedbackMode}` : 'prior mode not captured',
          record.uptakeObservedAt ? 'uptake marked' : 'uptake not marked',
          ...addressed.slice(0, 3),
        ],
        excerpt: excerpt ? truncateText(excerpt) : undefined,
        tone: record.uptakeObservedAt ? 'emerald' : 'indigo',
      };
    });

    return [...entryEvents, ...feedbackEvents].sort((a, b) => {
      if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
      return a.kind.localeCompare(b.kind);
    });
  }, [classNameById, pageRecordById, studentEntries, studentFeedback]);

  if (studentOptions.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <UserRound size={32} className="mx-auto text-slate-300" />
        <h3 className="mt-3 text-base font-black text-slate-900">No student records available</h3>
        <p className="mt-2 text-sm font-medium text-slate-500">
          Student trajectories need saved entries or sent feedback records for the selected classes.
        </p>
      </div>
    );
  }

  const parserModes = new Set(studentPageRecords.map((record) => record.parserMode).filter(Boolean));
  const templates = new Set(studentPageRecords.map((record) => record.templateVersion).filter(Boolean));
  const sentCount = studentFeedback.length;
  const uptakeCount = studentFeedback.filter((record) => record.uptakeObservedAt).length;
  const warningCount = studentEntries.filter((entry) => (entry.parseWarnings ?? []).length > 0).length;
  const firstEvent = trajectoryEvents[0];
  const lastEvent = trajectoryEvents.at(-1);

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              Student Trajectories
            </p>
            <h3 className="text-base font-black text-slate-900">Observed record over time</h3>
            <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-slate-500">
              This view combines saved diary entries and sent feedback records for one student. It supports inspection and continuity decisions; it does not score progress or diagnose ability.
            </p>
          </div>
          <label className="flex min-w-[260px] flex-col gap-1">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">Student</span>
            <select
              value={selectedStudent?.key ?? ''}
              onChange={(event) => setSelectedStudentKey(event.target.value)}
              className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 shadow-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            >
              {studentOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.name} ({option.entryCount} entries, {option.feedbackCount} sent)
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<FileText size={18} />}
          label="Entries Found"
          value={String(studentEntries.length)}
          detail="saved diary entries"
        />
        <MetricTile
          icon={<MessageSquare size={18} />}
          label="Sent Feedback"
          value={String(sentCount)}
          detail="feedback-history records"
        />
        <MetricTile
          icon={<ShieldCheck size={18} />}
          label="Uptake Marked"
          value={String(uptakeCount)}
          detail={`${formatPercent(uptakeCount, sentCount)} of sent records`}
        />
        <MetricTile
          icon={<AlertTriangle size={18} />}
          label="Parse Warnings"
          value={String(warningCount)}
          detail="entries with captured warnings"
          tone={warningCount > 0 ? 'amber' : 'slate'}
        />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              Measurement Conditions
            </p>
            <h3 className="text-base font-black text-slate-900">What this trajectory includes</h3>
          </div>
          <p className="text-xs font-semibold text-slate-400">
            Events: {trajectoryEvents.length}
          </p>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <ConditionRow
            label="Identity key"
            value={selectedStudent?.upn ? 'UPN' : selectedStudent?.graphId ? 'Graph ID' : 'Name'}
            detail={selectedStudent?.upn || selectedStudent?.graphId || selectedStudent?.name || 'Unknown student'}
          />
          <ConditionRow
            label="Date range"
            value={firstEvent && lastEvent ? `${firstEvent.dateLabel} - ${lastEvent.dateLabel}` : 'None'}
            detail="from entry dates and feedback sentAt timestamps"
          />
          <ConditionRow
            label="Parser/template mix"
            value={`${parserModes.size || 0}/${templates.size || 0}`}
            detail={`Parsers: ${Array.from(parserModes).join(', ') || 'not captured'}; templates: ${Array.from(templates).join(', ') || 'not captured'}`}
          />
        </div>
        {!selectedStudent?.upn && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold leading-relaxed text-amber-900">
            This trajectory is grouped without a UPN. Treat name-based identity as less stable until directory identity is available.
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Evidence</p>
          <h3 className="text-base font-black text-slate-900">Timeline for {selectedStudent?.name}</h3>
          <p className="mt-1 text-xs font-medium text-slate-500">
            Ordered by captured dates. Entry and feedback events are observational records, not a progress score.
          </p>
        </div>
        <div className="divide-y divide-slate-100">
          {trajectoryEvents.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm font-semibold text-slate-400">
              No entry or feedback events were found for this student.
            </div>
          ) : (
            trajectoryEvents.map((event) => (
              <TrajectoryEventRow key={event.id} event={event} />
            ))
          )}
        </div>
      </section>
    </div>
  );
};

const TrajectoryEventRow: React.FC<{ event: TrajectoryEvent }> = ({ event }) => {
  const toneClass =
    event.tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-700'
      : event.tone === 'amber'
      ? 'bg-amber-50 text-amber-700'
      : event.tone === 'indigo'
      ? 'bg-indigo-50 text-indigo-700'
      : 'bg-slate-100 text-slate-600';

  return (
    <div className="grid gap-4 px-5 py-4 md:grid-cols-[140px_1fr]">
      <div>
        <p className="text-xs font-black text-slate-700">{event.dateLabel}</p>
        <span className={`mt-2 inline-flex rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wider ${toneClass}`}>
          {event.kind === 'entry' ? 'entry' : 'sent feedback'}
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h4 className="truncate text-sm font-black text-slate-900" title={event.title}>{event.title}</h4>
            <p className="mt-1 text-xs font-semibold text-slate-500">{event.detail}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {event.chips.map((chip) => (
            <span key={chip} className="rounded-full bg-slate-50 px-2 py-1 text-[10px] font-bold text-slate-500">
              {chip}
            </span>
          ))}
        </div>
        {event.excerpt && (
          <p className="mt-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs font-medium leading-relaxed text-slate-600">
            {event.excerpt}
          </p>
        )}
      </div>
    </div>
  );
};

interface ClassPatternsTabProps {
  entries: StoredDiaryEntry[];
  pageRecords: PageSyncRecord[];
  feedbackRecords: FeedbackHistoryRecord[];
  selectedClasses: EducationClass[];
}

interface ClassPatternEvidenceRow {
  entryId: string;
  studentName: string;
  classId: string;
  classDisplayName: string;
  weekNumber: string;
  date: string;
  pageTitle: string;
  vocabCount: number;
  peerFeedbackCount: number;
  translationCount: number;
  photoCount: number;
  chatbotPresent: boolean;
  warningCount: number;
  parserMode: ParserMode;
  templateVersion: TemplateVersion;
  updatedAt: string;
}

const ClassPatternsTab: React.FC<ClassPatternsTabProps> = ({
  entries,
  pageRecords,
  feedbackRecords,
  selectedClasses,
}) => {
  const [classFilter, setClassFilter] = useState<string>('all');
  const [weekFilter, setWeekFilter] = useState<string>('all');
  const [fieldFilter, setFieldFilter] = useState<ClassPatternsFieldFilter>('all');
  const [sortKey, setSortKey] = useState<ClassPatternsSortKey>('weekNumber');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const classNameById = useMemo(
    () => Object.fromEntries(selectedClasses.map((cls) => [cls.id, cls.displayName] as const)),
    [selectedClasses]
  );
  const pageRecordById = useMemo(
    () => Object.fromEntries(pageRecords.map((record) => [record.pageId, record] as const)),
    [pageRecords]
  );
  const representedStudents = useMemo(
    () => new Set(entries.map(deriveStudentKey)).size,
    [entries]
  );
  const weeks = useMemo(
    () => {
      const weekLabels = entries.map((entry) => entry.weekNumber || 'not captured');
      return Array.from(new Set<string>(weekLabels)).sort((a, b) => compareValues(a, b));
    },
    [entries]
  );
  const parserModes = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.parserMode))).sort(),
    [entries]
  );
  const templates = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.templateVersion))).sort(),
    [entries]
  );

  const rows = useMemo<ClassPatternEvidenceRow[]>(() => {
    const nextRows = entries.map((entry) => {
      const pageRecord = pageRecordById[entry.pageId];
      return {
        entryId: entry.entryId,
        studentName: entry.studentName || 'Unknown student',
        classId: entry.classId,
        classDisplayName: classNameById[entry.classId] ?? entry.classId,
        weekNumber: entry.weekNumber || 'not captured',
        date: entry.date || '',
        pageTitle: entry.pageTitle || 'Diary entry',
        vocabCount: entry.vocabCount,
        peerFeedbackCount: entry.peerFeedback.length,
        translationCount: entry.translationCount,
        photoCount: entry.photoCount,
        chatbotPresent: Boolean(
          entry.chatbotFeedback?.prompt ||
          entry.chatbotFeedback?.studentResponse ||
          entry.chatbotFeedback?.aiResponse
        ),
        warningCount: (entry.parseWarnings ?? []).length,
        parserMode: pageRecord?.parserMode ?? entry.parserMode,
        templateVersion: pageRecord?.templateVersion ?? entry.templateVersion,
        updatedAt: entry.updatedAt,
      };
    });

    return nextRows
      .filter((row) => classFilter === 'all' || row.classId === classFilter)
      .filter((row) => weekFilter === 'all' || row.weekNumber === weekFilter)
      .filter((row) => {
        if (fieldFilter === 'peerFeedback') return row.peerFeedbackCount > 0;
        if (fieldFilter === 'vocab') return row.vocabCount > 0;
        if (fieldFilter === 'translations') return row.translationCount > 0;
        if (fieldFilter === 'photos') return row.photoCount > 0;
        if (fieldFilter === 'chatbot') return row.chatbotPresent;
        if (fieldFilter === 'warnings') return row.warningCount > 0;
        return true;
      })
      .sort((a, b) => {
        const values: Record<ClassPatternsSortKey, [string | number | boolean, string | number | boolean]> = {
          studentName: [a.studentName, b.studentName],
          classDisplayName: [a.classDisplayName, b.classDisplayName],
          weekNumber: [a.weekNumber, b.weekNumber],
          date: [parseSortableTime(a.date), parseSortableTime(b.date)],
          vocabCount: [a.vocabCount, b.vocabCount],
          peerFeedbackCount: [a.peerFeedbackCount, b.peerFeedbackCount],
          translationCount: [a.translationCount, b.translationCount],
          photoCount: [a.photoCount, b.photoCount],
        };
        const result = compareValues(values[sortKey][0], values[sortKey][1]);
        return sortDirection === 'asc' ? result : -result;
      });
  }, [classFilter, classNameById, entries, fieldFilter, pageRecordById, sortDirection, sortKey, weekFilter]);

  const entryCountsByWeek = useMemo(
    () => countBy<StoredDiaryEntry>(entries, (entry) => entry.weekNumber || 'not captured'),
    [entries]
  );
  const entryCountsByStudent = useMemo(
    () => countBy<StoredDiaryEntry>(entries, deriveStudentKey),
    [entries]
  );
  const studentEntryBands = useMemo(() => {
    const counts = Object.values(entryCountsByStudent) as number[];
    return {
      one: counts.filter((count) => count === 1).length,
      two: counts.filter((count) => count === 2).length,
      threeToFour: counts.filter((count) => count >= 3 && count <= 4).length,
      fivePlus: counts.filter((count) => count >= 5).length,
    };
  }, [entryCountsByStudent]);
  const latestEntryUpdate = entries.map((entry) => entry.updatedAt).filter(Boolean).sort().at(-1);
  const warningEntries = entries.filter((entry) => (entry.parseWarnings ?? []).length > 0).length;
  const sentFeedbackCount = feedbackRecords.length;
  const entriesWithPeer = entries.filter((entry) => entry.peerFeedback.length > 0).length;
  const entriesWithVocab = entries.filter((entry) => entry.vocabCount > 0).length;
  const entriesWithTranslations = entries.filter((entry) => entry.translationCount > 0).length;
  const entriesWithPhotos = entries.filter((entry) => entry.photoCount > 0).length;
  const entriesWithChatbot = entries.filter((entry) =>
    Boolean(entry.chatbotFeedback?.prompt || entry.chatbotFeedback?.studentResponse || entry.chatbotFeedback?.aiResponse)
  ).length;

  const handleSort = (nextKey: ClassPatternsSortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(nextKey);
    setSortDirection('asc');
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              Class Patterns
            </p>
            <h3 className="text-base font-black text-slate-900">Aggregate descriptors for selected classes</h3>
          </div>
          <p className="text-xs font-semibold text-slate-400">
            Denominator: {entries.length} saved entr{entries.length === 1 ? 'y' : 'ies'}
          </p>
        </div>
        <p className="mt-3 max-w-4xl text-sm font-medium leading-relaxed text-slate-500">
          These panels summarize activity traces and workflow records at class level. They surface what to inspect next; they do not rank students, infer proficiency, or claim learning gains.
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<FileText size={18} />}
          label="Entries Included"
          value={String(entries.length)}
          detail="saved diary entries"
        />
        <MetricTile
          icon={<UserRound size={18} />}
          label="Students Represented"
          value={String(representedStudents)}
          detail="from saved entry identity fields"
        />
        <MetricTile
          icon={<MessageSquare size={18} />}
          label="Sent Feedback"
          value={String(sentFeedbackCount)}
          detail="feedback-history records"
        />
        <MetricTile
          icon={<AlertTriangle size={18} />}
          label="Parse Warnings"
          value={String(warningEntries)}
          detail={`${formatPercent(warningEntries, entries.length)} of entries`}
          tone={warningEntries > 0 ? 'amber' : 'slate'}
        />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              Measurement Conditions
            </p>
            <h3 className="text-base font-black text-slate-900">What the aggregate view includes</h3>
          </div>
          <p className="text-xs font-semibold text-slate-400">
            Last entry update: {formatTimestamp(latestEntryUpdate)}
          </p>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <ConditionRow
            label="Selected classes"
            value={String(selectedClasses.length)}
            detail={selectedClasses.map((cls) => cls.displayName).join(', ') || 'None'}
          />
          <ConditionRow
            label="Parser modes"
            value={String(parserModes.length)}
            detail={parserModes.map((mode) => mode === 'label-first' ? 'labels first' : 'AI first').join(', ') || 'not captured'}
          />
          <ConditionRow
            label="Templates"
            value={String(templates.length)}
            detail={templates.join(', ') || 'not captured'}
          />
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <DistributionPanel
          title="Entries By Week"
          description="Saved entries grouped by captured week label. Missing or inconsistent week labels are measurement conditions."
          total={entries.length}
          rows={weeks.map((week) => ({
            label: week === 'not captured' ? 'week not captured' : `week ${week}`,
            count: entryCountsByWeek[week] ?? 0,
          }))}
        />
        <DistributionPanel
          title="Entries Per Represented Student"
          description="Distribution across students present in saved entry identity fields. This is not a roster-completion measure."
          total={representedStudents}
          rows={[
            { label: '1 entry', count: studentEntryBands.one },
            { label: '2 entries', count: studentEntryBands.two },
            { label: '3-4 entries', count: studentEntryBands.threeToFour },
            { label: '5+ entries', count: studentEntryBands.fivePlus },
          ]}
        />
        <DistributionPanel
          title="Participation Descriptors"
          description="Entry-level activity traces. A single entry can include multiple descriptors, so percentages do not add to 100."
          total={entries.length}
          rows={[
            { label: 'peer comments present', count: entriesWithPeer },
            { label: 'vocabulary present', count: entriesWithVocab },
            { label: 'translations present', count: entriesWithTranslations },
            { label: 'photos present', count: entriesWithPhotos },
            { label: 'chatbot section present', count: entriesWithChatbot },
          ]}
        />
        <DistributionPanel
          title="Vocabulary Count Bands"
          description="Entry-level vocabulary item counts. These are activity counts, not vocabulary sophistication or proficiency."
          total={entries.length}
          rows={[
            { label: '0 items', count: entries.filter((entry) => entry.vocabCount === 0).length },
            { label: '1-4 items', count: entries.filter((entry) => entry.vocabCount >= 1 && entry.vocabCount <= 4).length },
            { label: '5-9 items', count: entries.filter((entry) => entry.vocabCount >= 5 && entry.vocabCount <= 9).length },
            { label: '10+ items', count: entries.filter((entry) => entry.vocabCount >= 10).length },
          ]}
        />
      </section>

      <ClassPatternEvidenceTable
        rows={rows}
        totalRows={entries.length}
        classFilter={classFilter}
        weekFilter={weekFilter}
        fieldFilter={fieldFilter}
        selectedClasses={selectedClasses}
        weeks={weeks}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onClassFilterChange={setClassFilter}
        onWeekFilterChange={setWeekFilter}
        onFieldFilterChange={setFieldFilter}
        onSort={handleSort}
      />
    </div>
  );
};

interface ClassPatternEvidenceTableProps {
  rows: ClassPatternEvidenceRow[];
  totalRows: number;
  classFilter: string;
  weekFilter: string;
  fieldFilter: ClassPatternsFieldFilter;
  selectedClasses: EducationClass[];
  weeks: string[];
  sortKey: ClassPatternsSortKey;
  sortDirection: SortDirection;
  onClassFilterChange: (value: string) => void;
  onWeekFilterChange: (value: string) => void;
  onFieldFilterChange: (value: ClassPatternsFieldFilter) => void;
  onSort: (key: ClassPatternsSortKey) => void;
}

const ClassPatternEvidenceTable: React.FC<ClassPatternEvidenceTableProps> = ({
  rows,
  totalRows,
  classFilter,
  weekFilter,
  fieldFilter,
  selectedClasses,
  weeks,
  sortKey,
  sortDirection,
  onClassFilterChange,
  onWeekFilterChange,
  onFieldFilterChange,
  onSort,
}) => (
  <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 xl:flex-row xl:items-end xl:justify-between">
      <div>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Evidence</p>
        <h3 className="text-base font-black text-slate-900">Entries behind Class Patterns</h3>
        <p className="mt-1 text-xs font-medium text-slate-500">
          Showing {rows.length} of {totalRows} saved entries. Filters narrow the evidence set without changing the aggregate doctrine.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 xl:flex xl:items-center">
        <FilterSelect
          label="Class"
          value={classFilter}
          onChange={onClassFilterChange}
          options={[
            ['all', 'All classes'],
            ...selectedClasses.map((cls) => [cls.id, cls.displayName] as [string, string]),
          ]}
        />
        <FilterSelect
          label="Week"
          value={weekFilter}
          onChange={onWeekFilterChange}
          options={[
            ['all', 'All weeks'],
            ...weeks.map((week) => [week, week === 'not captured' ? 'week not captured' : `week ${week}`] as [string, string]),
          ]}
        />
        <FilterSelect
          label="Descriptor"
          value={fieldFilter}
          onChange={(value) => onFieldFilterChange(value as ClassPatternsFieldFilter)}
          options={[
            ['all', 'All entries'],
            ['peerFeedback', 'Peer comments'],
            ['vocab', 'Vocabulary'],
            ['translations', 'Translations'],
            ['photos', 'Photos'],
            ['chatbot', 'Chatbot section'],
            ['warnings', 'Warnings'],
          ]}
        />
      </div>
    </div>

    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
        <thead>
          <tr className="bg-slate-50 text-[10px] font-black uppercase tracking-widest text-slate-400">
            <ClassPatternSortableHeader label="Student" sortKeyName="studentName" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
            <ClassPatternSortableHeader label="Class" sortKeyName="classDisplayName" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
            <ClassPatternSortableHeader label="Week" sortKeyName="weekNumber" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
            <ClassPatternSortableHeader label="Date" sortKeyName="date" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
            <ClassPatternSortableHeader label="Vocab" sortKeyName="vocabCount" activeKey={sortKey} direction={sortDirection} onSort={onSort} align="right" />
            <ClassPatternSortableHeader label="Peer" sortKeyName="peerFeedbackCount" activeKey={sortKey} direction={sortDirection} onSort={onSort} align="right" />
            <ClassPatternSortableHeader label="Trans." sortKeyName="translationCount" activeKey={sortKey} direction={sortDirection} onSort={onSort} align="right" />
            <ClassPatternSortableHeader label="Photos" sortKeyName="photoCount" activeKey={sortKey} direction={sortDirection} onSort={onSort} align="right" />
            <th className="border-y border-slate-100 px-5 py-2 text-left">Conditions</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-5 py-8 text-center text-sm font-semibold text-slate-400">
                No entries match the current filters.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.entryId} className="border-t border-slate-100 text-slate-600">
                <td className="max-w-[170px] border-t border-slate-100 px-5 py-3 font-bold text-slate-700">
                  <div className="truncate" title={row.studentName}>{row.studentName}</div>
                  <div className="truncate text-[10px] font-semibold text-slate-400" title={row.pageTitle}>{row.pageTitle}</div>
                </td>
                <td className="max-w-[160px] border-t border-slate-100 px-5 py-3 font-semibold">
                  <div className="truncate" title={row.classDisplayName}>{row.classDisplayName}</div>
                </td>
                <td className="border-t border-slate-100 px-5 py-3 font-semibold">{row.weekNumber}</td>
                <td className="border-t border-slate-100 px-5 py-3 font-semibold text-slate-500">{row.date || 'not captured'}</td>
                <td className="border-t border-slate-100 px-5 py-3 text-right font-black tabular-nums">{row.vocabCount}</td>
                <td className="border-t border-slate-100 px-5 py-3 text-right font-black tabular-nums">{row.peerFeedbackCount}</td>
                <td className="border-t border-slate-100 px-5 py-3 text-right font-black tabular-nums">{row.translationCount}</td>
                <td className="border-t border-slate-100 px-5 py-3 text-right font-black tabular-nums">{row.photoCount}</td>
                <td className="border-t border-slate-100 px-5 py-3">
                  <div className="flex flex-wrap gap-1">
                    {row.chatbotPresent && <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-500">chatbot</span>}
                    {row.warningCount > 0 && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">{row.warningCount} warning{row.warningCount === 1 ? '' : 's'}</span>}
                    <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                      {row.parserMode === 'label-first' ? 'labels first' : 'AI first'}
                    </span>
                    <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                      {row.templateVersion}
                    </span>
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  </section>
);

const ClassPatternSortableHeader: React.FC<{
  label: string;
  sortKeyName: ClassPatternsSortKey;
  activeKey: ClassPatternsSortKey;
  direction: SortDirection;
  align?: 'left' | 'right';
  onSort: (key: ClassPatternsSortKey) => void;
}> = ({ label, sortKeyName, activeKey, direction, align = 'left', onSort }) => (
  <th className={`border-y border-slate-100 px-5 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
    <button
      type="button"
      onClick={() => onSort(sortKeyName)}
      className={`inline-flex items-center gap-1 rounded-md py-1 transition-colors hover:text-indigo-600 ${align === 'right' ? 'justify-end' : 'justify-start'} ${activeKey === sortKeyName ? 'text-indigo-700' : ''}`}
      title={`Sort by ${label}`}
    >
      {label}
      <ArrowUpDown size={11} className={activeKey === sortKeyName && direction === 'desc' ? 'rotate-180' : ''} />
    </button>
  </th>
);

interface DataHealthTabProps {
  selectedClasses: EducationClass[];
  accessToken?: string;
  pageRecords: PageSyncRecord[];
  entries: StoredDiaryEntry[];
  dataHealth: {
    pageStateCounts: Record<string, number>;
    entryStatusCounts: Record<string, number>;
    parserModeCounts: Record<string, number>;
    templateCounts: Record<string, number>;
    entriesWithWarnings: number;
    entriesWithStableIdentity: number;
    stalePages: number;
    studentsRepresented: number;
    studentsWithPageRecords: number;
    pagesWithEntries: number;
    pagesWithoutEntries: number;
    lastPageUpdate?: string;
  };
}

interface DataHealthEvidenceRow {
  pageId: string;
  classDisplayName: string;
  pageTitle: string;
  studentName: string;
  syncState: PageSyncState;
  entryCount: number;
  warningCount: number;
  parserMode: ParserMode;
  templateVersion: TemplateVersion;
  stale: boolean;
  lastParsedAt?: string;
  updatedAt: string;
}

const DataHealthTab: React.FC<DataHealthTabProps> = ({
  selectedClasses,
  accessToken,
  pageRecords,
  entries,
  dataHealth,
}) => {
  const totalPages = pageRecords.length;
  const totalEntries = entries.length;
  const [syncStateFilter, setSyncStateFilter] = useState<PageSyncState | 'all'>('all');
  const [parserModeFilter, setParserModeFilter] = useState<ParserMode | 'all'>('all');
  const [templateFilter, setTemplateFilter] = useState<TemplateVersion | 'all'>('all');
  const [warningFilter, setWarningFilter] = useState<'all' | 'warnings' | 'stale'>('all');
  const [sortKey, setSortKey] = useState<DataHealthSortKey>('studentName');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const classNameById = useMemo(
    () => Object.fromEntries(selectedClasses.map((cls) => [cls.id, cls.displayName] as const)),
    [selectedClasses]
  );
  const entryStatsByPage = useMemo(() => {
    const stats: Record<string, { entryCount: number; warningCount: number }> = {};
    entries.forEach((entry) => {
      const current = stats[entry.pageId] ?? { entryCount: 0, warningCount: 0 };
      current.entryCount += 1;
      current.warningCount += (entry.parseWarnings ?? []).length > 0 ? 1 : 0;
      stats[entry.pageId] = current;
    });
    return stats;
  }, [entries]);

  const evidenceRows = useMemo<DataHealthEvidenceRow[]>(() => {
    const rows = pageRecords.map((record) => {
      const entryStats = entryStatsByPage[record.pageId] ?? { entryCount: 0, warningCount: 0 };
      return {
        pageId: record.pageId,
        classDisplayName: classNameById[record.classId] ?? record.classId,
        pageTitle: record.pageTitle || 'Untitled page',
        studentName: record.studentName || 'Unknown student',
        syncState: record.syncState,
        entryCount: entryStats.entryCount,
        warningCount: entryStats.warningCount,
        parserMode: record.parserMode,
        templateVersion: record.templateVersion,
        stale: isRecordStale(record),
        lastParsedAt: record.lastParsedAt,
        updatedAt: record.updatedAt,
      };
    });

    return rows
      .filter((row) => syncStateFilter === 'all' || row.syncState === syncStateFilter)
      .filter((row) => parserModeFilter === 'all' || row.parserMode === parserModeFilter)
      .filter((row) => templateFilter === 'all' || row.templateVersion === templateFilter)
      .filter((row) => {
        if (warningFilter === 'warnings') return row.warningCount > 0;
        if (warningFilter === 'stale') return row.stale;
        return true;
      })
      .sort((a, b) => {
        const values: Record<DataHealthSortKey, [string | number | boolean, string | number | boolean]> = {
          studentName: [a.studentName, b.studentName],
          pageTitle: [a.pageTitle, b.pageTitle],
          syncState: [a.syncState, b.syncState],
          entryCount: [a.entryCount, b.entryCount],
          warningCount: [a.warningCount, b.warningCount],
          parserMode: [a.parserMode, b.parserMode],
          templateVersion: [a.templateVersion, b.templateVersion],
          lastParsedAt: [parseSortableTime(a.lastParsedAt), parseSortableTime(b.lastParsedAt)],
        };
        const result = compareValues(values[sortKey][0], values[sortKey][1]);
        return sortDirection === 'asc' ? result : -result;
      });
  }, [
    classNameById,
    entryStatsByPage,
    pageRecords,
    parserModeFilter,
    sortDirection,
    sortKey,
    syncStateFilter,
    templateFilter,
    warningFilter,
  ]);

  const handleSort = (nextKey: DataHealthSortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(nextKey);
    setSortDirection('asc');
  };

  return (
    <div className="space-y-5">
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<Database size={18} />}
          label="Saved Pages"
          value={String(dataHealth.pageStateCounts.saved ?? 0)}
          detail={`of ${totalPages} page records`}
        />
        <MetricTile
          icon={<FileText size={18} />}
          label="Diary Entries"
          value={String(totalEntries)}
          detail={`${dataHealth.pagesWithEntries} pages with entries`}
        />
        <MetricTile
          icon={<ShieldCheck size={18} />}
          label="Feedback Ready"
          value={String(dataHealth.entryStatusCounts.approved ?? 0)}
          detail={`of ${totalEntries} saved entries`}
        />
        <MetricTile
          icon={<AlertTriangle size={18} />}
          label="Parse Warnings"
          value={String(dataHealth.entriesWithWarnings)}
          detail={`entries with captured warnings`}
          tone={dataHealth.entriesWithWarnings > 0 ? 'amber' : 'slate'}
        />
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <StackedBar
          title="Entry review state"
          description="Composition of saved entries by workflow state. Denominator is saved entries for the selected classes."
          total={totalEntries}
          segments={[
            { label: 'Feedback ready', count: dataHealth.entryStatusCounts.approved ?? 0, tone: 'emerald' },
            { label: 'Reviewed', count: dataHealth.entryStatusCounts.reviewed ?? 0, tone: 'indigo' },
            { label: 'Draft', count: dataHealth.entryStatusCounts.draft ?? 0, tone: 'slate' },
          ]}
        />
        <StackedBar
          title="Identity stability"
          description="How entries are grouped for cross-entry views. Name-only is a measurement condition, not a student judgement."
          total={totalEntries}
          segments={[
            { label: 'UPN or Graph ID', count: dataHealth.entriesWithStableIdentity, tone: 'indigo' },
            { label: 'Name only', count: totalEntries - dataHealth.entriesWithStableIdentity, tone: 'amber' },
          ]}
        />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              Measurement Conditions
            </p>
            <h3 className="text-base font-black text-slate-900">What this view can see</h3>
          </div>
          <p className="text-xs font-semibold text-slate-400">
            Last page-record update: {formatTimestamp(dataHealth.lastPageUpdate)}
          </p>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <ConditionRow label="Selected classes" value={String(selectedClasses.length)} detail={selectedClasses.map((cls) => cls.displayName).join(', ') || 'None'} />
          <ConditionRow label="Stale page records" value={String(dataHealth.stalePages)} detail="OneNote modified after last parse" />
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            Coverage
          </p>
          <h3 className="text-base font-black text-slate-900">What synced vs. what produced entries</h3>
        </div>
        <p className="mt-3 max-w-4xl text-sm font-medium leading-relaxed text-slate-500">
          Page records are OneNote pages the app discovered and tracked; saved entries are what actually parsed and persisted. A gap here means pages or students synced without producing entries — and the entry export only sees saved entries, so this gap is otherwise invisible.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
          <ConditionRow label="Page records" value={String(totalPages)} detail="OneNote pages discovered and tracked" />
          <ConditionRow label="Students with page records" value={String(dataHealth.studentsWithPageRecords)} detail="distinct students among page records" />
          <ConditionRow label="Students with saved entries" value={String(dataHealth.studentsRepresented)} detail="distinct students among saved entries" />
          <ConditionRow label="Pages with no entries" value={String(dataHealth.pagesWithoutEntries)} detail="synced but parsed to zero entries" />
        </div>
      </section>

      <StructureAuditPanel
        accessToken={accessToken}
        classes={selectedClasses}
        selectedClassIds={selectedClasses.map((c) => c.id)}
      />

      <section className="grid gap-5 lg:grid-cols-2">
        <DistributionPanel
          title="Page Sync State"
          description="Workflow coverage by saved page record. Denominator is page records for selected classes."
          total={totalPages}
          rows={PAGE_SYNC_STATES.map((state) => ({
            label: state.replace('_', ' '),
            count: dataHealth.pageStateCounts[state] ?? 0,
          }))}
        />
        <DistributionPanel
          title="Parser Mode"
          description="Parser mode captured on page records. This matters because different modes are different measurement instruments."
          total={totalPages}
          rows={(['label-first', 'ai'] as ParserMode[]).map((mode) => ({
            label: mode === 'label-first' ? 'labels first' : 'AI first',
            count: dataHealth.parserModeCounts[mode] ?? 0,
          }))}
        />
        <DistributionPanel
          title="Template Version"
          description="Template version captured on page records. Mixed templates should be read as mixed measurement conditions."
          total={totalPages}
          rows={(['labeled-diary-v1', 'legacy-ai'] as TemplateVersion[]).map((version) => ({
            label: version,
            count: dataHealth.templateCounts[version] ?? 0,
          }))}
        />
      </section>

      <EvidenceTable
        rows={evidenceRows}
        totalRows={pageRecords.length}
        syncStateFilter={syncStateFilter}
        parserModeFilter={parserModeFilter}
        templateFilter={templateFilter}
        warningFilter={warningFilter}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSyncStateFilterChange={setSyncStateFilter}
        onParserModeFilterChange={setParserModeFilter}
        onTemplateFilterChange={setTemplateFilter}
        onWarningFilterChange={setWarningFilter}
        onSort={handleSort}
      />
    </div>
  );
};

interface EvidenceTableProps {
  rows: DataHealthEvidenceRow[];
  totalRows: number;
  syncStateFilter: PageSyncState | 'all';
  parserModeFilter: ParserMode | 'all';
  templateFilter: TemplateVersion | 'all';
  warningFilter: 'all' | 'warnings' | 'stale';
  sortKey: DataHealthSortKey;
  sortDirection: SortDirection;
  onSyncStateFilterChange: (value: PageSyncState | 'all') => void;
  onParserModeFilterChange: (value: ParserMode | 'all') => void;
  onTemplateFilterChange: (value: TemplateVersion | 'all') => void;
  onWarningFilterChange: (value: 'all' | 'warnings' | 'stale') => void;
  onSort: (key: DataHealthSortKey) => void;
}

const EvidenceTable: React.FC<EvidenceTableProps> = ({
  rows,
  totalRows,
  syncStateFilter,
  parserModeFilter,
  templateFilter,
  warningFilter,
  sortKey,
  sortDirection,
  onSyncStateFilterChange,
  onParserModeFilterChange,
  onTemplateFilterChange,
  onWarningFilterChange,
  onSort,
}) => (
  <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 xl:flex-row xl:items-end xl:justify-between">
      <div>
        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
          Evidence
        </p>
        <h3 className="text-base font-black text-slate-900">Page records behind Data Health</h3>
        <p className="mt-1 text-xs font-medium text-slate-500">
          Showing {rows.length} of {totalRows} page records. Filters change what is inspected, not what is measured.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:flex xl:items-center">
        <FilterSelect
          label="Sync state"
          value={syncStateFilter}
          onChange={(value) => onSyncStateFilterChange(value as PageSyncState | 'all')}
          options={[
            ['all', 'All states'],
            ...PAGE_SYNC_STATES.map((state) => [state, state.replace('_', ' ')] as [string, string]),
          ]}
        />
        <FilterSelect
          label="Parser"
          value={parserModeFilter}
          onChange={(value) => onParserModeFilterChange(value as ParserMode | 'all')}
          options={[
            ['all', 'All parsers'],
            ['label-first', 'Labels first'],
            ['ai', 'AI first'],
          ]}
        />
        <FilterSelect
          label="Template"
          value={templateFilter}
          onChange={(value) => onTemplateFilterChange(value as TemplateVersion | 'all')}
          options={[
            ['all', 'All templates'],
            ['labeled-diary-v1', 'labeled-diary-v1'],
            ['legacy-ai', 'legacy-ai'],
          ]}
        />
        <FilterSelect
          label="Review"
          value={warningFilter}
          onChange={(value) => onWarningFilterChange(value as 'all' | 'warnings' | 'stale')}
          options={[
            ['all', 'All records'],
            ['warnings', 'Warnings only'],
            ['stale', 'Stale only'],
          ]}
        />
      </div>
    </div>

    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
        <thead>
          <tr className="bg-slate-50 text-[10px] font-black uppercase tracking-widest text-slate-400">
            <SortableHeader label="Student" sortKeyName="studentName" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="Page" sortKeyName="pageTitle" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="State" sortKeyName="syncState" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="Entries" sortKeyName="entryCount" activeKey={sortKey} direction={sortDirection} onSort={onSort} align="right" />
            <SortableHeader label="Warnings" sortKeyName="warningCount" activeKey={sortKey} direction={sortDirection} onSort={onSort} align="right" />
            <SortableHeader label="Parser" sortKeyName="parserMode" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="Template" sortKeyName="templateVersion" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="Last parsed" sortKeyName="lastParsedAt" activeKey={sortKey} direction={sortDirection} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-5 py-8 text-center text-sm font-semibold text-slate-400">
                No page records match the current filters.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.pageId} className="border-t border-slate-100 text-slate-600">
                <td className="max-w-[180px] border-t border-slate-100 px-5 py-3 font-bold text-slate-700">
                  <div className="truncate" title={row.studentName}>{row.studentName}</div>
                  <div className="truncate text-[10px] font-semibold text-slate-400" title={row.classDisplayName}>{row.classDisplayName}</div>
                </td>
                <td className="max-w-[220px] border-t border-slate-100 px-5 py-3">
                  <div className="truncate font-semibold" title={row.pageTitle}>{row.pageTitle}</div>
                  {row.stale && <span className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-amber-700">stale</span>}
                </td>
                <td className="border-t border-slate-100 px-5 py-3 font-semibold capitalize">{row.syncState.replace('_', ' ')}</td>
                <td className="border-t border-slate-100 px-5 py-3 text-right font-black tabular-nums">{row.entryCount}</td>
                <td className={`border-t border-slate-100 px-5 py-3 text-right font-black tabular-nums ${row.warningCount > 0 ? 'text-amber-700' : 'text-slate-500'}`}>{row.warningCount}</td>
                <td className="border-t border-slate-100 px-5 py-3 font-semibold">{row.parserMode === 'label-first' ? 'Labels first' : 'AI first'}</td>
                <td className="border-t border-slate-100 px-5 py-3 font-semibold">{row.templateVersion}</td>
                <td className="border-t border-slate-100 px-5 py-3 font-semibold text-slate-500">{formatTimestamp(row.lastParsedAt)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  </section>
);

const FilterSelect: React.FC<{
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-600 shadow-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
    >
      {options.map(([optionValue, optionLabel]) => (
        <option key={optionValue} value={optionValue}>{optionLabel}</option>
      ))}
    </select>
  </label>
);

const SortableHeader: React.FC<{
  label: string;
  sortKeyName: DataHealthSortKey;
  activeKey: DataHealthSortKey;
  direction: SortDirection;
  align?: 'left' | 'right';
  onSort: (key: DataHealthSortKey) => void;
}> = ({ label, sortKeyName, activeKey, direction, align = 'left', onSort }) => (
  <th className={`border-y border-slate-100 px-5 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
    <button
      type="button"
      onClick={() => onSort(sortKeyName)}
      className={`inline-flex items-center gap-1 rounded-md py-1 transition-colors hover:text-indigo-600 ${align === 'right' ? 'justify-end' : 'justify-start'} ${activeKey === sortKeyName ? 'text-indigo-700' : ''}`}
      title={`Sort by ${label}`}
    >
      {label}
      <ArrowUpDown size={11} className={activeKey === sortKeyName && direction === 'desc' ? 'rotate-180' : ''} />
    </button>
  </th>
);

const MetricTile: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: 'slate' | 'amber' | 'emerald' | 'indigo';
}> = ({ icon, label, value, detail, tone = 'slate' }) => (
  <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
      tone === 'amber'
        ? 'bg-amber-50 text-amber-600'
        : tone === 'emerald'
          ? 'bg-emerald-50 text-emerald-600'
          : tone === 'indigo'
            ? 'bg-indigo-50 text-indigo-600'
            : 'bg-slate-100 text-slate-600'
    }`}>
      {icon}
    </div>
    <div className="min-w-0">
      <p className="truncate text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
        <p className="text-2xl font-black leading-none tracking-tight text-slate-900">{value}</p>
        <p className="truncate text-xs font-semibold text-slate-500">{detail}</p>
      </div>
    </div>
  </div>
);

const ConditionRow: React.FC<{ label: string; value: string; detail: string }> = ({ label, value, detail }) => (
  <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
    <div className="flex items-center gap-2">
      <Clock3 size={14} className="text-slate-400" />
      <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    </div>
    <p className="mt-2 text-lg font-black text-slate-900">{value}</p>
    <p className="mt-1 truncate text-xs font-medium text-slate-500" title={detail}>{detail}</p>
  </div>
);

// Restrained role tones for stacked composition bars. These are NOT good/bad
// colours: slate/indigo/emerald mark workflow roles consistently with the rest
// of the app, and amber marks a measurement *condition* worth noticing (e.g.
// name-only identity), never a judgement about a student.
const STACK_TONES = {
  slate: 'bg-slate-400',
  indigo: 'bg-indigo-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-400',
} as const;

// A single parts-of-a-whole bar with a denominator and a labelled legend. Use
// only for mutually exclusive segments that sum to `total`. Deliberately has no
// target line, gauge, ring, or delta — it answers "what is this data made of",
// not "how close to a goal". Reusable across tabs.
const StackedBar: React.FC<{
  title: string;
  description: string;
  total: number;
  segments: Array<{ label: string; count: number; tone: keyof typeof STACK_TONES }>;
}> = ({ title, description, total, segments }) => (
  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-black text-slate-900">{title}</h3>
        <p className="mt-1 text-xs font-medium leading-relaxed text-slate-500">{description}</p>
      </div>
      <span className="shrink-0 text-xs font-black text-slate-400">{total} total</span>
    </div>
    <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-slate-100">
      {total > 0 &&
        segments
          .filter((segment) => segment.count > 0)
          .map((segment) => (
            <div
              key={segment.label}
              className={`h-full ${STACK_TONES[segment.tone]}`}
              style={{ width: formatPercent(segment.count, total) }}
              title={`${segment.label}: ${segment.count} (${formatPercent(segment.count, total)})`}
            />
          ))}
    </div>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {segments.map((segment) => (
        <span key={segment.label} className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600">
          <span className={`h-2.5 w-2.5 rounded-sm ${STACK_TONES[segment.tone]}`} />
          {segment.label}
          <span className="font-black text-slate-400">
            {segment.count} ({formatPercent(segment.count, total)})
          </span>
        </span>
      ))}
    </div>
  </section>
);

const DistributionPanel: React.FC<{
  title: string;
  description: string;
  total: number;
  rows: Array<{ label: string; count: number }>;
}> = ({ title, description, total, rows }) => (
  <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div>
      <h3 className="text-sm font-black text-slate-900">{title}</h3>
      <p className="mt-1 text-xs font-medium leading-relaxed text-slate-500">{description}</p>
    </div>
    <div className="mt-4 space-y-3">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="text-xs font-bold capitalize text-slate-600">{row.label}</span>
            <span className="text-xs font-black text-slate-500">
              {row.count} / {total} ({formatPercent(row.count, total)})
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-indigo-500"
              style={{ width: formatPercent(row.count, total) }}
            />
          </div>
        </div>
      ))}
    </div>
  </section>
);
