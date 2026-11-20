import React, { useEffect, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { diaryGroupKey, type InternAssignment, type InternProfile } from '../../services/contributorAttribution';
import { cleanInternProfiles, completeInternUpn, internEmailDomain } from '../../services/peerFeedbackStore';

const inputClass =
  'h-7 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:opacity-50';

export interface InternDraft {
  displayName: string;
  upn: string;
  labels: string;
  activeFrom: string;
  activeUntil: string;
  assignments: InternAssignment[];
}

const toDraft = (intern: InternProfile): InternDraft => ({
  displayName: intern.displayName,
  upn: intern.upn,
  labels: intern.labels.join(', '),
  activeFrom: intern.activeFrom ?? '',
  activeUntil: intern.activeUntil ?? '',
  assignments: intern.assignments ?? [],
});

const fromDraft = (draft: InternDraft, domain: string | null): InternProfile => ({
  displayName: draft.displayName,
  upn: completeInternUpn(draft.upn, domain),
  labels: draft.labels.split(',').map((label) => label.trim()).filter(Boolean),
  ...(draft.activeFrom ? { activeFrom: draft.activeFrom } : {}),
  ...(draft.activeUntil ? { activeUntil: draft.activeUntil } : {}),
  ...(draft.assignments.length > 0 ? { assignments: draft.assignments } : {}),
});

/**
 * Toggle one diary group (or the whole class, when group is null) in an
 * intern's assignments. Whole class and individual groups are exclusive.
 */
export const toggleAssignment = (
  assignments: InternAssignment[],
  classId: string,
  group: string | null
): InternAssignment[] => {
  const current = assignments.find((a) => a.classId === classId);
  const others = assignments.filter((a) => a.classId !== classId);
  if (group === null) {
    const wholeClass = current && current.groups.length === 0;
    return wholeClass ? others : [...others, { classId, groups: [] }];
  }
  const groups = current && current.groups.length > 0 ? current.groups : [];
  const has = groups.some((g) => diaryGroupKey(g) === diaryGroupKey(group));
  const next = has ? groups.filter((g) => diaryGroupKey(g) !== diaryGroupKey(group)) : [...groups, group];
  return next.length > 0 ? [...others, { classId, groups: next }] : others;
};

/**
 * Why a draft row cannot be saved, or null when it can (an empty row is
 * ignored, not an error). An ID without a domain is fine once the cohort's
 * domain is known from a saved intern.
 */
export const internDraftProblem = (draft: InternDraft, domain: string | null = null): string | null => {
  const empty = !draft.displayName.trim() && !draft.upn.trim() && !draft.labels.trim();
  if (empty) return null;
  if (!draft.displayName.trim()) return 'Add a name.';
  const upn = completeInternUpn(draft.upn, domain);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(upn)) {
    return domain
      ? 'Check the email or ID.'
      : 'Use the full university email for the first intern; after that the ID alone is enough.';
  }
  if (!draft.labels.trim()) return 'Add at least one diary name, or comments cannot be matched to this intern.';
  if (draft.activeFrom && draft.activeUntil && draft.activeFrom > draft.activeUntil) return '"From" is after "Until".';
  return null;
};

export interface PeerClassSettingsView {
  classId: string;
  name: string;
  authors: Array<{ key: string; label: string }>;
  excludedKeys: string[];
  /** This class's own date, overriding the shared one; undefined when it uses the shared date. */
  termOverride?: string;
  departed: Array<{ key: string; label: string; date: string }>;
  departureSuggestions: Array<{ key: string; label: string; lastEntryDate: string }>;
  /** Author key → local ISO date of their last entry ('' when undated), to pre-fill a departure. */
  lastEntryDates: Record<string, string>;
  /** Current diary group names in the class, for intern assignments. */
  groups: string[];
}

/**
 * Settings behind the Peer & Intern Feedback tab, collapsed by default: the
 * teacher's intern list and shared term split (all classes), and per class an
 * optional term-split override and pages to leave out.
 */
export const PeerFeedbackSettingsPanel: React.FC<{
  classes: PeerClassSettingsView[];
  interns: InternProfile[];
  sharedTermBoundary: string;
  saving: boolean;
  onSharedTermBoundary: (date: string) => void;
  onToggleExcluded: (classId: string, key: string, excluded: boolean) => void;
  /** undefined clears the override, so the class follows the shared date. */
  onTermOverride: (classId: string, date: string | undefined) => void;
  onSaveInterns: (interns: InternProfile[]) => void;
  /** undefined date marks the student as back in class. */
  onSetDeparture: (classId: string, key: string, date: string | undefined) => void;
  onDismissDeparture: (classId: string, key: string) => void;
}> = ({
  classes,
  interns,
  sharedTermBoundary,
  saving,
  onSharedTermBoundary,
  onToggleExcluded,
  onTermOverride,
  onSaveInterns,
  onSetDeparture,
  onDismissDeparture,
}) => {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<InternDraft[]>(() => interns.map(toDraft));
  useEffect(() => setDrafts(interns.map(toDraft)), [interns]);

  const domain = internEmailDomain(interns);
  // Compare cleaned forms: field order and blank rows must not read as unsaved changes.
  const dirty =
    JSON.stringify(cleanInternProfiles(drafts.map((draft) => fromDraft(draft, domain)))) !==
    JSON.stringify(cleanInternProfiles(interns));
  const problems = drafts.map((draft) => internDraftProblem(draft, domain));
  const blocked = problems.some(Boolean);
  const updateDraft = (index: number, patch: Partial<InternDraft>) =>
    setDrafts((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left">
        <div>
          <h3 className="text-sm font-black text-slate-900">Settings</h3>
          <p className="mt-1 text-xs font-medium text-slate-500">
            Interns ({interns.length} saved), the term split, students no longer in class, and pages to leave out.
            {classes.some((cls) => cls.departureSuggestions.length > 0) && (
              <span className="ml-1 font-bold text-amber-700">
                {classes.reduce((n, cls) => n + cls.departureSuggestions.length, 0)} student(s) may no longer be in class.
              </span>
            )}
          </p>
        </div>
        <ChevronDown size={14} className={`shrink-0 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>

      {open && (
        <div className="space-y-6 border-t border-slate-100 px-5 py-4">
          <div>
            <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Interns (all classes)</h4>
            <p className="mt-1 text-xs font-medium text-slate-500">
              Diary names are the names interns sign comments with; separate several with commas. Dates are optional and
              limit when a name counts as that intern.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[40rem] text-xs">
                <thead>
                  <tr className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                    <th className="pb-1 pr-2 text-left">Name</th>
                    <th className="pb-1 pr-2 text-left">{domain ? `Email or ID (@${domain})` : 'University email'}</th>
                    <th className="pb-1 pr-2 text-left">Diary names</th>
                    <th className="pb-1 pr-2 text-left">From</th>
                    <th className="pb-1 pr-2 text-left">Until</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((draft, index) => (
                    <React.Fragment key={index}>
                    <tr>
                      <td className="py-1 pr-2"><input className={inputClass} value={draft.displayName} disabled={saving} onChange={(e) => updateDraft(index, { displayName: e.target.value })} /></td>
                      <td className="py-1 pr-2"><input className={inputClass} value={draft.upn} disabled={saving} onChange={(e) => updateDraft(index, { upn: e.target.value })} /></td>
                      <td className="py-1 pr-2"><input className={inputClass} value={draft.labels} disabled={saving} placeholder="e.g. Matt, Matthew" onChange={(e) => updateDraft(index, { labels: e.target.value })} /></td>
                      <td className="py-1 pr-2"><input type="date" className={inputClass} value={draft.activeFrom} disabled={saving} onChange={(e) => updateDraft(index, { activeFrom: e.target.value })} /></td>
                      <td className="py-1 pr-2"><input type="date" className={inputClass} value={draft.activeUntil} disabled={saving} onChange={(e) => updateDraft(index, { activeUntil: e.target.value })} /></td>
                      <td className="py-1">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => setDrafts((prev) => prev.filter((_, i) => i !== index))}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 disabled:opacity-50"
                          aria-label="Remove intern"
                        >
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                    {problems[index] && (
                      <tr>
                        <td colSpan={6} className="pb-1 text-xs font-semibold text-amber-700">{problems[index]}</td>
                      </tr>
                    )}
                    <tr>
                      <td colSpan={6} className="pb-2">
                        <div className="space-y-1 rounded-lg bg-slate-50 px-2 py-1.5">
                          {classes.map((cls) => {
                            const assignment = draft.assignments.find((a) => a.classId === cls.classId);
                            const wholeClass = assignment !== undefined && assignment.groups.length === 0;
                            return (
                              <div key={cls.classId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-semibold text-slate-600">
                                <span className="w-44 shrink-0 truncate text-slate-500" title={cls.name}>{cls.name}</span>
                                <label className="flex items-center gap-1">
                                  <input
                                    type="checkbox"
                                    disabled={saving}
                                    checked={wholeClass}
                                    onChange={() => updateDraft(index, { assignments: toggleAssignment(draft.assignments, cls.classId, null) })}
                                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-200"
                                  />
                                  Whole class
                                </label>
                                {cls.groups.map((group) => (
                                  <label key={group} className={`flex items-center gap-1 ${wholeClass ? 'opacity-40' : ''}`}>
                                    <input
                                      type="checkbox"
                                      disabled={saving || wholeClass}
                                      checked={!wholeClass && (assignment?.groups ?? []).some((g) => diaryGroupKey(g) === diaryGroupKey(group))}
                                      onChange={() => updateDraft(index, { assignments: toggleAssignment(draft.assignments, cls.classId, group) })}
                                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-200"
                                    />
                                    {group.replace(/^diary\s*/i, '')}
                                  </label>
                                ))}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => setDrafts((prev) => [...prev, { displayName: '', upn: '', labels: '', activeFrom: '', activeUntil: '', assignments: [] }])}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <Plus size={12} /> Add intern
              </button>
              <button
                type="button"
                disabled={saving || !dirty || blocked}
                onClick={() => onSaveInterns(drafts.map((draft) => fromDraft(draft, domain)))}
                className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-black text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                Save interns
              </button>
              {dirty && !blocked && <span className="text-xs font-semibold text-amber-700">Unsaved changes.</span>}
              {blocked && <span className="text-xs font-semibold text-amber-700">Fix the highlighted rows to save.</span>}
            </div>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Term split (all classes)</h4>
            <p className="mt-1 text-xs font-medium text-slate-500">
              First day of the next term. Splits the grids into terms for viewing; matching already follows group changes
              by date. A class can use its own date below.
            </p>
            <input
              type="date"
              value={sharedTermBoundary}
              disabled={saving}
              onChange={(e) => onSharedTermBoundary(e.target.value)}
              className={`${inputClass} mt-2 w-44`}
            />
          </div>

          {classes.map((cls) => (
            <div key={cls.classId} className="space-y-4 border-t border-slate-100 pt-4">
              <h4 className="text-xs font-black text-slate-900">{cls.name}</h4>
              <div>
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    disabled={saving}
                    checked={cls.termOverride !== undefined}
                    onChange={(e) => onTermOverride(cls.classId, e.target.checked ? sharedTermBoundary || new Date().toISOString().slice(0, 10) : undefined)}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-200"
                  />
                  Different term split for this class
                </label>
                {cls.termOverride !== undefined && (
                  <input
                    type="date"
                    value={cls.termOverride}
                    disabled={saving}
                    onChange={(e) => e.target.value && onTermOverride(cls.classId, e.target.value)}
                    className={`${inputClass} mt-2 w-44`}
                  />
                )}
              </div>
              <div>
                <h5 className="text-[10px] font-black uppercase tracking-widest text-slate-400">No longer in class</h5>
                <p className="mt-1 text-xs font-medium text-slate-500">
                  Their diaries and comments up to the date stay in the record; after it they are not counted as group
                  members. Move their diary out of Collaboration Space in OneNote (sync first) to take it out of other
                  students' view.
                </p>
                {cls.departureSuggestions.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {cls.departureSuggestions.map((suggestion) => (
                      <li key={suggestion.key} className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-2 py-1 text-xs font-semibold text-slate-700">
                        <span className="truncate" title={suggestion.label}>{suggestion.label}</span>
                        <span className="text-slate-500">diary no longer in a shared group · last entry {suggestion.lastEntryDate}</span>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => onSetDeparture(cls.classId, suggestion.key, suggestion.lastEntryDate)}
                          className="rounded-md border border-indigo-200 bg-white px-1.5 py-0.5 text-[10px] font-black text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                        >
                          No longer in class
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => onDismissDeparture(cls.classId, suggestion.key)}
                          className="rounded-md px-1.5 py-0.5 text-[10px] font-black text-slate-500 hover:bg-white disabled:opacity-50"
                        >
                          Dismiss
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {cls.departed.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {cls.departed.map((student) => (
                      <li key={student.key} className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-700">
                        <span className="truncate" title={student.label}>{student.label}</span>
                        <span className="text-slate-400">left</span>
                        <input
                          type="date"
                          value={student.date}
                          disabled={saving}
                          onChange={(e) => e.target.value && onSetDeparture(cls.classId, student.key, e.target.value)}
                          className={`${inputClass} w-36`}
                        />
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => onSetDeparture(cls.classId, student.key, undefined)}
                          className="rounded-md px-1.5 py-0.5 text-[10px] font-black text-slate-500 hover:bg-slate-100 disabled:opacity-50"
                        >
                          Back in class
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <select
                  value=""
                  disabled={saving}
                  onChange={(e) => {
                    const key = e.target.value;
                    if (key) onSetDeparture(cls.classId, key, cls.lastEntryDates[key] || new Date().toISOString().slice(0, 10));
                  }}
                  className={`${inputClass} mt-2 w-72`}
                >
                  <option value="">Mark a student as no longer in class…</option>
                  {cls.authors
                    .filter((author) => !cls.departed.some((d) => d.key === author.key) && !cls.excludedKeys.includes(author.key))
                    .map((author) => (
                      <option key={author.key} value={author.key}>{author.label}</option>
                    ))}
                </select>
              </div>
              <div>
                <h5 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Pages to leave out</h5>
                <p className="mt-1 text-xs font-medium text-slate-500">
                  For teacher test pages and other pages that are not a student's diary.
                </p>
                <div className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {cls.authors.map((author) => (
                    <label key={author.key} className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        disabled={saving}
                        checked={cls.excludedKeys.includes(author.key)}
                        onChange={(e) => onToggleExcluded(cls.classId, author.key, e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-200"
                      />
                      <span className="truncate" title={author.label}>{author.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
