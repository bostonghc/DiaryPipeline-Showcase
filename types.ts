
export interface EducationClass {
  id: string;
  displayName: string;
  description: string;
  accessStatus?: 'accessible' | 'inaccessible' | 'defer' | 'unknown';
  lastSynced?: string;
  parserMode?: ParserMode;
  templateVersion?: TemplateVersion;
  rosterStatus?: 'saved' | 'discovered';
}

export interface Student {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName?: string;
}

export interface StudentIdentity {
  graphId: string;
  displayName: string;
  upn: string;
  mail?: string;
}

export interface ClassStudentIdentity extends StudentIdentity {
  classId: string;
  studentNumber?: string;
  updatedAt: string;
}

export type AnalysisTemplate = 'holistic' | 'emotional' | 'academic';

export interface PeerFeedback {
  contributor: string;
  feedback: string;
}

export interface VocabItem {
  wordOrPhrase: string;
}

export interface TranslationItem {
  japanese: string;
  englishDefinition: string;
  englishExample: string;
}

export interface ChatbotFeedback {
  present: boolean;
  data: string;
}

export interface ParsedDiaryEntry {
  id: string; // Unique identifier for the entry (e.g., date-week)
  date: string;
  weather: string;
  weekNumber: string;
  photoCount: number;
  diaryText: string;
  peerFeedback: PeerFeedback[];
  vocabItems: VocabItem[];
  vocabCount: number;
  sentiment?: string;
  topics?: string[];
  translations: TranslationItem[];
  translationCount: number;
  chatbotFeedback: ChatbotFeedback;
  parseWarnings?: string[];
  rawText?: string;
}

export type ParsedPageContent = ParsedDiaryEntry[];

export type ParserMode = 'ai' | 'label-first';
export type TemplateVersion = 'legacy-ai' | 'labeled-diary-v1';
export type EntryStatus = 'draft' | 'reviewed' | 'approved';
export type PageSyncState = 'idle' | 'queued' | 'syncing' | 'saved' | 'rate_limited' | 'error';

export type SyncJobStatus = 'populating' | 'running' | 'done' | 'cancelled';
export type SyncJobItemStatus = 'queued' | 'running' | 'done' | 'skipped' | 'error' | 'rate_limited';

export interface SyncJobCounts {
  total: number;
  queued: number;
  running: number;
  done: number;
  skipped: number;
  error: number;
  rate_limited: number;
}

export interface SyncJob {
  jobId: string;
  classId: string;
  classDisplayName: string;
  status: SyncJobStatus;
  counts: SyncJobCounts;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SyncJobItem {
  itemId: string;
  jobId: string;
  classId: string;
  pageId: string;
  pageTitle: string;
  studentName: string;
  diaryGroupId: string;
  diaryGroupName: string;
  studentGraphId?: string;
  studentUpn?: string;
  parserMode: ParserMode;
  templateVersion: TemplateVersion;
  oneNoteLastModified?: string;
  status: SyncJobItemStatus;
  runId?: string;
  claimedAt?: string;
  heartbeatAt?: string;
  lastError?: string;
  nextRetryAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredDiaryEntry {
  entryId: string;
  pageId: string;
  pageTitle: string;
  classId: string;
  diaryGroupId?: string;
  diaryGroupName?: string;
  studentName: string;
  studentGraphId?: string;
  studentUpn?: string;
  date: string;
  weekNumber: string;
  weather: string;
  diaryText: string;
  diaryTextCorrected: string;
  teacherFeedback: TeacherFeedbackFields;
  peerFeedback: PeerFeedback[];
  translations: TranslationItem[];
  vocabCount: number;
  sentiment: string;
  topics: string[];
  vocabItems: VocabItem[];
  photoCount: number;
  translationCount: number;
  chatbotFeedback: ChatbotFeedback;
  parseWarnings?: string[];
  rawText?: string;
  status: EntryStatus;
  parserMode: ParserMode;
  templateVersion: TemplateVersion;
  oneNoteLastModified?: string;
  approvedAt?: string;
  updatedAt: string;
}

export interface HydratedPageEntry {
  parsedEntry: ParsedDiaryEntry;
  storedEntry: StoredDiaryEntry;
}

export interface PageSyncRecord {
  pageId: string;
  classId: string;
  pageTitle: string;
  studentName: string;
  diaryGroupId?: string;
  diaryGroupName?: string;
  studentGraphId?: string;
  studentUpn?: string;
  parserMode: ParserMode;
  templateVersion: TemplateVersion;
  syncState: PageSyncState;
  entryCount: number;
  oneNoteLastModified?: string;
  lastParsedAt?: string;
  lastViewedAt?: string;
  lastError?: string;
  nextRetryAt?: string;
  updatedAt: string;
}

export type FeedbackChannel = 'teams' | 'email';
export type FeedbackSource = 'human' | 'ai_drafted' | 'ai_drafted_human_edited' | 'hybrid';
export type FeedbackReviewDecisionType = 'reviewed_no_feedback';

/** How the recipient email/UPN was determined before sending. */
export type EmailResolutionSource =
  | 'roster'         // Matched from cached class roster (Strategy A/B)
  | 'graph_search'   // Resolved via live Graph directory search (Strategy D/E)
  | 'manual';        // Teacher typed or edited the address manually

export interface EmailResolutionResult {
  email: string;
  source: Exclude<EmailResolutionSource, 'manual'>;
}

// Session control types — defined here (not in FeedbackWorkspace) so they can
// be referenced by UserPreferences without a circular import.
export type FFItemCount = '1-2' | '3-4' | '5+';
export type PriorFeedbackMode = 'off' | 'reference' | 'include';

/**
 * Teacher-level defaults persisted to Firestore at users/{uid}/preferences/global.
 * Global across all classes and machines. Session controls initialise from these
 * and can be overridden per-entry; "Save as default" promotes a session value back here.
 *
 * Pedagogical fields (feedbackTone, customSignOff, aiModel*, aiPrompts) live here
 * so they travel with the teacher's profile across devices. Machine-local operational
 * settings (filterStrings, sync cadence) stay in localStorage via UserConfig.
 */
export interface UserPreferences {
  // Session control defaults (Slice 7a)
  ffItemCount?: FFItemCount;
  priorFeedbackMode?: PriorFeedbackMode;

  // Pedagogical preferences (Slice 7b)
  feedbackTone?: string;
  teacherDisplayName?: string;
  customSignOff?: string;
  aiModelFeedback?: GeminiModel;
  aiModelParsing?: GeminiModel;
  aiPrompts?: {
    diaryText: string;
    peerFeedback: string;
    vocab: string;
    translations: string;
    overall: string;
  };

  // Export presets (custom entries; built-in presets are code constants)
  exportPresets?: ExportPreset[];
}

/**
 * The per-entry editable store: `Record<entryId, TeacherFeedbackFields>`.
 *
 * Typed so the renderer/compiler cannot read a key the UI never writes — the
 * stringly-typed `Record<string, string>` predecessor let `vocab` (written by
 * the UI) and `vocabItems` (read by the compiler) silently diverge.
 *
 * Known debt: this map can still hydrate legacy metadata comments
 * (`date`/`weather`/`weekNumber`/`photos`) even though the current UI renders
 * those parsed values as read-only Entry Details. Splitting any remaining
 * metadata-edit state out of this feedback map is deferred.
 */
export interface TeacherFeedbackFields {
  // Teacher feedback text (keys the compiler reads)
  diaryText?: string;
  peerFeedback?: string;
  vocab?: string;
  translations?: string;
  chatbot?: string;
  overall?: string;
  // Legacy metadata comments (not rendered as student-facing feedback fields)
  date?: string;
  weather?: string;
  weekNumber?: string;
  photos?: string;
}

/**
 * The composed feedback object produced by `compileStructuredFeedback` and
 * mutated in the Review & Send modal. Stored on `FeedbackHistoryRecord` so
 * future surfaces (sidebar previews, dashboards, format-version migrations)
 * can re-render from structured data rather than scrape rendered HTML.
 * See ARCHITECTURE.md §35.
 */
export interface StructuredFeedback {
  greeting: string;
  diaryFeedback: string;
  includeDiary: boolean;
  vocabFeedback: string;
  includeVocab: boolean;
  overallFeedback: string;
  includeOverall: boolean;
  // Teacher feedback on the student's peer comments, translations, and chatbot
  // exchange. Wired into the sent message in formatVersion 3. Optional so legacy
  // v2 records (which lack them) read back with the sections omitted.
  peerFeedback?: string;
  includePeer?: boolean;
  translationsFeedback?: string;
  includeTranslations?: boolean;
  chatbotFeedback?: string;
  includeChatbot?: boolean;
  closing: string;
  reviewNotice: string;
  studentEmail?: string;
  // Set when Prior Feedback mode is 'include': a short excerpt from the most
  // recent past record appended to the email so the student sees continuity.
  priorExcerpt?: string;
}

/**
 * Minimal snapshot of the student-text fields that the feedback format pairs
 * comments against. Captured at send time so historical records preserve
 * what the student had written when the feedback was issued, immune to
 * later edits or re-parses.
 */
export interface FeedbackEntrySnapshot {
  diaryText: string;
  vocabItems: VocabItem[];
  // Source content for the formatVersion-3 sections, captured at send time so
  // persisted records re-render identically. Optional: legacy snapshots lack them.
  peerFeedback?: PeerFeedback[];
  translations?: TranslationItem[];
  chatbotFeedback?: ChatbotFeedback;
}

export interface FeedbackHistoryRecord {
  feedbackId: string;
  classId: string;
  pageId: string;
  entryId: string;
  studentUpn: string;
  studentName: string;
  studentGraphId?: string;
  channel: FeedbackChannel;
  sentAt: string;
  batchId?: string;
  source: FeedbackSource;
  fieldsAddressed: string[];
  content: string;
  updatedAt: string;
  // Schema versioning: every record carries an explicit format version so
  // future schema changes can be handled with read-time adapters rather
  // than migration scripts. Legacy records default to 1 on read.
  formatVersion: number;
  // Source-of-truth structured data; optional on records written before
  // Slice 6 — legacy records will only have `content` (rendered HTML).
  structuredFeedback?: StructuredFeedback;
  entrySnapshot?: FeedbackEntrySnapshot;
  // Teacher-marked uptake signal. Set when the teacher observes that the
  // student acted on this feedback in a subsequent entry. null = not observed.
  uptakeObservedAt?: string | null;
  // Analytics-event metadata: the session settings in force when this feedback
  // was composed. Discrete fields so dashboards aggregate without parsing prose.
  itemCountSetting?: FFItemCount;
  priorFeedbackMode?: PriorFeedbackMode;
  // How the recipient address was determined. Optional for backwards-compat with
  // records written before this field was introduced.
  recipientResolutionSource?: EmailResolutionSource;
}

export interface FeedbackReviewDecisionRecord {
  decisionId: string;
  batchId?: string;
  classId: string;
  pageId: string;
  entryId: string;
  studentUpn: string;
  studentName: string;
  studentGraphId?: string;
  decision: FeedbackReviewDecisionType;
  decidedAt: string;
  updatedAt: string;
}

export interface JournalEntry {
  studentId: string;
  studentName: string;
  pageId: string;
  pageTitle: string;
  date: string;
  cells: string[]; // Always 9 cells
  analysis?: string;
  templateUsed?: AnalysisTemplate;
}

export interface NotebookNode {
  id: string;
  displayName: string;
  type: 'sectionGroup' | 'section' | 'page';
  children?: NotebookNode[];
  contentUrl?: string;
  lastModified?: string;
}

export enum ExportFormat {
  CSV = 'CSV',
  XLSX = 'XLSX',
  JSON = 'JSON'
}

export type ExportFieldGroup =
  | 'identity'   // student name, UPN, class, section
  | 'dates'      // date, week number
  | 'status'     // workflow status, approvedAt, updatedAt
  | 'counts'     // vocab, photo, translation, peer feedback counts
  | 'content'    // diary text, peer text, translations, vocab items, chatbot
  | 'feedback'   // teacher feedback fields expanded as individual columns
  | 'metadata';  // parser mode, template version, IDs, parse warnings

export interface ExportPreset {
  id: string;
  name: string;
  description: string;
  fieldGroups: ExportFieldGroup[];
  statusFilter: EntryStatus[] | 'all';
  format: ExportFormat;
  isBuiltIn: boolean;
}

export interface AppConfig {
  clientId: string;
  tenantId: string;
  isSandbox: boolean;
}

export type GeminiModel =
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite'
  | 'gemini-3-flash';

export interface UserConfig {
  filterStrings: string[];
  aiModelParsing: GeminiModel;
  aiModelFeedback: GeminiModel;
  feedbackTone: string;
  teacherDisplayName: string;
  customSignOff?: string;
  syncFrequency: 'manual' | 'daily' | 'weekly';
  syncBatchSize: number;
  syncDelayBetweenBatches: number; // in ms
}

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}
