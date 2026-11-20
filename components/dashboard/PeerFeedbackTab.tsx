import React, { useMemo, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import { AlertTriangle, Layers, MessageSquare, UserRound, Users } from 'lucide-react';
import {
  attributeComments,
  attributionCoverage,
  buildGroupGrids,
  buildRomajiIndex,
  contributorKey,
  extractRomajiName,
  fillPageIdentity,
  filterCurrentAcademicYear,
  resolveEffectiveEntries,
  studentKeyFor,
  suggestDepartures,
  type GroupGrid,
  type RomajiName,
} from '../../services/contributorAttribution';
import { usePeerFeedbackConfig } from '../../hooks/usePeerFeedbackConfig';
import { effectiveTermBoundary } from '../../services/peerFeedbackStore';
import type { EducationClass, PageSyncRecord, StoredDiaryEntry } from '../../types';
import { FilterSelect, MetricTile, formatPercent } from './dashboardPrimitives';
import { PeerFeedbackSettingsPanel } from './PeerFeedbackSettingsPanel';
import { PeerNamesToReview, type PeerCandidate, type PeerNameMap } from './PeerNamesToReview';
import { PeerInternCoverage } from './PeerInternCoverage';

interface PeerFeedbackTabProps {
  db: Firestore;
  uid: string;
  /** Owner only: share intern group assignments with interns' apps. */
  publishInternAssignments?: boolean;
  entries: StoredDiaryEntry[];
  pageRecords: PageSyncRecord[];
  selectedClasses: EducationClass[];
}

const localIsoDate = (time: number): string => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const capitalize = (value: string): string =>
  value.replace(/(^|\s)(\p{L})/gu, (_, space: string, letter: string) => space + letter.toUpperCase());

/**
 * Peer & Intern Feedback: who commented on whom inside each diary group, from
 * the bracketed labels in diary entries. Matches are suggestions from
 * `contributorAttribution` until the teacher confirms them; confirmations,
 * excluded pages, the term split and the intern list persist through
 * `usePeerFeedbackConfig`. See PLANNING/peer-intern-feedback.md.
 */
export const PeerFeedbackTab: React.FC<PeerFeedbackTabProps> = ({
  db,
  uid,
  publishInternAssignments = false,
  entries,
  pageRecords,
  selectedClasses,
}) => {
  // All selected classes by default: opening silently on the first class led to
  // edits landing in a class the teacher was not looking at.
  const [classFilter, setClassFilter] = useState<string>(selectedClasses.length === 1 ? selectedClasses[0].id : 'all');
  const [termFilter, setTermFilter] = useState<string>('all');
  const [weekFilter, setWeekFilter] = useState<string>('all');
  const [includeSuggested, setIncludeSuggested] = useState(true);

  const classIds = useMemo(() => selectedClasses.map((cls) => cls.id), [selectedClasses]);
  const config = usePeerFeedbackConfig(db, uid, classIds, { publishAssignments: publishInternAssignments });
  const classNames = useMemo(() => new Map(selectedClasses.map((cls) => [cls.id, cls.displayName] as const)), [selectedClasses]);
  const shownClassIds = useMemo(() => (classFilter === 'all' ? classIds : [classFilter]), [classFilter, classIds]);
  const termBoundaries = useMemo(
    () => Object.fromEntries(classIds.map((id) => [id, effectiveTermBoundary(config.cohort, config.settingsByClass[id])])),
    [classIds, config.settingsByClass, config.cohort]
  );

  const classEntries = useMemo(
    () => (classFilter === 'all' ? entries : entries.filter((entry) => entry.classId === classFilter)),
    [entries, classFilter]
  );

  // Older stored entries may lack a page title; sample diaries and students'
  // copies of them carry prior-year comments that are not this cohort's.
  const { kept: currentEntries, dropped: priorYearEntries } = useMemo(
    () => filterCurrentAcademicYear(fillPageIdentity(classEntries, pageRecords)),
    [classEntries, pageRecords]
  );
  const excludedKeys = useMemo(
    () => new Set(Object.values(config.settingsByClass).flatMap((settings) => settings.excludedAuthorKeys.map((key) => `${settings.classId}|${key}`))),
    [config.settingsByClass]
  );
  const scopedEntries = useMemo(
    () => currentEntries.filter((entry) => !excludedKeys.has(`${entry.classId}|${studentKeyFor(entry)}`)),
    [currentEntries, excludedKeys]
  );

  // Each class has its own term split, so resolve per class.
  const effective = useMemo(
    () =>
      shownClassIds.flatMap((classId) =>
        resolveEffectiveEntries(
          scopedEntries.filter((entry) => entry.classId === classId),
          pageRecords,
          { termBoundaries: termBoundaries[classId] ? [termBoundaries[classId]] : [] }
        )
      ),
    [scopedEntries, pageRecords, termBoundaries, shownClassIds]
  );
  const romajiIndex = useMemo(() => buildRomajiIndex(scopedEntries), [scopedEntries]);

  // Students no longer in class: `${classId}|${authorKey}` → ISO date left.
  const departures = useMemo(
    () =>
      Object.fromEntries(
        Object.values(config.settingsByClass).flatMap((settings) =>
          Object.entries(settings.departures ?? {}).map(([key, date]) => [`${settings.classId}|${key}`, date] as const)
        )
      ),
    [config.settingsByClass]
  );
  const departureSuggestions = useMemo(() => {
    const skip = new Set([
      ...Object.keys(departures),
      ...excludedKeys,
      ...Object.values(config.settingsByClass).flatMap((settings) =>
        (settings.dismissedDepartures ?? []).map((key) => `${settings.classId}|${key}`)
      ),
    ]);
    return suggestDepartures(effective, pageRecords, skip);
  }, [effective, pageRecords, departures, excludedKeys, config.settingsByClass]);
  const lastEntryByAuthor = useMemo(() => {
    const last = new Map<string, number>();
    for (const item of effective) {
      if (!Number.isFinite(item.time)) continue;
      const key = `${item.entry.classId}|${item.authorKey}`;
      last.set(key, Math.max(last.get(key) ?? -Infinity, item.time));
    }
    return last;
  }, [effective]);

  const comments = useMemo(
    () => attributeComments(effective, { romajiIndex, aliases: config.aliases, interns: config.interns, departures }),
    [effective, romajiIndex, config.aliases, config.interns, departures]
  );

  const visibleComments = useMemo(
    () =>
      comments.filter(
        (comment) =>
          (termFilter === 'all' || String(comment.term) === termFilter) &&
          (weekFilter === 'all' || (comment.weekNumber || 'not captured') === weekFilter)
      ),
    [comments, termFilter, weekFilter]
  );
  const grids = useMemo(
    () =>
      buildGroupGrids(effective, visibleComments, { includeSuggested })
        .filter((grid) => termFilter === 'all' || String(grid.term) === termFilter)
        .sort(
          (a, b) =>
            (classNames.get(a.classId) ?? a.classId).localeCompare(classNames.get(b.classId) ?? b.classId) ||
            a.term - b.term ||
            a.groupId.localeCompare(b.groupId)
        ),
    [effective, visibleComments, includeSuggested, termFilter, classNames]
  );

  const coverage = attributionCoverage(visibleComments);
  const attributed = coverage.confirmed + coverage.suggested;
  const collapsedCopies = effective.reduce((sum, item) => sum + item.collapsedCopies, 0);
  const terms = Array.from(new Set(effective.map((item) => item.term))).sort((a, b) => a - b);
  const weeks = Array.from(new Set(comments.map((c) => c.weekNumber || 'not captured'))).sort(
    (a, b) => (parseInt(a, 10) || Infinity) - (parseInt(b, 10) || Infinity)
  );

  // Display names keyed by student author key (grid columns) and by
  // contributorKey (rows, confirmations). Built from every current-year entry,
  // excluded pages included, so the settings list can still name them.
  const { names, contributorNames, authorsByClass } = useMemo(() => {
    const allIndex = buildRomajiIndex(currentEntries);
    const byAuthor: PeerNameMap = new Map();
    const byContributor: PeerNameMap = new Map();
    const authors = new Map<string, Array<{ key: string; label: string }>>();
    for (const entry of currentEntries) {
      const key = studentKeyFor(entry);
      if (byAuthor.has(key)) continue;
      const romaji: RomajiName | undefined = allIndex.get(key);
      const full = entry.studentName || entry.pageTitle || key;
      const name = { short: romaji ? capitalize(romaji.given ?? romaji.display) : full, full: entry.pageTitle || full };
      byAuthor.set(key, name);
      byContributor.set(contributorKey({ kind: 'student', key }), name);
      authors.set(entry.classId, [...(authors.get(entry.classId) ?? []), { key, label: name.full }]);
    }
    // Students whose diary was discovered but has no saved entries yet still
    // belong in the class: take them from live page records too.
    for (const record of pageRecords) {
      if (record.orphanedAt || record.recordKind === 'section_error' || !classIds.includes(record.classId)) continue;
      if (!record.studentUpn && !/\d{7,}/.test(record.pageTitle || '')) continue;
      const key = studentKeyFor(record);
      if (byAuthor.has(key)) continue;
      const romaji = extractRomajiName(record.pageTitle || '');
      const full = record.pageTitle || record.studentName || key;
      const name = { short: romaji ? capitalize(romaji.given ?? romaji.display) : full, full };
      byAuthor.set(key, name);
      byContributor.set(contributorKey({ kind: 'student', key }), name);
      authors.set(record.classId, [...(authors.get(record.classId) ?? []), { key, label: full }]);
    }
    for (const intern of config.interns) {
      const name = { short: intern.displayName, full: `${intern.displayName} (intern)` };
      byAuthor.set(contributorKey({ kind: 'intern', upn: intern.upn }), name);
      byContributor.set(contributorKey({ kind: 'intern', upn: intern.upn }), name);
    }
    authors.forEach((list) => list.sort((a, b) => a.label.localeCompare(b.label)));
    return { names: byAuthor, contributorNames: byContributor, authorsByClass: authors };
  }, [currentEntries, pageRecords, classIds, config.interns]);

  const candidatesByClass = useMemo(() => {
    const result = new Map<string, PeerCandidate[]>();
    authorsByClass.forEach((authors, classId) => {
      const students = authors
        .filter((author) => !excludedKeys.has(`${classId}|${author.key}`))
        .map((author) => {
          const left = departures[`${classId}|${author.key}`];
          return { ref: { kind: 'student' as const, key: author.key }, label: left ? `${author.label} (left ${left})` : author.label };
        });
      const interns = config.interns.map((intern) => ({
        ref: { kind: 'intern' as const, upn: intern.upn },
        label: `${intern.displayName} (intern)`,
      }));
      result.set(classId, [...interns, ...students]);
    });
    return result;
  }, [authorsByClass, excludedKeys, config.interns, departures]);

  const groupNames = useMemo(
    () => new Map(effective.map((item) => [`${item.groupId}`, item.groupName || item.groupId] as const)),
    [effective]
  );
  // Current diary groups per class, from live page records (moved-away
  // groups drop out), for intern assignments and coverage.
  const groupsByClass = useMemo(() => {
    const byClass = new Map<string, Set<string>>();
    for (const record of pageRecords) {
      if (record.orphanedAt || !record.diaryGroupName || !classIds.includes(record.classId)) continue;
      if (!byClass.has(record.classId)) byClass.set(record.classId, new Set());
      byClass.get(record.classId)!.add(record.diaryGroupName);
    }
    return new Map(
      [...byClass].map(([classId, names]) => [
        classId,
        [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      ] as const)
    );
  }, [pageRecords, classIds]);

  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-500 shadow-sm">
        No saved entries for the selected classes yet.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {config.error && (
        <div className="flex items-start justify-between gap-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-xs font-semibold text-red-700">
          <span>{config.error}</span>
          <button type="button" onClick={config.dismissError} className="shrink-0 font-black text-red-500 hover:text-red-700">
            Dismiss
          </button>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          icon={<MessageSquare size={18} />}
          label="Labelled Comments"
          value={String(coverage.total)}
          detail="in the current filter"
        />
        <MetricTile
          icon={<UserRound size={18} />}
          label="Attributed"
          value={formatPercent(attributed, coverage.total)}
          detail={`${coverage.confirmed} confirmed, ${coverage.suggested} suggested`}
          tone="indigo"
        />
        <MetricTile
          icon={<AlertTriangle size={18} />}
          label="Unmatched"
          value={String(coverage.unresolved + coverage.unspecified)}
          detail={`${coverage.unspecified} without a name label`}
          tone={coverage.unresolved > 0 ? 'amber' : 'slate'}
        />
        <MetricTile
          icon={<Layers size={18} />}
          label="Moved-Page Copies"
          value={String(collapsedCopies)}
          detail="duplicate entries merged"
        />
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          {selectedClasses.length > 1 && (
            <FilterSelect
              label="Class"
              value={classFilter}
              options={[['all', 'All selected'], ...selectedClasses.map((cls) => [cls.id, cls.displayName] as [string, string])]}
              onChange={(value) => {
                setClassFilter(value);
                setTermFilter('all');
              }}
            />
          )}
          {terms.length > 1 && (
            <FilterSelect
              label="Term"
              value={termFilter}
              options={[['all', 'All terms'], ...terms.map((t) => [String(t), `Term ${t}`] as [string, string])]}
              onChange={setTermFilter}
            />
          )}
          <FilterSelect
            label="Week"
            value={weekFilter}
            options={[['all', 'All weeks'], ...weeks.map((w) => [w, w === 'not captured' ? 'Week not captured' : `Week ${w}`] as [string, string])]}
            onChange={setWeekFilter}
          />
          <label className="flex h-8 items-center gap-2 text-xs font-bold text-slate-600">
            <input
              type="checkbox"
              checked={includeSuggested}
              onChange={(event) => setIncludeSuggested(event.target.checked)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-200"
            />
            Count suggested matches
          </label>
          {(config.loading || config.saving) && (
            <span className="h-8 text-xs font-semibold leading-8 text-slate-400">{config.loading ? 'Loading settings…' : 'Saving…'}</span>
          )}
        </div>
        <p className="mt-3 text-xs font-medium leading-relaxed text-slate-500">
          Rows are commenters, columns are diary authors. Counts show presence and volume of labelled comments, not
          their quality. Matching follows group changes by date.
          {priorYearEntries.length > 0 &&
            ` ${priorYearEntries.length} entries dated in earlier academic years (sample diaries and copies of them) are left out.`}
        </p>
      </section>

      {shownClassIds
        .filter((classId) => grids.some((grid) => grid.classId === classId))
        .sort((a, b) => (classNames.get(a) ?? a).localeCompare(classNames.get(b) ?? b))
        .map((classId) => (
          <section key={classId} className="space-y-3">
            {shownClassIds.length > 1 && (
              <h3 className="px-1 text-[10px] font-black uppercase tracking-widest text-slate-500">{classNames.get(classId) ?? classId}</h3>
            )}
            <div className="grid gap-5 xl:grid-cols-2">
              {grids
                .filter((grid) => grid.classId === classId)
                .map((grid) => (
                  <GroupGridCard
                    key={`${grid.classId}|${grid.groupId}|${grid.term}`}
                    grid={grid}
                    groupName={groupNames.get(grid.groupId) ?? grid.groupId}
                    showTerm={terms.length > 1}
                    names={names}
                    departedOn={(key) => departures[`${grid.classId}|${key}`]}
                  />
                ))}
            </div>
          </section>
        ))}

      <PeerInternCoverage
        interns={config.interns}
        comments={visibleComments}
        classIds={shownClassIds}
        classNames={classNames}
        groupsByClass={groupsByClass}
        groupNames={groupNames}
      />

      <PeerNamesToReview
        comments={visibleComments}
        names={contributorNames}
        groupNames={groupNames}
        classNames={classNames}
        candidatesByClass={candidatesByClass}
        aliases={config.aliases.filter((alias) => classFilter === 'all' || alias.classId === classFilter)}
        saving={config.saving || config.loading}
        onConfirm={config.confirmAliases}
        onRemove={config.removeAlias}
      />

      <PeerFeedbackSettingsPanel
        classes={shownClassIds
          .map((classId) => ({
            classId,
            name: classNames.get(classId) ?? classId,
            authors: authorsByClass.get(classId) ?? [],
            excludedKeys: config.settingsByClass[classId]?.excludedAuthorKeys ?? [],
            termOverride: config.settingsByClass[classId]?.termBoundary,
            groups: groupsByClass.get(classId) ?? [],
            departed: Object.entries(config.settingsByClass[classId]?.departures ?? {})
              .map(([key, date]) => ({ key, label: names.get(key)?.full ?? key, date }))
              .sort((a, b) => a.label.localeCompare(b.label)),
            departureSuggestions: departureSuggestions
              .filter((suggestion) => suggestion.classId === classId)
              .map((suggestion) => ({
                key: suggestion.authorKey,
                label: names.get(suggestion.authorKey)?.full ?? suggestion.authorKey,
                lastEntryDate: suggestion.lastEntryDate,
              })),
            lastEntryDates: Object.fromEntries(
              (authorsByClass.get(classId) ?? []).map((author) => {
                const time = lastEntryByAuthor.get(`${classId}|${author.key}`);
                return [author.key, time !== undefined ? localIsoDate(time) : ''];
              })
            ),
          }))
          .sort((a, b) => a.name.localeCompare(b.name))}
        interns={config.interns}
        sharedTermBoundary={config.cohort.termBoundary ?? ''}
        saving={config.saving || config.loading}
        onSharedTermBoundary={(date) => {
          setTermFilter('all');
          config.updateCohortSettings({ termBoundary: date || undefined });
        }}
        onToggleExcluded={(classId, key, excluded) => {
          const current = config.settingsByClass[classId]?.excludedAuthorKeys ?? [];
          config.updateClassSettings(classId, {
            excludedAuthorKeys: excluded ? [...current, key] : current.filter((existing) => existing !== key),
          });
        }}
        onTermOverride={(classId, date) => {
          setTermFilter('all');
          config.updateClassSettings(classId, { termBoundary: date });
        }}
        onSaveInterns={config.updateInterns}
        onSetDeparture={(classId, key, date) => {
          const current = { ...(config.settingsByClass[classId]?.departures ?? {}) };
          if (date) current[key] = date;
          else delete current[key];
          config.updateClassSettings(classId, { departures: current });
        }}
        onDismissDeparture={(classId, key) => {
          const current = config.settingsByClass[classId]?.dismissedDepartures ?? [];
          config.updateClassSettings(classId, { dismissedDepartures: [...current, key] });
        }}
      />
    </div>
  );
};

const GroupGridCard: React.FC<{
  grid: GroupGrid;
  groupName: string;
  showTerm: boolean;
  names: Map<string, { short: string; full: string }>;
  departedOn: (authorKey: string) => string | undefined;
}> = ({ grid, groupName, showTerm, names, departedOn }) => {
  const memberRows = grid.members.map((key) => contributorKey({ kind: 'student', key }));
  const otherRows = [...grid.cells.keys()].filter((row) => !memberRows.includes(row)).sort();
  const rowLabel = (row: string): { short: string; full: string } => {
    if (row.startsWith('student:')) {
      const key = row.slice('student:'.length);
      return names.get(key) ?? { short: key, full: key };
    }
    const upn = row.slice('intern:'.length);
    return names.get(row) ?? { short: upn.split('@')[0], full: `Intern · ${upn}` };
  };
  const received = (author: string): number =>
    [...grid.cells.values()].reduce((sum, row) => sum + (row.get(author) ?? 0), 0);
  const given = (row: string): number => [...(grid.cells.get(row)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const cellClass = 'border-t border-slate-100 px-2 py-1.5 text-center tabular-nums';

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Users size={14} className="shrink-0 text-slate-400" />
          <h3 className="truncate text-sm font-black text-slate-900" title={groupName}>{groupName}</h3>
        </div>
        <span className="shrink-0 text-[10px] font-black uppercase tracking-widest text-slate-400">
          {showTerm ? `Term ${grid.term} · ` : ''}{grid.members.length} members
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              <th className="px-3 py-2 text-left">From \ On</th>
              {grid.members.map((author) => (
                <th key={author} className="px-2 py-2 text-center" title={names.get(author)?.full}>
                  {names.get(author)?.short ?? author}
                  {departedOn(author) && (
                    <span className="block text-[9px] font-semibold normal-case tracking-normal text-slate-400">left {departedOn(author)}</span>
                  )}
                </th>
              ))}
              <th className="px-2 py-2 text-right">Given</th>
            </tr>
          </thead>
          <tbody className="font-bold text-slate-700">
            {[...memberRows, ...otherRows].map((row) => {
              const label = rowLabel(row);
              const isIntern = row.startsWith('intern:');
              return (
                <tr key={row} className={isIntern ? 'bg-indigo-50/40' : undefined}>
                  <td className="border-t border-slate-100 px-3 py-1.5 text-left" title={label.full}>
                    {label.short}
                    {row.startsWith('student:') && departedOn(row.slice('student:'.length)) && (
                      <span className="ml-1 text-[9px] font-semibold text-slate-400">left {departedOn(row.slice('student:'.length))}</span>
                    )}
                  </td>
                  {grid.members.map((author) => {
                    const self = row === contributorKey({ kind: 'student', key: author });
                    const count = grid.cells.get(row)?.get(author) ?? 0;
                    return (
                      <td key={author} className={`${cellClass} ${self ? 'bg-slate-50 text-slate-300' : count === 0 ? 'text-slate-300' : ''}`}>
                        {self ? '—' : count}
                      </td>
                    );
                  })}
                  <td className={`${cellClass} text-right font-black`}>{given(row)}</td>
                </tr>
              );
            })}
            <tr className="text-slate-500">
              <td className="border-t border-slate-200 px-3 py-1.5 text-left text-[10px] font-black uppercase tracking-wider text-slate-400">
                Unmatched
              </td>
              {grid.members.map((author) => (
                <td key={author} className={`${cellClass} border-slate-200 text-amber-600`}>
                  {grid.unattributedByAuthor.get(author) || ''}
                </td>
              ))}
              <td className={`${cellClass} border-slate-200`} />
            </tr>
            <tr>
              <td className="border-t border-slate-200 px-3 py-1.5 text-left text-[10px] font-black uppercase tracking-wider text-slate-400">
                Received
              </td>
              {grid.members.map((author) => (
                <td key={author} className={`${cellClass} border-slate-200 font-black`}>{received(author)}</td>
              ))}
              <td className={`${cellClass} border-slate-200`} />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};
