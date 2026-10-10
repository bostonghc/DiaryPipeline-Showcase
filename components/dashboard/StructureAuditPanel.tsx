import React, { useState } from 'react';
import { AlertTriangle, FolderTree, Loader2, RefreshCw } from 'lucide-react';
import { GraphService } from '../../services/graphService';
import type {
  AuditSectionCount,
  AuditSectionGroup,
  NotebookStructureAudit,
} from '../../services/graphService';
import type { EducationClass } from '../../types';

interface StructureAuditPanelProps {
  accessToken?: string;
  classes: EducationClass[];
  selectedClassIds: string[];
}

const SectionRow: React.FC<{ section: AuditSectionCount }> = ({ section }) => {
  const dropped = section.droppedByCurrentMethod > 0;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${section.diaryLike ? 'bg-indigo-500' : 'bg-slate-300'}`}
          title={section.diaryLike ? 'name matches diary/journal/week' : 'not diary-named'}
        />
        <span className="truncate font-medium text-slate-700">{section.displayName}</span>
      </span>
      {section.error ? (
        <span className="shrink-0 font-semibold text-rose-600">error: {section.error}</span>
      ) : (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-500">
          discovers {section.currentMethodCount} / actual {section.trueCount}
          {dropped && (
            <span className="ml-1.5 font-bold text-rose-600">(drops {section.droppedByCurrentMethod})</span>
          )}
        </span>
      )}
    </div>
  );
};

const GroupBlock: React.FC<{ group: AuditSectionGroup; depth?: number }> = ({ group, depth = 0 }) => {
  return (
    <div className={depth > 0 ? 'mt-2 border-l border-slate-200 pl-3' : ''}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-slate-800">{group.displayName}</span>
        {group.isCollaborationSpace && (
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-600">
            diary source
          </span>
        )}
        {group.countsFetched ? null : (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-400">
            structure only
          </span>
        )}
      </div>
      {group.sections.length > 0 && (
        <div className="mt-1">
          {group.sections.map((s) => (
            <SectionRow key={s.id} section={s} />
          ))}
        </div>
      )}
      {group.nestedGroups.map((ng) => (
        <GroupBlock key={ng.id} group={ng} depth={depth + 1} />
      ))}
    </div>
  );
};

export const StructureAuditPanel: React.FC<StructureAuditPanelProps> = ({
  accessToken,
  classes,
  selectedClassIds,
}) => {
  const defaultClassId = selectedClassIds.find((id) => classes.some((c) => c.id === id))
    ?? classes[0]?.id
    ?? '';
  const [classId, setClassId] = useState<string>(defaultClassId);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<NotebookStructureAudit | null>(null);

  const runAudit = async () => {
    if (!classId) return;
    setRunning(true);
    setError(null);
    try {
      const graph = new GraphService(accessToken || undefined, true);
      const result = await graph.auditNotebookStructure(classId);
      setAudit(result);
    } catch (e: any) {
      setError(e?.message || 'Audit failed');
      setAudit(null);
    } finally {
      setRunning(false);
    }
  };

  return (
    <details className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <summary className="flex cursor-pointer select-none items-center gap-2 text-slate-700">
        <FolderTree size={16} className="text-slate-400" />
        <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Diagnostic</span>
        <span className="text-base font-black text-slate-900">Structure audit (live OneNote)</span>
      </summary>

      <p className="mt-3 max-w-4xl text-sm font-medium leading-relaxed text-slate-500">
        Reads the class notebook structure straight from Graph (read-only, no sync). For each section inside
        the Collaboration Space it shows what diary discovery currently finds versus how many pages actually
        exist — so a sparse class is distinguishable from one whose pages are being truncated.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <select
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700"
        >
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={runAudit}
          disabled={running || !classId || !accessToken}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {running ? 'Auditing…' : 'Run audit'}
        </button>
        {!accessToken && (
          <span className="text-xs font-medium text-amber-600">Sign in to Graph to run this.</span>
        )}
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {audit && (
        <div className="mt-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Diary sections" value={String(audit.totals.collabSpaceSections)} detail={`${audit.totals.diaryLikeSections} diary-named`} />
            <Stat label="Pages discovered" value={String(audit.totals.collabPagesCurrentMethod)} detail="current method" />
            <Stat label="Pages actual" value={String(audit.totals.collabPagesTrue)} detail="full paged count" />
            <Stat
              label="Pages dropped"
              value={String(audit.totals.collabPagesDropped)}
              detail="truncated by current code"
              emphasis={audit.totals.collabPagesDropped > 0}
            />
          </div>

          {audit.warnings.length > 0 && (
            <ul className="mt-3 space-y-1">
              {audit.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-xs font-medium text-amber-700">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  {w}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 space-y-3 rounded-xl border border-slate-100 bg-slate-50/50 p-4">
            {audit.topLevelGroups.map((g) => (
              <GroupBlock key={g.id} group={g} />
            ))}
          </div>

          <p className="mt-2 text-[11px] font-medium text-slate-400">
            Generated {new Date(audit.generatedAt).toLocaleString()}. Page counts fetched for Collaboration
            Space only; other groups show structure only.
          </p>
        </div>
      )}
    </details>
  );
};

const Stat: React.FC<{ label: string; value: string; detail: string; emphasis?: boolean }> = ({
  label,
  value,
  detail,
  emphasis = false,
}) => (
  <div className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${emphasis ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'}`}>
    <p className={`text-2xl font-black leading-none tabular-nums ${emphasis ? 'text-rose-600' : 'text-slate-900'}`}>{value}</p>
    <div className="min-w-0">
      <p className="truncate text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <p className="truncate text-[11px] font-medium text-slate-400">{detail}</p>
    </div>
  </div>
);
