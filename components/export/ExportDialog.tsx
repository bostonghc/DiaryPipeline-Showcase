import React, { useEffect, useMemo, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import {
  AlertTriangle,
  BookmarkPlus,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import { GraphService } from '../../services/graphService';
import { listEntriesForClasses, listPageSyncRecordsForClasses } from '../../services/firestoreDataService';
import { parseDiaryHTML } from '../../services/geminiService';
import { extractLabeledDiaryProgressVocabCounts, parseLabeledDiaryHTML } from '../../services/parserService';
import { exportCoverage, exportDataWithPreset, exportProgressRows } from '../../services/exportService';
import {
  DEFAULT_PROGRESS_RUBRIC,
  buildProgressExport,
  collectLoadedProgressPages,
  extractStudentNumber,
  progressCacheKey,
  scoreProgressPage,
  type ProgressVocabScoreOverride,
  type ProgressPageScore,
  type ProgressPageSource,
} from '../../services/progressReportService';
import { useExportPresets } from '../../hooks/useExportPresets';
import { useCollaborationAccess } from '../../hooks/useCollaborationAccess';
import type {
  EducationClass,
  ExportFormat,
  ExportPreset,
  GeminiModel,
  NotebookNode,
  PageSyncRecord,
  ParsedPageContent,
  ParserMode,
  StudentIdentity,
  StoredDiaryEntry,
  TemplateVersion,
} from '../../types';

interface ExportDialogProps {
  db: Firestore;
  uid: string;
  classes: EducationClass[];
  initialClassIds: string[];
  accessToken?: string | null;
  notebookTree: NotebookNode[];
  parsedCache: Record<string, ParsedPageContent>;
  contentCache: Record<string, string>;
  pageCacheMeta: Record<string, { lastModified?: string }>;
  aiModelParsing: GeminiModel;
  getClassParserConfig: (classId: string) => { parserMode: ParserMode; templateVersion: TemplateVersion };
  onProgressPageParsed: (
    pageId: string,
    parsed: ParsedPageContent,
    content: string,
    lastModified?: string,
  ) => void;
  onClose: () => void;
}

const PROGRESS_ID = 'progress';
// Coverage is a page-record export, not an entry preset, so it lives in the
// Export Type list under a sentinel id and is special-cased throughout.
const COVERAGE_ID = 'coverage';

const deriveStudentKey = (
  record: { studentUpn?: string; studentGraphId?: string; studentName?: string },
): string => {
  const upnLocal = record.studentUpn?.split('@')[0]?.trim().toLowerCase();
  return upnLocal || record.studentGraphId || record.studentName || 'unknown';
};

const normalizeComparableName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

const progressRosterCacheKey = (classId: string): string =>
  `progress_roster_${classId}_v1`;

export const ExportDialog: React.FC<ExportDialogProps> = ({
  db,
  uid,
  classes,
  initialClassIds,
  accessToken,
  notebookTree,
  parsedCache,
  contentCache,
  pageCacheMeta,
  aiModelParsing,
  getClassParserConfig,
  onProgressPageParsed,
  onClose,
}) => {
  const { profile: accessProfile } = useCollaborationAccess();
  // Progress is intentionally the default so opening the dialog for this
  // student-facing report does not immediately read saved Firestore entries.
  const [activePresetId, setActivePresetId] = useState<string>(PROGRESS_ID);
  const isProgress = activePresetId === PROGRESS_ID;
  const { allPresets, isLoading: presetsLoading, saveCustomPreset, deleteCustomPreset } =
    useExportPresets(db, uid, !isProgress);

  // Stable key for data fetch
  const classIdsKey = useMemo(
    () => JSON.stringify([...initialClassIds].sort()),
    [initialClassIds],
  );

  const [entries, setEntries] = useState<StoredDiaryEntry[]>([]);
  const [pageRecords, setPageRecords] = useState<PageSyncRecord[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    if (isProgress) {
      setDataLoading(false);
      setDataError(null);
      return;
    }

    const ids = JSON.parse(classIdsKey) as string[];
    let cancelled = false;
    setDataLoading(true);
    setDataError(null);
    Promise.all([
      listEntriesForClasses(db, uid, ids),
      listPageSyncRecordsForClasses(db, uid, ids),
    ])
      .then(([e, p]) => { if (!cancelled) { setEntries(e); setPageRecords(p); } })
      .catch((err: unknown) => {
        if (!cancelled) setDataError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setDataLoading(false); });
    return () => { cancelled = true; };
  }, [db, uid, classIdsKey, isProgress]);

  // Scope selections
  const [selectedClassIds, setSelectedClassIds] = useState<Set<string>>(
    () => new Set(initialClassIds),
  );
  const [filterStudents, setFilterStudents] = useState(false);
  const [selectedStudentKeys, setSelectedStudentKeys] = useState<Set<string>>(new Set());

  const availableClasses = useMemo(
    () => initialClassIds.map((id) => classes.find((c) => c.id === id)).filter(Boolean) as EducationClass[],
    [classes, initialClassIds],
  );

  const scopedEntries = useMemo(
    () => entries.filter((e) => selectedClassIds.has(e.classId)),
    [entries, selectedClassIds],
  );

  const scopedPageRecords = useMemo(
    () => pageRecords.filter((p) => selectedClassIds.has(p.classId)),
    [pageRecords, selectedClassIds],
  );

  const loadedProgressPages = useMemo(
    () => collectLoadedProgressPages(notebookTree, selectedClassIds),
    [notebookTree, selectedClassIds],
  );

  const scopedProgressPages = useMemo(
    () =>
      filterStudents
        ? loadedProgressPages.filter((p) => selectedStudentKeys.has(deriveStudentKey(p)))
        : loadedProgressPages,
    [loadedProgressPages, filterStudents, selectedStudentKeys],
  );

  // Student filter list spans entries, page records, and loaded OneNote pages.
  const uniqueStudents = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of scopedEntries) {
      const key = deriveStudentKey(entry);
      if (!map.has(key)) map.set(key, entry.studentName);
    }
    for (const record of scopedPageRecords) {
      const key = deriveStudentKey(record);
      if (!map.has(key)) map.set(key, record.studentName || key);
    }
    for (const page of loadedProgressPages) {
      const key = deriveStudentKey(page);
      if (!map.has(key)) map.set(key, page.studentName || key);
    }
    return Array.from(map.entries())
      .sort(([, a], [, b]) => a.localeCompare(b))
      .map(([key, name]) => ({ key, name }));
  }, [scopedEntries, scopedPageRecords, loadedProgressPages]);

  // Preset & format
  const activePreset = useMemo(
    () => allPresets.find((p) => p.id === activePresetId) ?? allPresets[0],
    [allPresets, activePresetId],
  );
  const isCoverage = activePresetId === COVERAGE_ID;
  const [formatOverride, setFormatOverride] = useState<ExportFormat | null>(null);

  // Save-preset UI
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [savePresetName, setSavePresetName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Export
  const [isExporting, setIsExporting] = useState(false);
  const [progressExportStatus, setProgressExportStatus] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const hasMixedTemplates = useMemo(() => {
    const templates = new Set(
      availableClasses
        .filter((c) => selectedClassIds.has(c.id))
        .map((c) => c.templateVersion)
        .filter(Boolean),
    );
    return templates.size > 1;
  }, [availableClasses, selectedClassIds]);

  const effectiveFormat = formatOverride ?? (isCoverage || isProgress ? ('XLSX' as ExportFormat) : activePreset.format);
  const effectiveStudentFilter = filterStudents ? selectedStudentKeys : null;

  const previewCount = useMemo(() => {
    if (isProgress) return scopedProgressPages.length;
    if (isCoverage) {
      if (!filterStudents) return scopedPageRecords.length;
      return scopedPageRecords.filter((p) => selectedStudentKeys.has(deriveStudentKey(p))).length;
    }
    const statusFiltered =
      activePreset.statusFilter === 'all'
        ? scopedEntries
        : scopedEntries.filter((e) =>
            (activePreset.statusFilter as string[]).includes(e.status),
          );
    if (!filterStudents) return statusFiltered.length;
    return statusFiltered.filter((e) => selectedStudentKeys.has(deriveStudentKey(e))).length;
  }, [isProgress, scopedProgressPages.length, isCoverage, activePreset, scopedEntries, scopedPageRecords, filterStudents, selectedStudentKeys]);

  const readCachedProgressScore = (
    page: ProgressPageSource,
    parserMode: ParserMode,
    templateVersion: TemplateVersion,
  ): ProgressPageScore | null => {
    try {
      const raw = localStorage.getItem(progressCacheKey(page, parserMode, templateVersion));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ProgressPageScore;
      return parsed?.pageId === page.pageId && typeof parsed.entriesFound === 'number'
        ? { ...parsed, source: 'cache' }
        : null;
    } catch {
      return null;
    }
  };

  const writeCachedProgressScore = (
    page: ProgressPageSource,
    parserMode: ParserMode,
    templateVersion: TemplateVersion,
    score: ProgressPageScore,
  ) => {
    try {
      localStorage.setItem(progressCacheKey(page, parserMode, templateVersion), JSON.stringify(score));
    } catch { /* local cache only; export can continue */ }
  };

  const readCachedRoster = (classId: string): StudentIdentity[] | null => {
    try {
      const raw = localStorage.getItem(progressRosterCacheKey(classId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { savedAt: number; identities: StudentIdentity[] };
      if (!parsed.savedAt || Date.now() - parsed.savedAt > 7 * 24 * 60 * 60 * 1000) return null;
      return Array.isArray(parsed.identities) ? parsed.identities : null;
    } catch {
      return null;
    }
  };

  const writeCachedRoster = (classId: string, identities: StudentIdentity[]) => {
    try {
      localStorage.setItem(
        progressRosterCacheKey(classId),
        JSON.stringify({ savedAt: Date.now(), identities }),
      );
    } catch { /* local cache only; export can continue */ }
  };

  const loadProgressRoster = async (
    classId: string,
    graph: GraphService | null,
  ): Promise<StudentIdentity[]> => {
    if (!classId || classId.startsWith('nb_')) return [];
    const cached = readCachedRoster(classId);
    if (cached) return cached;
    if (!accessToken) return [];
    try {
      const graphClient = graph || new GraphService(accessToken || undefined, true);
      const identities = await graphClient.listClassStudentIdentities(classId);
      writeCachedRoster(classId, identities);
      return identities;
    } catch {
      return [];
    }
  };

  const matchProgressIdentity = (
    page: ProgressPageSource,
    identities: StudentIdentity[],
  ): StudentIdentity | null => {
    if (identities.length === 0) return null;
    const studentNumber = page.studentNumber || extractStudentNumber(`${page.pageTitle} ${page.studentName}`);
    if (studentNumber) {
      const numberMatch = identities.find((identity) =>
        identity.upn.toLowerCase().includes(studentNumber) ||
        (identity.mail || '').toLowerCase().includes(studentNumber)
      );
      if (numberMatch) return numberMatch;
    }

    const comparableName = normalizeComparableName(page.studentName);
    if (!comparableName) return null;
    return identities.find((identity) => {
      const rosterName = normalizeComparableName(identity.displayName);
      return rosterName === comparableName || rosterName.includes(comparableName) || comparableName.includes(rosterName);
    }) || null;
  };

  const pageCacheMatches = (page: ProgressPageSource): boolean => {
    const cached = pageCacheMeta[page.pageId];
    return (
      (!page.oneNoteLastModified && !cached?.lastModified) ||
      (Boolean(page.oneNoteLastModified) && cached?.lastModified === page.oneNoteLastModified)
    );
  };

  const buildZeroProgressScore = (
    page: ProgressPageSource,
    parserMode: ParserMode,
    templateVersion: TemplateVersion,
    message: string,
  ): ProgressPageScore => ({
    ...page,
    scanStatus: 'scan_failed',
    parserMode,
    templateVersion,
    entriesFound: 0,
    metadataComplete: 0,
    photosFound: 0,
    diaryValidEntries: 0,
    vocabJapaneseComplete: 0,
    vocabEnglishOrExampleComplete: 0,
    aiFeedbackBoosterCount: 0,
    parseWarnings: [message],
    source: 'fresh',
  });

  const describeProgressError = (err: unknown): string => {
    if (err instanceof Error && err.message.trim()) return err.message;
    if (err && typeof err === 'object') {
      const data = err as {
        name?: string;
        code?: string;
        statusCode?: number;
        status?: number;
        message?: string;
      };
      const parts = [
        data.name,
        data.code,
        data.statusCode ? `status ${data.statusCode}` : '',
        data.status ? `status ${data.status}` : '',
        data.message,
      ].filter((part): part is string => Boolean(String(part || '').trim()));
      if (parts.length > 0) return parts.join(' ');
      try {
        const serialized = JSON.stringify(err);
        if (serialized && serialized !== '{}') return serialized;
      } catch { /* fall through */ }
    }
    return String(err || 'Unknown progress scan error');
  };

  const progressVocabOverrideFromContent = (
    content: string,
  ): ProgressVocabScoreOverride | undefined => {
    const counts = extractLabeledDiaryProgressVocabCounts(content);
    if (counts.length === 0) return undefined;
    return {
      japaneseComplete: counts.reduce((sum, count) => sum + count.japaneseComplete, 0),
      englishOrExampleComplete: counts.reduce((sum, count) => sum + count.englishOrExampleComplete, 0),
    };
  };

  const runProgressExport = async (scopeLabel: string): Promise<void> => {
    if (scopedProgressPages.length === 0) {
      throw new Error('No loaded OneNote pages found for the selected classes. Load notebooks and expand the diary sections you want included, then try Progress again.');
    }

    let graph: GraphService | null = null;
    const scores: ProgressPageScore[] = [];
    const rosterByClass = new Map<string, StudentIdentity[]>();

    for (let i = 0; i < scopedProgressPages.length; i++) {
      let page = scopedProgressPages[i];
      const { parserMode, templateVersion } = getClassParserConfig(page.classId);
      setProgressExportStatus(`Scoring ${i + 1}/${scopedProgressPages.length}: ${page.studentName}`);

      if (!rosterByClass.has(page.classId)) {
        if (!graph && accessToken) graph = new GraphService(accessToken || undefined, true);
        rosterByClass.set(page.classId, await loadProgressRoster(page.classId, graph));
      }
      const identity = matchProgressIdentity(page, rosterByClass.get(page.classId) || []);
      if (identity) {
        page = {
          ...page,
          studentName: identity.displayName || page.studentName,
          studentUpn: identity.upn,
        };
      }

      const cached = readCachedProgressScore(page, parserMode, templateVersion);
      if (cached) {
        scores.push(cached);
        continue;
      }

      if (parsedCache[page.pageId] && pageCacheMatches(page)) {
        const cachedContent = contentCache[page.pageId] && pageCacheMatches(page)
          ? contentCache[page.pageId]
          : null;
        const score = scoreProgressPage(
          page,
          parsedCache[page.pageId],
          parserMode,
          templateVersion,
          'memory',
          DEFAULT_PROGRESS_RUBRIC,
          cachedContent ? progressVocabOverrideFromContent(cachedContent) : undefined,
        );
        writeCachedProgressScore(page, parserMode, templateVersion, score);
        scores.push(score);
        continue;
      }

      try {
        const cachedContent = contentCache[page.pageId] && pageCacheMatches(page)
          ? contentCache[page.pageId]
          : null;
        if (!cachedContent && !accessToken) {
          throw new Error('Connect Microsoft before fetching uncached OneNote pages.');
        }
        if (!cachedContent && !graph) {
          graph = new GraphService(accessToken || undefined, true);
        }

        const content = cachedContent || await graph!.getPageContent(page.classId, page.pageId);
        const parsed =
          parserMode === 'label-first'
            ? parseLabeledDiaryHTML(content, templateVersion) || []
            : await parseDiaryHTML(content, aiModelParsing, undefined, templateVersion);
        const score = scoreProgressPage(
          page,
          parsed,
          parserMode,
          templateVersion,
          'fresh',
          DEFAULT_PROGRESS_RUBRIC,
          progressVocabOverrideFromContent(content),
        );
        writeCachedProgressScore(page, parserMode, templateVersion, score);
        onProgressPageParsed(page.pageId, parsed, content, page.oneNoteLastModified);
        scores.push(score);
      } catch (err: unknown) {
        const message = describeProgressError(err);
        scores.push(buildZeroProgressScore(page, parserMode, templateVersion, `Progress parse failed: ${message}`));
      }
    }

    const report = buildProgressExport(scores, DEFAULT_PROGRESS_RUBRIC);
    exportProgressRows(report.rows, { format: effectiveFormat, scopeLabel });
    setProgressExportStatus(
      `Progress export ready: ${report.stats.students} students, ${report.stats.pages} pages scored (${report.stats.cachedPages + report.stats.memoryPages} cached, ${report.stats.fetchedPages} fetched).`,
    );
  };

  const handleExport = async () => {
    setIsExporting(true);
    setProgressExportStatus(null);
    setExportError(null);
    try {
      const scopeLabel = availableClasses
        .filter((c) => selectedClassIds.has(c.id))
        .map((c) => c.displayName)
        .join('-');
      if (isProgress) {
        await runProgressExport(scopeLabel);
      } else if (isCoverage) {
        const classNameById = Object.fromEntries(
          availableClasses.map((c) => [c.id, c.displayName] as const),
        );
        const records = effectiveStudentFilter
          ? scopedPageRecords.filter((p) => effectiveStudentFilter.has(deriveStudentKey(p)))
          : scopedPageRecords;
        exportCoverage(records, scopedEntries, { format: effectiveFormat, classNameById, scopeLabel });
      } else {
        const preset: ExportPreset = { ...activePreset, format: effectiveFormat };
        exportDataWithPreset(scopedEntries, preset, effectiveStudentFilter, { scopeLabel });
      }
      onClose();
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  };

  const handleSavePreset = async () => {
    if (!savePresetName.trim()) return;
    setIsSaving(true);
    try {
      const saved = await saveCustomPreset(savePresetName.trim(), {
        ...activePreset,
        format: effectiveFormat,
      });
      setActivePresetId(saved.id);
      setShowSaveForm(false);
      setSavePresetName('');
    } finally {
      setIsSaving(false);
    }
  };

  const loading = dataLoading || presetsLoading;

  if (!accessProfile?.capabilities.canExport) return null;

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-2xl max-h-[90vh] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-slate-50 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
              <Download size={18} />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                Export Records
              </p>
              <h2 className="text-lg font-black tracking-tight text-slate-900">
                Configure and download
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
            aria-label="Close export dialog"
          >
            <X size={20} />
          </button>
        </header>

        {loading ? (
          <div className="flex items-center justify-center px-6 py-16">
            <div className="flex items-center gap-3 text-sm font-bold text-slate-500">
              <Loader2 size={18} className="animate-spin text-indigo-500" />
              Loading export data…
            </div>
          </div>
        ) : dataError ? (
          <div className="px-6 py-8 text-sm font-semibold text-red-700">
            Could not load entries: {dataError}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
            {/* Classes */}
            <Section label="Classes">
              <div className="space-y-2">
                {availableClasses.map((cls) => (
                  <label key={cls.id} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                      checked={selectedClassIds.has(cls.id)}
                      onChange={(e) => {
                        const next = new Set(selectedClassIds);
                        e.target.checked ? next.add(cls.id) : next.delete(cls.id);
                        setSelectedClassIds(next);
                      }}
                    />
                    <span className="text-sm font-medium text-slate-700">{cls.displayName}</span>
                    {cls.lastSynced && (
                      <span className="text-[10px] font-black uppercase tracking-wider text-emerald-600">
                        Sync recorded
                      </span>
                    )}
                  </label>
                ))}
              </div>
              {hasMixedTemplates && (
                <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
                  <p className="text-xs font-medium text-amber-800">
                    Selected classes use different template versions. Parser mode and template version columns are included in Research exports so you can filter after download.
                  </p>
                </div>
              )}
            </Section>

            {/* Students */}
            <Section label="Students">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                  checked={filterStudents}
                  onChange={(e) => setFilterStudents(e.target.checked)}
                />
                <span className="text-sm font-medium text-slate-700">
                  Filter to specific students
                </span>
              </label>
              {filterStudents && (
                <div className="mt-3 max-h-40 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-1.5">
                  {uniqueStudents.length === 0 ? (
                    <p className="text-xs font-medium text-slate-400">No students found for selected classes.</p>
                  ) : (
                    uniqueStudents.map(({ key, name }) => (
                      <label key={key} className="flex items-center gap-2.5 cursor-pointer">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600"
                          checked={selectedStudentKeys.has(key)}
                          onChange={(e) => {
                            const next = new Set(selectedStudentKeys);
                            e.target.checked ? next.add(key) : next.delete(key);
                            setSelectedStudentKeys(next);
                          }}
                        />
                        <span className="text-xs font-medium text-slate-700">{name}</span>
                      </label>
                    ))
                  )}
                </div>
              )}
            </Section>

            {/* Export preset */}
            <Section label="Export type">
              <div className="space-y-2">
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                    isProgress
                      ? 'border-indigo-200 bg-indigo-50/60'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="preset"
                    className="mt-0.5 h-4 w-4 border-slate-300 text-indigo-600"
                    checked={isProgress}
                    onChange={() => {
                      setActivePresetId(PROGRESS_ID);
                      setShowSaveForm(false);
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-bold text-slate-900">Progress</span>
                    <p className="mt-0.5 text-xs font-medium leading-relaxed text-slate-500">
                      Student completion from currently loaded OneNote pages: 13-entry target, metadata, photos, diary word floor, vocab Japanese, vocab English/example, and AI feedback booster. One row per student.
                    </p>
                  </div>
                </label>
                {allPresets.map((preset) => (
                  <label
                    key={preset.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                      activePresetId === preset.id
                        ? 'border-indigo-200 bg-indigo-50/60'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="preset"
                      className="mt-0.5 h-4 w-4 border-slate-300 text-indigo-600"
                      checked={activePresetId === preset.id}
                      onChange={() => setActivePresetId(preset.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-slate-900">{preset.name}</span>
                        {!preset.isBuiltIn && (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              deleteCustomPreset(preset.id);
                              if (activePresetId === preset.id) setActivePresetId('grading');
                            }}
                            className="ml-auto text-slate-400 hover:text-red-500 transition-colors"
                            title="Delete custom preset"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs font-medium leading-relaxed text-slate-500">
                        {preset.description}
                      </p>
                    </div>
                  </label>
                ))}
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                    isCoverage
                      ? 'border-indigo-200 bg-indigo-50/60'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="preset"
                    className="mt-0.5 h-4 w-4 border-slate-300 text-indigo-600"
                    checked={isCoverage}
                    onChange={() => setActivePresetId(COVERAGE_ID)}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-bold text-slate-900">Coverage (page records)</span>
                    <p className="mt-0.5 text-xs font-medium leading-relaxed text-slate-500">
                      Page-level sync coverage for discovered pages: sync state, entry count, and whether each page produced saved entries. One row per page record. Does not include roster students with no discovered page record.
                    </p>
                  </div>
                </label>
              </div>

              {/* Save as preset (entry presets only) */}
              {!isCoverage && !isProgress && (!showSaveForm ? (
                <button
                  onClick={() => { setShowSaveForm(true); setSavePresetName(''); }}
                  className="mt-2 flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:text-indigo-800 transition-colors"
                >
                  <BookmarkPlus size={13} /> Save current config as preset
                </button>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <input
                    autoFocus
                    type="text"
                    placeholder="Preset name"
                    value={savePresetName}
                    onChange={(e) => setSavePresetName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSavePreset(); if (e.key === 'Escape') setShowSaveForm(false); }}
                    className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-800 focus:border-indigo-400 focus:outline-none"
                  />
                  <button
                    onClick={handleSavePreset}
                    disabled={isSaving || !savePresetName.trim()}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors"
                  >
                    {isSaving ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
                  </button>
                  <button
                    onClick={() => setShowSaveForm(false)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </Section>

            {/* Format */}
            <Section label="Format">
              <div className="flex gap-3">
                {(['XLSX', 'CSV'] as const).map((fmt) => (
                  <label
                    key={fmt}
                    className={`flex cursor-pointer items-center gap-2 rounded-xl border px-4 py-2.5 transition-colors ${
                      effectiveFormat === fmt
                        ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="format"
                      className="sr-only"
                      checked={effectiveFormat === fmt}
                      onChange={() => setFormatOverride(fmt as ExportFormat)}
                    />
                    {fmt === 'XLSX'
                      ? <FileSpreadsheet size={14} />
                      : <FileText size={14} />}
                    <span className="text-xs font-bold">{fmt}</span>
                  </label>
                ))}
                {formatOverride !== null && (
                  <button
                    onClick={() => setFormatOverride(null)}
                    className="text-xs font-medium text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    Reset to preset default
                  </button>
                )}
              </div>
            </Section>

            {(progressExportStatus || exportError) && (
              <div
                className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
                  exportError
                    ? 'border-red-200 bg-red-50 text-red-700'
                    : 'border-indigo-100 bg-indigo-50 text-indigo-700'
                }`}
              >
                {exportError || progressExportStatus}
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-slate-200 bg-slate-50 px-6 py-4">
          <p className="text-xs font-medium text-slate-500">
            {loading
              ? '…'
              : isProgress
                ? `${previewCount} loaded ${previewCount === 1 ? 'page' : 'pages'} will be scanned`
                : isCoverage
                ? `${previewCount} ${previewCount === 1 ? 'page record' : 'page records'} will be exported`
                : `${previewCount} ${previewCount === 1 ? 'entry' : 'entries'} will be exported`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={loading || isExporting || selectedClassIds.size === 0 || previewCount === 0}
              className="flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              {isExporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              Export {effectiveFormat}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <p className="mb-3 text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
    {children}
  </div>
);
