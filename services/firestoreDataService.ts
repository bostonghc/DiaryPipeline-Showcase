import {
  Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  limit as firestoreLimit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  ClassStudentIdentity,
  ChatbotFeedback,
  EducationClass,
  EntryStatus,
  FeedbackHistoryRecord,
  FeedbackReviewDecisionRecord,
  HydratedPageEntry,
  PageSyncRecord,
  PageSyncState,
  ParsedDiaryEntry,
  ParserMode,
  StoredDiaryEntry,
  TeacherFeedbackFields,
  TemplateVersion,
  UserPreferences,
} from '../types';
import { dominantYear, parseEntryDate, parseEntryWeek } from './diaryChronology';
import { recordRead } from './readMeter';

export const DEFAULT_PARSER_MODE: ParserMode = 'ai';
export const DEFAULT_TEMPLATE_VERSION: TemplateVersion = 'legacy-ai';
export const LABEL_TEMPLATE_VERSION: TemplateVersion = 'labeled-diary-v1';

const normalizeComparableText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const parseTimestamp = (value?: string): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const statusRank = (status: EntryStatus): number => {
  switch (status) {
    case 'approved':
      return 3;
    case 'reviewed':
      return 2;
    default:
      return 1;
  }
};

const isGenericEntryId = (entryId: string, pageId: string): boolean => {
  const localId = entryId.startsWith(`${pageId}_`) ? entryId.slice(pageId.length + 1) : entryId;
  return /^(?:entry_\d+|idx\d+)(?:_\d+)?$/i.test(localId);
};

const buildStoredEntryFingerprint = (entry: StoredDiaryEntry): string =>
  [
    entry.pageId,
    normalizeComparableText(entry.date),
    normalizeComparableText(entry.weekNumber),
    normalizeComparableText(entry.weather),
    normalizeComparableText(entry.diaryText),
    entry.photoCount,
    normalizeComparableText(
      JSON.stringify(
        (entry.peerFeedback || []).map((item) => ({
          contributor: item.contributor,
          feedback: item.feedback,
        }))
      )
    ),
    normalizeComparableText(JSON.stringify(entry.vocabItems || [])),
    normalizeComparableText(JSON.stringify(entry.translations || [])),
    normalizeComparableText(JSON.stringify(entry.chatbotFeedback || { present: false, data: '' })),
  ].join('|');

const buildStoredEntrySlotKey = (entry: StoredDiaryEntry): string | null => {
  const dateKey = normalizeComparableText(entry.date);
  const weekKey = normalizeComparableText(entry.weekNumber);
  if (dateKey || weekKey) return `slot:${entry.pageId}|${dateKey}|${weekKey}`;

  const diaryKey = normalizeComparableText(entry.diaryText).slice(0, 160);
  return diaryKey ? `diary:${entry.pageId}|${diaryKey}` : null;
};

const getStoredEntryRichnessScore = (entry: StoredDiaryEntry): number =>
  [
    entry.date ? 1 : 0,
    entry.weekNumber ? 1 : 0,
    entry.weather ? 1 : 0,
    entry.diaryText ? Math.min(4, Math.ceil(entry.diaryText.length / 120)) : 0,
    entry.peerFeedback.length > 0 ? 2 : 0,
    entry.vocabItems.length > 0 ? 1 : 0,
    entry.translations.length > 0 ? 1 : 0,
    entry.chatbotFeedback.present ? 1 : 0,
    entry.photoCount > 0 ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);

const preferHydratedEntry = (current: HydratedPageEntry, candidate: HydratedPageEntry): HydratedPageEntry => {
  const currentStatusRank = statusRank(current.storedEntry.status);
  const candidateStatusRank = statusRank(candidate.storedEntry.status);
  if (candidateStatusRank !== currentStatusRank) {
    return candidateStatusRank > currentStatusRank ? candidate : current;
  }

  const currentGeneric = isGenericEntryId(current.storedEntry.entryId, current.storedEntry.pageId);
  const candidateGeneric = isGenericEntryId(candidate.storedEntry.entryId, candidate.storedEntry.pageId);
  if (currentGeneric !== candidateGeneric) {
    return candidateGeneric ? current : candidate;
  }

  const currentScore = getStoredEntryRichnessScore(current.storedEntry);
  const candidateScore = getStoredEntryRichnessScore(candidate.storedEntry);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current;
  }

  const currentModified = parseTimestamp(current.storedEntry.oneNoteLastModified);
  const candidateModified = parseTimestamp(candidate.storedEntry.oneNoteLastModified);
  if (candidateModified !== currentModified) {
    return candidateModified > currentModified ? candidate : current;
  }

  const currentUpdated = parseTimestamp(current.storedEntry.updatedAt);
  const candidateUpdated = parseTimestamp(candidate.storedEntry.updatedAt);
  return candidateUpdated > currentUpdated ? candidate : current;
};

export const collapseHydratedPageEntries = (entries: HydratedPageEntry[]): HydratedPageEntry[] => {
  const byFingerprint = new Map<string, HydratedPageEntry>();
  entries.forEach((entry) => {
    const fingerprint = buildStoredEntryFingerprint(entry.storedEntry);
    const existing = byFingerprint.get(fingerprint);
    byFingerprint.set(fingerprint, existing ? preferHydratedEntry(existing, entry) : entry);
  });

  const bySlot = new Map<string, HydratedPageEntry>();
  Array.from(byFingerprint.values()).forEach((entry) => {
    const slotKey = buildStoredEntrySlotKey(entry.storedEntry);
    if (!slotKey) {
      bySlot.set(`id:${entry.storedEntry.entryId}`, entry);
      return;
    }

    const existing = bySlot.get(slotKey);
    bySlot.set(slotKey, existing ? preferHydratedEntry(existing, entry) : entry);
  });

  const deduped = Array.from(bySlot.values());
  const fallbackYear = dominantYear(deduped.map((entry) => entry.storedEntry.date));

  return deduped.sort((a, b) => {
    // Sort chronologically. `date` is a human-readable string (e.g. "April 24, 2020"),
    // so a lexicographic localeCompare would order by month name alphabetically and
    // scramble a full-year page. Parse to a real timestamp instead (filling in the
    // page's dominant year for year-less dates), and compare weekNumber numerically.
    // Entries whose date is unparseable fall to the end and are then ordered by week,
    // preserving a stable, sensible order.
    const dateA = parseEntryDate(a.storedEntry.date, fallbackYear);
    const dateB = parseEntryDate(b.storedEntry.date, fallbackYear);
    if (dateA !== dateB) return dateA - dateB;
    const weekA = parseEntryWeek(a.storedEntry.weekNumber);
    const weekB = parseEntryWeek(b.storedEntry.weekNumber);
    if (weekA !== weekB) return weekA - weekB;
    return a.storedEntry.entryId.localeCompare(b.storedEntry.entryId);
  });
};

type StoredEntryWire = {
  entryId: string;
  pageId: string;
  pageTitle?: string;
  classId: string;
  diaryGroupId?: string;
  diaryGroupName?: string;
  studentName: string;
  studentGraphId?: string;
  studentUpn?: string;
  date?: string;
  weekNumber?: string;
  weather?: string;
  diaryTextOriginal?: string;
  diaryTextCorrected?: string;
  teacherFeedback?: string;
  peerFeedback?: string;
  translations?: string;
  vocabCount?: number;
  sentiment?: string;
  topics?: string;
  vocabItems?: string;
  photoCount?: number;
  translationCount?: number;
  chatbotFeedback?: string;
  status: EntryStatus;
  parserMode?: ParserMode;
  templateVersion?: TemplateVersion;
  oneNoteLastModified?: string;
  parseWarnings?: string;
  rawText?: string;
  approvedAt?: string;
  updatedAt: string;
};

type PageSyncWire = {
  pageId: string;
  classId: string;
  pageTitle?: string;
  studentName?: string;
  diaryGroupId?: string;
  diaryGroupName?: string;
  studentGraphId?: string;
  studentUpn?: string;
  parserMode?: ParserMode;
  templateVersion?: TemplateVersion;
  syncState?: PageSyncState;
  entryCount?: number;
  oneNoteLastModified?: string;
  lastParsedAt?: string;
  lastViewedAt?: string;
  lastError?: string;
  nextRetryAt?: string;
  updatedAt: string;
};

type ClassStudentIdentityWire = {
  classId: string;
  graphId: string;
  displayName: string;
  upn: string;
  mail?: string;
  studentNumber?: string;
  updatedAt: string;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const TEACHER_FEEDBACK_KEYS: ReadonlyArray<keyof TeacherFeedbackFields> = [
  'diaryText', 'peerFeedback', 'vocab', 'translations', 'chatbot', 'overall',
  'date', 'weather', 'weekNumber', 'photos',
];

const normalizeTeacherFeedback = (value: unknown): TeacherFeedbackFields => {
  const parsed = parseJson<Record<string, unknown>>(value, {});
  const result: TeacherFeedbackFields = {};
  for (const key of TEACHER_FEEDBACK_KEYS) {
    const v = parsed[key];
    if (typeof v === 'string') result[key] = v;
  }
  return result;
};

const normalizeChatbotFeedback = (value: unknown): ChatbotFeedback => {
  const parsed = parseJson<Partial<ChatbotFeedback>>(value, {});
  return {
    present: Boolean(parsed.present),
    data: String(parsed.data || ''),
  };
};

const normalizeStoredDate = (value: unknown, parserMode?: ParserMode, status?: EntryStatus): string => {
  const normalized = String(value || '');
  if (!normalized) return '';

  // Backward-compatibility cleanup:
  // older label-first saves could inject the current ISO timestamp when the real date was missing.
  // Preserve approved snapshots as-is, but treat draft timestamp fallbacks as missing.
  if (
    parserMode === 'label-first' &&
    status !== 'approved' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(normalized)
  ) {
    return '';
  }

  return normalized;
};

const stripUndefined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined)) as T;

const hydrateClassStudentIdentity = (data: ClassStudentIdentityWire): ClassStudentIdentity => ({
  classId: String(data.classId || ''),
  graphId: String(data.graphId || ''),
  displayName: String(data.displayName || ''),
  upn: String(data.upn || ''),
  mail: data.mail ? String(data.mail) : undefined,
  studentNumber: data.studentNumber ? String(data.studentNumber) : undefined,
  updatedAt: String(data.updatedAt || new Date().toISOString()),
});

export const hydratePageSyncRecord = (data: PageSyncWire): PageSyncRecord => ({
  pageId: String(data.pageId || ''),
  classId: String(data.classId || ''),
  pageTitle: String(data.pageTitle || ''),
  studentName: String(data.studentName || 'Unknown Student'),
  diaryGroupId: data.diaryGroupId ? String(data.diaryGroupId) : undefined,
  diaryGroupName: data.diaryGroupName ? String(data.diaryGroupName) : undefined,
  studentGraphId: data.studentGraphId ? String(data.studentGraphId) : undefined,
  studentUpn: data.studentUpn ? String(data.studentUpn) : undefined,
  parserMode: data.parserMode || DEFAULT_PARSER_MODE,
  templateVersion:
    data.templateVersion ||
    (data.parserMode === 'label-first' ? LABEL_TEMPLATE_VERSION : DEFAULT_TEMPLATE_VERSION),
  syncState: data.syncState || 'idle',
  entryCount: Number(data.entryCount || 0),
  oneNoteLastModified: data.oneNoteLastModified,
  lastParsedAt: data.lastParsedAt,
  lastViewedAt: data.lastViewedAt,
  lastError: data.lastError,
  nextRetryAt: data.nextRetryAt,
  updatedAt: String(data.updatedAt || new Date().toISOString()),
});

export const withClassDefaults = (cls: EducationClass): EducationClass => ({
  ...cls,
  parserMode: cls.parserMode || DEFAULT_PARSER_MODE,
  templateVersion:
    cls.templateVersion ||
    (cls.parserMode === 'label-first' ? LABEL_TEMPLATE_VERSION : DEFAULT_TEMPLATE_VERSION),
});

export const mergeClassMetadata = (
  classes: EducationClass[],
  metadata: Record<string, Partial<EducationClass>>
): EducationClass[] =>
  classes.map((cls) => withClassDefaults({ ...cls, ...(metadata[cls.id] || {}) }));

export const hydrateStoredEntry = (data: StoredEntryWire): HydratedPageEntry => {
  const peerFeedback = parseJson(data.peerFeedback, []);
  const translations = parseJson(data.translations, []);
  const vocabItems = parseJson(data.vocabItems, []);
  const topics = parseJson(data.topics, []);

  const storedEntry: StoredDiaryEntry = {
    entryId: String(data.entryId || ''),
    pageId: String(data.pageId || ''),
    pageTitle: String(data.pageTitle || ''),
    classId: String(data.classId || ''),
    diaryGroupId: data.diaryGroupId ? String(data.diaryGroupId) : undefined,
    diaryGroupName: data.diaryGroupName ? String(data.diaryGroupName) : undefined,
    studentName: String(data.studentName || 'Unknown Student'),
    studentGraphId: data.studentGraphId ? String(data.studentGraphId) : undefined,
    studentUpn: data.studentUpn ? String(data.studentUpn) : undefined,
    date: normalizeStoredDate(data.date, data.parserMode, data.status),
    weekNumber: String(data.weekNumber || ''),
    weather: String(data.weather || ''),
    diaryText: String(data.diaryTextOriginal || ''),
    diaryTextCorrected: String(data.diaryTextCorrected || ''),
    teacherFeedback: normalizeTeacherFeedback(data.teacherFeedback),
    peerFeedback,
    translations,
    vocabCount: vocabItems.length,
    sentiment: String(data.sentiment || 'neutral'),
    topics,
    vocabItems,
    photoCount: Number(data.photoCount || 0),
    translationCount: translations.length,
    chatbotFeedback: normalizeChatbotFeedback(data.chatbotFeedback),
    parseWarnings: data.parseWarnings ? parseJson(data.parseWarnings, []) : undefined,
    rawText: data.rawText || undefined,
    status: data.status || 'draft',
    parserMode: data.parserMode || DEFAULT_PARSER_MODE,
    templateVersion:
      data.templateVersion ||
      (data.parserMode === 'label-first' ? LABEL_TEMPLATE_VERSION : DEFAULT_TEMPLATE_VERSION),
    oneNoteLastModified: data.oneNoteLastModified,
    approvedAt: data.approvedAt,
    updatedAt: String(data.updatedAt || new Date().toISOString()),
  };

  const parsedEntry: ParsedDiaryEntry = {
    id: storedEntry.entryId,
    date: storedEntry.date,
    weekNumber: storedEntry.weekNumber,
    weather: storedEntry.weather,
    diaryText: storedEntry.diaryText,
    peerFeedback: storedEntry.peerFeedback,
    translations: storedEntry.translations,
    vocabCount: storedEntry.vocabCount,
    sentiment: storedEntry.sentiment,
    topics: storedEntry.topics,
    photoCount: storedEntry.photoCount,
    vocabItems: storedEntry.vocabItems,
    translationCount: storedEntry.translationCount,
    chatbotFeedback: storedEntry.chatbotFeedback,
    parseWarnings: storedEntry.parseWarnings,
    rawText: storedEntry.rawText,
  };

  return { parsedEntry, storedEntry };
};

// Graph API page IDs use '!' as a separator (e.g. 1-{notebookId}!1-{pageId}).
// '!' is disallowed in Firestore document ID paths by the security rules regex.
const sanitizeFirestoreId = (id: string) => id.replace(/!/g, '__');

export const buildStoredEntry = ({
  entry,
  status,
  classId,
  pageId,
  pageTitle,
  diaryGroupId,
  diaryGroupName,
  studentName,
  studentGraphId,
  studentUpn,
  teacherFeedback,
  parserMode,
  templateVersion,
  oneNoteLastModified,
}: {
  entry: ParsedDiaryEntry;
  status: EntryStatus;
  classId: string;
  pageId: string;
  pageTitle: string;
  diaryGroupId?: string;
  diaryGroupName?: string;
  studentName: string;
  studentGraphId?: string;
  studentUpn?: string;
  teacherFeedback: TeacherFeedbackFields;
  parserMode: ParserMode;
  templateVersion: TemplateVersion;
  oneNoteLastModified?: string;
}): StoredDiaryEntry => {
  const vocabItems = entry.vocabItems || [];
  const translations = entry.translations || [];

  return {
    entryId: sanitizeFirestoreId(entry.id),
    pageId,
    pageTitle,
    classId,
    diaryGroupId,
    diaryGroupName,
    studentName,
    studentGraphId,
    studentUpn,
    date: String(entry.date || ''),
    weekNumber: String(entry.weekNumber || ''),
    weather: String(entry.weather || ''),
    diaryText: String(entry.diaryText || ''),
    diaryTextCorrected: '',
    teacherFeedback,
    peerFeedback: entry.peerFeedback || [],
    translations,
    vocabCount: vocabItems.length,
    sentiment: String(entry.sentiment || 'neutral'),
    topics: entry.topics || [],
    vocabItems,
    photoCount: Number(entry.photoCount) || 0,
    translationCount: translations.length,
    chatbotFeedback: entry.chatbotFeedback || { present: false, data: '' },
    parseWarnings: entry.parseWarnings,
    rawText: entry.rawText,
    status,
    parserMode,
    templateVersion,
    oneNoteLastModified,
    ...(status === 'approved' ? { approvedAt: new Date().toISOString() } : {}),
    updatedAt: new Date().toISOString(),
  };
};

const serializeStoredEntry = (entry: StoredDiaryEntry): StoredEntryWire =>
  stripUndefined({
    entryId: entry.entryId,
    pageId: entry.pageId,
    pageTitle: entry.pageTitle,
    classId: entry.classId,
    diaryGroupId: entry.diaryGroupId,
    diaryGroupName: entry.diaryGroupName,
    studentName: entry.studentName,
    studentGraphId: entry.studentGraphId,
    studentUpn: entry.studentUpn,
    date: entry.date,
    weekNumber: entry.weekNumber,
    weather: entry.weather,
    diaryTextOriginal: entry.diaryText,
    diaryTextCorrected: entry.diaryTextCorrected,
    teacherFeedback: JSON.stringify(entry.teacherFeedback || {}),
    peerFeedback: JSON.stringify(entry.peerFeedback || []),
    translations: JSON.stringify(entry.translations || []),
    vocabCount: entry.vocabCount,
    sentiment: entry.sentiment,
    topics: JSON.stringify(entry.topics || []),
    vocabItems: JSON.stringify(entry.vocabItems || []),
    photoCount: entry.photoCount,
    translationCount: entry.translationCount,
    chatbotFeedback: JSON.stringify(entry.chatbotFeedback || { present: false, data: '' }),
    parseWarnings: entry.parseWarnings?.length ? JSON.stringify(entry.parseWarnings) : undefined,
    rawText: entry.rawText || undefined,
    status: entry.status,
    parserMode: entry.parserMode,
    templateVersion: entry.templateVersion,
    oneNoteLastModified: entry.oneNoteLastModified,
    approvedAt: entry.approvedAt,
    updatedAt: entry.updatedAt,
  });

const serializePageSyncRecord = (record: PageSyncRecord): PageSyncWire =>
  stripUndefined({
    pageId: record.pageId,
    classId: record.classId,
    pageTitle: record.pageTitle,
    studentName: record.studentName,
    diaryGroupId: record.diaryGroupId,
    diaryGroupName: record.diaryGroupName,
    studentGraphId: record.studentGraphId,
    studentUpn: record.studentUpn,
    parserMode: record.parserMode,
    templateVersion: record.templateVersion,
    syncState: record.syncState,
    entryCount: record.entryCount,
    oneNoteLastModified: record.oneNoteLastModified,
    lastParsedAt: record.lastParsedAt,
    lastViewedAt: record.lastViewedAt,
    lastError: record.lastError,
    nextRetryAt: record.nextRetryAt,
    updatedAt: record.updatedAt,
  });

const serializeClassStudentIdentity = (
  identity: ClassStudentIdentity
): ClassStudentIdentityWire =>
  stripUndefined({
    classId: identity.classId,
    graphId: identity.graphId,
    displayName: identity.displayName,
    upn: identity.upn,
    mail: identity.mail,
    studentNumber: identity.studentNumber,
    updatedAt: identity.updatedAt,
  });

export const fetchEntriesForPage = async (
  db: Firestore,
  uid: string,
  pageId: string
): Promise<HydratedPageEntry[]> => {
  const snapshot = await getDocs(query(collection(db, 'users', uid, 'entries'), where('pageId', '==', pageId)));
  recordRead('entries:page', snapshot.size);
  const hydrated = snapshot.docs.map((entryDoc) => hydrateStoredEntry(entryDoc.data() as StoredEntryWire));
  return collapseHydratedPageEntries(hydrated);
};

export const saveEntryRecord = async (db: Firestore, uid: string, entry: StoredDiaryEntry): Promise<void> => {
  const entryRef = doc(db, 'users', uid, 'entries', entry.entryId);
  await setDoc(entryRef, serializeStoredEntry(entry), { merge: true });
};

export const fetchPageSyncRecord = async (
  db: Firestore,
  uid: string,
  pageId: string
): Promise<PageSyncRecord | null> => {
  const snap = await getDoc(doc(db, 'users', uid, 'pages', pageId));
  recordRead('pageRecord:get', 1);
  if (!snap.exists()) return null;
  return hydratePageSyncRecord(snap.data() as PageSyncWire);
};

export const savePageSyncRecord = async (
  db: Firestore,
  uid: string,
  record: PageSyncRecord
): Promise<void> => {
  await setDoc(doc(db, 'users', uid, 'pages', record.pageId), serializePageSyncRecord(record), { merge: true });
};

// Write an append-only record of a feedback message that was actually sent to a student.
// Document ID is the record's own feedbackId. Records are immutable post-create per
// firestore.rules; an edited/resent message creates a new record.
export const saveFeedbackHistoryRecord = async (
  db: Firestore,
  uid: string,
  record: FeedbackHistoryRecord
): Promise<void> => {
  await setDoc(
    doc(db, 'users', uid, 'feedbackHistory', record.feedbackId),
    sanitizeFeedbackHistoryWire(record)
  );
};

export const sanitizeFeedbackHistoryWire = (record: FeedbackHistoryRecord) => {
  const wire: Record<string, unknown> = {
    feedbackId: record.feedbackId,
    classId: record.classId,
    pageId: record.pageId,
    entryId: record.entryId,
    studentUpn: record.studentUpn,
    studentName: record.studentName,
    channel: record.channel,
    sentAt: record.sentAt,
    source: record.source,
    fieldsAddressed: record.fieldsAddressed,
    content: record.content,
    updatedAt: record.updatedAt,
    formatVersion: typeof record.formatVersion === 'number' ? record.formatVersion : 1,
  };
  if (record.studentGraphId) {
    wire.studentGraphId = record.studentGraphId;
  }
  if (record.batchId) {
    wire.batchId = record.batchId;
  }
  if (record.structuredFeedback) {
    wire.structuredFeedback = record.structuredFeedback;
  }
  if (record.entrySnapshot) {
    wire.entrySnapshot = record.entrySnapshot;
  }
  if (record.itemCountSetting) {
    wire.itemCountSetting = record.itemCountSetting;
  }
  if (record.priorFeedbackMode) {
    wire.priorFeedbackMode = record.priorFeedbackMode;
  }
  if (record.recipientResolutionSource) {
    wire.recipientResolutionSource = record.recipientResolutionSource;
  }
  return wire;
};

export const hydrateFeedbackHistoryRecord = (data: any): FeedbackHistoryRecord => ({
  feedbackId: String(data.feedbackId || ''),
  classId: String(data.classId || ''),
  pageId: String(data.pageId || ''),
  entryId: String(data.entryId || ''),
  studentUpn: String(data.studentUpn || ''),
  studentName: String(data.studentName || ''),
  studentGraphId: data.studentGraphId ? String(data.studentGraphId) : undefined,
  channel: data.channel === 'teams' ? 'teams' : 'email',
  sentAt: String(data.sentAt || ''),
  batchId: data.batchId ? String(data.batchId) : undefined,
  source: ['human', 'ai_drafted', 'ai_drafted_human_edited', 'hybrid'].includes(data.source)
    ? data.source
    : 'human',
  fieldsAddressed: Array.isArray(data.fieldsAddressed)
    ? data.fieldsAddressed.map((f: unknown) => String(f))
    : [],
  content: String(data.content || ''),
  updatedAt: String(data.updatedAt || ''),
  // Legacy records (written before Slice 6) won't carry formatVersion;
  // default to 1 on read. structuredFeedback and entrySnapshot are
  // intentionally absent on legacy records — consumers must handle that.
  formatVersion: typeof data.formatVersion === 'number' ? data.formatVersion : 1,
  structuredFeedback: data.structuredFeedback || undefined,
  entrySnapshot: data.entrySnapshot || undefined,
  uptakeObservedAt: data.uptakeObservedAt ? String(data.uptakeObservedAt) : null,
  itemCountSetting: ['1-2', '3-4', '5+'].includes(data.itemCountSetting)
    ? data.itemCountSetting
    : undefined,
  priorFeedbackMode: ['off', 'reference', 'include'].includes(data.priorFeedbackMode)
    ? data.priorFeedbackMode
    : undefined,
  recipientResolutionSource: ['roster', 'graph_search', 'manual'].includes(data.recipientResolutionSource)
    ? data.recipientResolutionSource
    : undefined,
});

export const saveFeedbackReviewDecisionRecord = async (
  db: Firestore,
  uid: string,
  record: FeedbackReviewDecisionRecord
): Promise<void> => {
  await setDoc(
    doc(db, 'users', uid, 'feedbackReviewDecisions', record.decisionId),
    sanitizeFeedbackReviewDecisionWire(record)
  );
};

export const sanitizeFeedbackReviewDecisionWire = (record: FeedbackReviewDecisionRecord) => {
  const wire: Record<string, unknown> = {
    decisionId: record.decisionId,
    classId: record.classId,
    pageId: record.pageId,
    entryId: record.entryId,
    studentUpn: record.studentUpn,
    studentName: record.studentName,
    decision: record.decision,
    decidedAt: record.decidedAt,
    updatedAt: record.updatedAt,
  };
  if (record.batchId) {
    wire.batchId = record.batchId;
  }
  if (record.studentGraphId) {
    wire.studentGraphId = record.studentGraphId;
  }
  return wire;
};

export const hydrateFeedbackReviewDecisionRecord = (
  data: any
): FeedbackReviewDecisionRecord => ({
  decisionId: String(data.decisionId || ''),
  batchId: data.batchId ? String(data.batchId) : undefined,
  classId: String(data.classId || ''),
  pageId: String(data.pageId || ''),
  entryId: String(data.entryId || ''),
  studentUpn: String(data.studentUpn || ''),
  studentName: String(data.studentName || ''),
  studentGraphId: data.studentGraphId ? String(data.studentGraphId) : undefined,
  decision: data.decision === 'reviewed_no_feedback' ? 'reviewed_no_feedback' : 'reviewed_no_feedback',
  decidedAt: String(data.decidedAt || ''),
  updatedAt: String(data.updatedAt || ''),
});

export const fetchFeedbackReviewDecisionsForPage = async (
  db: Firestore,
  uid: string,
  pageId: string,
  maxRecords = 100
): Promise<FeedbackReviewDecisionRecord[]> => {
  const snap = await getDocs(
    query(
      collection(db, 'users', uid, 'feedbackReviewDecisions'),
      where('pageId', '==', pageId),
      firestoreLimit(maxRecords)
    )
  );
  recordRead('feedbackDecisions:page', snap.size);
  return snap.docs
    .map((d) => hydrateFeedbackReviewDecisionRecord(d.data()))
    .sort((a, b) => parseTimestamp(b.decidedAt) - parseTimestamp(a.decidedAt));
};

export const markFeedbackUptake = async (
  db: Firestore,
  uid: string,
  feedbackId: string,
  observed: boolean
): Promise<void> => {
  await updateDoc(
    doc(db, 'users', uid, 'feedbackHistory', feedbackId),
    { uptakeObservedAt: observed ? new Date().toISOString() : null }
  );
};

// Fetch the most recent feedback messages sent for any entry on a given page,
// ordered newest first. Since each page in this app belongs to one student, this is
// semantically equivalent to "feedback sent to this student in this notebook" — the
// natural scope for the workspace composition context. Bypasses the UPN resolution
// dependency that breaks for owner/non-roster users.
//
// Requires the (pageId ASC, sentAt DESC) composite index in Firestore; the index
// will be requested with a one-click create link the first time this query fires.
export const fetchRecentFeedbackForPage = async (
  db: Firestore,
  uid: string,
  pageId: string,
  maxResults: number = 3
): Promise<FeedbackHistoryRecord[]> => {
  if (!pageId) return [];
  const q = query(
    collection(db, 'users', uid, 'feedbackHistory'),
    where('pageId', '==', pageId),
    orderBy('sentAt', 'desc'),
    firestoreLimit(maxResults)
  );
  const snap = await getDocs(q);
  recordRead('feedbackHistory:page', snap.size);
  return snap.docs.map((d) => hydrateFeedbackHistoryRecord(d.data()));
};

// Requires the (classId ASC, studentUpn ASC, sentAt DESC) composite index in Firestore.
// Firestore will surface a one-click create link in the console the first time this fires.
export const fetchRecentFeedbackForStudent = async (
  db: Firestore,
  uid: string,
  classId: string,
  studentUpn: string,
  maxResults: number = 5
): Promise<FeedbackHistoryRecord[]> => {
  if (!classId || !studentUpn) return [];
  const q = query(
    collection(db, 'users', uid, 'feedbackHistory'),
    where('classId', '==', classId),
    where('studentUpn', '==', studentUpn),
    orderBy('sentAt', 'desc'),
    firestoreLimit(maxResults)
  );
  const snap = await getDocs(q);
  recordRead('feedbackHistory:student', snap.size);
  return snap.docs.map((d) => hydrateFeedbackHistoryRecord(d.data()));
};

export const listFeedbackHistoryForClasses = async (
  db: Firestore,
  uid: string,
  classIds: string[]
): Promise<FeedbackHistoryRecord[]> => {
  const uniqueClassIds = Array.from(new Set(classIds)).filter(Boolean);
  if (uniqueClassIds.length === 0) return [];

  const snapshots = await Promise.all(
    uniqueClassIds.map((classId) =>
      getDocs(query(collection(db, 'users', uid, 'feedbackHistory'), where('classId', '==', classId)))
    )
  );
  recordRead('feedbackHistory:classes', snapshots.reduce((n, s) => n + s.size, 0));

  return snapshots
    .flatMap((snapshot) => snapshot.docs.map((d) => hydrateFeedbackHistoryRecord(d.data())))
    .sort((a, b) => {
      if (a.classId !== b.classId) return a.classId.localeCompare(b.classId);
      return b.sentAt.localeCompare(a.sentAt);
    });
};

export const listPageSyncRecordsForClasses = async (
  db: Firestore,
  uid: string,
  classIds: string[]
): Promise<PageSyncRecord[]> => {
  const uniqueClassIds = Array.from(new Set(classIds)).filter(Boolean);
  if (uniqueClassIds.length === 0) return [];

  const snapshots = await Promise.all(
    uniqueClassIds.map((classId) =>
      getDocs(query(collection(db, 'users', uid, 'pages'), where('classId', '==', classId)))
    )
  );
  recordRead('pageRecords:classes', snapshots.reduce((n, s) => n + s.size, 0));

  return snapshots
    .flatMap((snapshot) =>
      snapshot.docs.map((pageDoc) => hydratePageSyncRecord(pageDoc.data() as PageSyncWire))
    )
    .sort((a, b) => {
      if (a.classId !== b.classId) return a.classId.localeCompare(b.classId);
      if ((a.diaryGroupName || '') !== (b.diaryGroupName || '')) {
        return (a.diaryGroupName || '').localeCompare(b.diaryGroupName || '');
      }
      if (a.studentName !== b.studentName) return a.studentName.localeCompare(b.studentName);
      return a.pageId.localeCompare(b.pageId);
    });
};

export const listClassStudentIdentities = async (
  db: Firestore,
  uid: string,
  classId: string
): Promise<ClassStudentIdentity[]> => {
  if (!classId) return [];

  const snapshot = await getDocs(collection(db, 'users', uid, 'classes', classId, 'students'));
  recordRead('studentIdentities:class', snapshot.size);
  return snapshot.docs
    .map((studentDoc) => hydrateClassStudentIdentity(studentDoc.data() as ClassStudentIdentityWire))
    .filter((identity) => identity.graphId && identity.upn)
    .sort((a, b) => {
      if (a.studentNumber && b.studentNumber && a.studentNumber !== b.studentNumber) {
        return a.studentNumber.localeCompare(b.studentNumber);
      }
      return a.displayName.localeCompare(b.displayName);
    });
};

export const loadClassStudentIdentityMap = async (
  db: Firestore,
  uid: string,
  classIds: string[]
): Promise<Record<string, ClassStudentIdentity[]>> => {
  const identitiesByClass: Record<string, ClassStudentIdentity[]> = {};

  await Promise.all(
    Array.from(new Set(classIds))
      .filter(Boolean)
      .map(async (classId) => {
        identitiesByClass[classId] = await listClassStudentIdentities(db, uid, classId);
      })
  );

  return identitiesByClass;
};

export const saveClassStudentIdentity = async (
  db: Firestore,
  uid: string,
  identity: ClassStudentIdentity
): Promise<void> => {
  await setDoc(
    doc(db, 'users', uid, 'classes', identity.classId, 'students', identity.graphId),
    serializeClassStudentIdentity(identity),
    { merge: true }
  );
};

export const replaceClassStudentIdentities = async (
  db: Firestore,
  uid: string,
  classId: string,
  identities: ClassStudentIdentity[]
): Promise<void> => {
  const studentsRef = collection(db, 'users', uid, 'classes', classId, 'students');
  const existingSnapshot = await getDocs(studentsRef);
  recordRead('studentIdentities:replace-diff', existingSnapshot.size);
  const existingIds = new Set(existingSnapshot.docs.map((studentDoc) => studentDoc.id));
  const nextIds = new Set(identities.map((identity) => identity.graphId));
  const batch = writeBatch(db);

  identities.forEach((identity) => {
    batch.set(
      doc(db, 'users', uid, 'classes', classId, 'students', identity.graphId),
      serializeClassStudentIdentity(identity),
      { merge: true }
    );
  });

  existingSnapshot.docs.forEach((studentDoc) => {
    if (!nextIds.has(studentDoc.id)) {
      batch.delete(studentDoc.ref);
    }
  });

  if (identities.length === 0 && existingIds.size === 0) return;
  await batch.commit();
};

export const listEntriesForClasses = async (
  db: Firestore,
  uid: string,
  classIds: string[]
): Promise<StoredDiaryEntry[]> => {
  const uniqueClassIds = Array.from(new Set(classIds)).filter(Boolean);
  if (uniqueClassIds.length === 0) return [];

  const snapshots = await Promise.all(
    uniqueClassIds.map((classId) =>
      getDocs(query(collection(db, 'users', uid, 'entries'), where('classId', '==', classId)))
    )
  );
  recordRead('entries:classes', snapshots.reduce((n, s) => n + s.size, 0));

  const hydrated = snapshots.flatMap((snapshot) =>
    snapshot.docs.map((entryDoc) => hydrateStoredEntry(entryDoc.data() as StoredEntryWire))
  );

  return collapseHydratedPageEntries(hydrated)
    .map((entry) => entry.storedEntry)
    .sort((a, b) => {
      if (a.classId !== b.classId) return a.classId.localeCompare(b.classId);
      if (a.studentName !== b.studentName) return a.studentName.localeCompare(b.studentName);
      return a.entryId.localeCompare(b.entryId);
    });
};

export const loadClassMetadataMap = async (
  db: Firestore,
  uid: string,
  classIds: string[]
): Promise<Record<string, Partial<EducationClass>>> => {
  const metadata: Record<string, Partial<EducationClass>> = {};

  // allSettled (not all): a single failed per-class read — e.g. during a Firestore
  // read-quota outage — must not discard metadata for the classes that did load.
  // Callers fall back to in-memory/default settings only for the classes left absent.
  await Promise.allSettled(
    classIds.filter(Boolean).map(async (classId) => {
      const classSnap = await getDoc(doc(db, 'users', uid, 'classes', classId));
      recordRead('classMetadata:get', 1);
      if (classSnap.exists()) {
        metadata[classId] = classSnap.data() as Partial<EducationClass>;
      }
    })
  );

  return metadata;
};

export const saveClassMetadata = async (
  db: Firestore,
  uid: string,
  cls: EducationClass
): Promise<void> => {
  const normalized = withClassDefaults(cls);
  await setDoc(
    doc(db, 'users', uid, 'classes', normalized.id),
    {
      classId: normalized.id,
      displayName: normalized.displayName,
      description: normalized.description || '',
      parserMode: normalized.parserMode,
      templateVersion: normalized.templateVersion,
      ...(normalized.lastSynced ? { lastSynced: normalized.lastSynced } : {}),
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
};

export const saveClassLastSynced = async (
  db: Firestore,
  uid: string,
  cls: EducationClass,
  lastSynced: string
): Promise<void> => {
  await saveClassMetadata(db, uid, { ...cls, lastSynced });
};

// Preferences document lives at users/{uid}/preferences/global — a single
// document in a dedicated subcollection so it doesn't pollute the user root.
const preferencesRef = (db: Firestore, uid: string) =>
  doc(db, 'users', uid, 'preferences', 'global');

const VALID_GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash'];

export const loadUserPreferences = async (
  db: Firestore,
  uid: string
): Promise<UserPreferences> => {
  const snap = await getDoc(preferencesRef(db, uid));
  recordRead('preferences:get', 1);
  if (!snap.exists()) return {};
  const data = snap.data();

  const prefs: UserPreferences = {
    ffItemCount: ['1-2', '3-4', '5+'].includes(data.ffItemCount) ? data.ffItemCount : undefined,
    priorFeedbackMode: ['off', 'reference', 'include'].includes(data.priorFeedbackMode) ? data.priorFeedbackMode : undefined,
    feedbackTone: typeof data.feedbackTone === 'string' ? data.feedbackTone : undefined,
    teacherDisplayName: typeof data.teacherDisplayName === 'string' ? data.teacherDisplayName : undefined,
    customSignOff: typeof data.customSignOff === 'string' ? data.customSignOff : undefined,
    aiModelFeedback: VALID_GEMINI_MODELS.includes(data.aiModelFeedback) ? data.aiModelFeedback : undefined,
    aiModelParsing: VALID_GEMINI_MODELS.includes(data.aiModelParsing) ? data.aiModelParsing : undefined,
  };

  if (data.aiPrompts && typeof data.aiPrompts === 'object') {
    // Only include fields that are explicitly present in Firestore. Missing fields
    // are omitted (undefined) so the deep-merge in useUserPreferences falls back
    // to the current default rather than overwriting it with an empty string.
    prefs.aiPrompts = {
      diaryText: typeof data.aiPrompts.diaryText === 'string' ? data.aiPrompts.diaryText : undefined,
      peerFeedback: typeof data.aiPrompts.peerFeedback === 'string' ? data.aiPrompts.peerFeedback : undefined,
      vocab: typeof data.aiPrompts.vocab === 'string' ? data.aiPrompts.vocab : undefined,
      translations: typeof data.aiPrompts.translations === 'string' ? data.aiPrompts.translations : undefined,
      overall: typeof data.aiPrompts.overall === 'string' ? data.aiPrompts.overall : undefined,
    } as typeof prefs.aiPrompts;
  }

  return prefs;
};

export const saveUserPreferences = async (
  db: Firestore,
  uid: string,
  prefs: UserPreferences
): Promise<void> => {
  await setDoc(preferencesRef(db, uid), prefs, { merge: true });
};
