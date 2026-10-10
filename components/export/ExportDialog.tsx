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
import { listEntriesForClasses, listPageSyncRecordsForClasses } from '../../services/firestoreDataService';
import { exportCoverage, exportDataWithPreset } from '../../services/exportService';
import { useExportPresets } from '../../hooks/useExportPresets';
import type { EducationClass, ExportFormat, ExportPreset, PageSyncRecord, StoredDiaryEntry } from '../../types';

interface ExportDialogProps {
  db: Firestore;
  uid: string;
  classes: EducationClass[];
  initialClassIds: string[];
  onClose: () => void;
}

// Coverage is a page-record export, not an entry preset, so it lives in the
// Export Type list under a sentinel id and is special-cased throughout.
const COVERAGE_ID = 'coverage';

const deriveStudentKey = (
  record: { studentUpn?: string; studentGraphId?: string; studentName?: string },
): string => {
  const upnLocal = record.studentUpn?.split('@')[0]?.trim().toLowerCase();
  return upnLocal || record.studentGraphId || record.studentName || 'unknown';
};

export const ExportDialog: React.FC<ExportDialogProps> = ({
  db,
  uid,
  classes,
  initialClassIds,
  onClose,
}) => {
  const { allPresets, isLoading: presetsLoading, saveCustomPreset, deleteCustomPreset } =
    useExportPresets(db, uid);

  // Stable key for data fetch
  const classIdsKey = useMemo(
    () => JSON.stringify([...initialClassIds].sort()),
    [initialClassIds],
  );

  const [entries, setEntries] = useState<StoredDiaryEntry[]>([]);
  const [pageRecords, setPageRecords] = useState<PageSyncRecord[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [db, uid, classIdsKey]);

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

  // Student filter list spans both entries and page records, so it also covers
  // students who have a discovered page but no saved entries (relevant to the
  // coverage export).
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
    return Array.from(map.entries())
      .sort(([, a], [, b]) => a.localeCompare(b))
      .map(([key, name]) => ({ key, name }));
  }, [scopedEntries, scopedPageRecords]);

  // Preset & format
  const [activePresetId, setActivePresetId] = useState<string>('grading');
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

  const hasMixedTemplates = useMemo(() => {
    const templates = new Set(
      availableClasses
        .filter((c) => selectedClassIds.has(c.id))
        .map((c) => c.templateVersion)
        .filter(Boolean),
    );
    return templates.size > 1;
  }, [availableClasses, selectedClassIds]);

  const effectiveFormat = formatOverride ?? (isCoverage ? ('XLSX' as ExportFormat) : activePreset.format);
  const effectiveStudentFilter = filterStudents ? selectedStudentKeys : null;

  const previewCount = useMemo(() => {
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
  }, [isCoverage, activePreset, scopedEntries, scopedPageRecords, filterStudents, selectedStudentKeys]);

  const handleExport = () => {
    setIsExporting(true);
    try {
      const scopeLabel = availableClasses
        .filter((c) => selectedClassIds.has(c.id))
        .map((c) => c.displayName)
        .join('-');
      if (isCoverage) {
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
              Loading saved entries…
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
              {!isCoverage && (!showSaveForm ? (
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
          </div>
        )}

        {/* Footer */}
        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-slate-200 bg-slate-50 px-6 py-4">
          <p className="text-xs font-medium text-slate-500">
            {loading
              ? '…'
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
