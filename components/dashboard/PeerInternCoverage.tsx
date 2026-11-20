import React, { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  diaryGroupKey,
  internCoversGroup,
  type AttributedComment,
  type InternProfile,
} from '../../services/contributorAttribution';

interface GroupCell {
  name: string;
  count: number;
  lastTime: number;
  lastDate: string;
}

/**
 * Intern coverage: for each intern, their assigned diary groups with the
 * comments they have left there (confirmed or suggested attributions within
 * the current filters), plus any comments outside their groups. Presence and
 * volume only, like the rest of the tab.
 */
export const PeerInternCoverage: React.FC<{
  interns: InternProfile[];
  comments: AttributedComment[];
  classIds: string[];
  classNames: Map<string, string>;
  /** classId → current diary group names in that class. */
  groupsByClass: Map<string, string[]>;
  groupNames: Map<string, string>;
}> = ({ interns, comments, classIds, classNames, groupsByClass, groupNames }) => {
  const [open, setOpen] = useState(true);

  const rows = useMemo(
    () =>
      interns
        .map((intern) => {
          const own = comments.filter(
            (comment) =>
              comment.commenter?.kind === 'intern' &&
              comment.commenter.upn === intern.upn &&
              (comment.status === 'confirmed' || comment.status === 'suggested')
          );
          const cell = (classId: string, name: string): GroupCell => {
            const inGroup = own.filter(
              (comment) =>
                comment.classId === classId &&
                diaryGroupKey(groupNames.get(comment.groupId) ?? comment.groupId) === diaryGroupKey(name)
            );
            const last = inGroup.reduce<AttributedComment | null>(
              (latest, comment) => (!latest || (Number.isFinite(comment.time) && comment.time > latest.time) ? comment : latest),
              null
            );
            return { name, count: inGroup.length, lastTime: last?.time ?? NaN, lastDate: last?.date ?? '' };
          };
          const assigned = classIds
            .filter((classId) => (intern.assignments ?? []).some((a) => a.classId === classId))
            .map((classId) => ({
              classId,
              cells: (groupsByClass.get(classId) ?? [])
                .filter((name) => internCoversGroup(intern, classId, name))
                .map((name) => cell(classId, name)),
            }));
          const elsewhere = own.filter(
            (comment) =>
              classIds.includes(comment.classId) &&
              !internCoversGroup(intern, comment.classId, groupNames.get(comment.groupId) ?? comment.groupId)
          );
          return { intern, assigned, elsewhere };
        })
        .filter((row) => row.assigned.length > 0 || row.elsewhere.length > 0),
    [interns, comments, classIds, groupsByClass, groupNames]
  );

  if (interns.length === 0) return null;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left">
        <div>
          <h3 className="text-sm font-black text-slate-900">Intern coverage</h3>
          <p className="mt-1 text-xs font-medium text-slate-500">
            Diary comments by each intern in their assigned groups, within the current filters. Assign groups under
            Settings → Interns.
          </p>
        </div>
        <ChevronDown size={14} className={`shrink-0 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-100 px-5 py-4">
          {rows.length === 0 && (
            <p className="text-xs font-medium text-slate-500">No intern has group assignments in the selected classes yet.</p>
          )}
          {rows.map(({ intern, assigned, elsewhere }) => (
            <div key={intern.upn}>
              <h4 className="text-xs font-black text-slate-900">{intern.displayName}</h4>
              <div className="mt-1 space-y-1">
                {assigned.map(({ classId, cells }) => (
                  <div key={classId} className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="w-44 shrink-0 truncate font-semibold text-slate-500" title={classNames.get(classId)}>
                      {classNames.get(classId) ?? classId}
                    </span>
                    {cells.length === 0 && <span className="text-slate-400">no matching groups in the current data</span>}
                    {cells.map((cell) => (
                      <span
                        key={cell.name}
                        className={`rounded-md px-2 py-0.5 font-bold ${cell.count > 0 ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-100 text-slate-400'}`}
                        title={cell.count > 0 ? `Latest: ${cell.lastDate}` : 'No comments in the current filters'}
                      >
                        {cell.name.replace(/^diary\s*/i, '')} · {cell.count}
                        {cell.count > 0 && cell.lastDate && <span className="ml-1 font-semibold text-indigo-400">{cell.lastDate}</span>}
                      </span>
                    ))}
                  </div>
                ))}
                {elsewhere.length > 0 && (
                  <p className="text-xs font-semibold text-slate-500">
                    {elsewhere.length} comment(s) outside assigned groups
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
