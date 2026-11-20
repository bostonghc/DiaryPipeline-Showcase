import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import {
  contributorKey,
  type AttributedComment,
  type ContributorAlias,
  type ContributorRef,
} from '../../services/contributorAttribution';

export type PeerNameMap = Map<string, { short: string; full: string }>;

export interface PeerCandidate {
  ref: ContributorRef;
  label: string;
}

const BASIS_LABELS: Record<string, string> = {
  alias: 'confirmed',
  'intern-label': 'intern name',
  'romaji-title': 'romaji in page title',
  'close-spelling': 'one letter off the page-title romaji',
  'self-exclusion': 'only group member not commented on',
};

interface Suggestion {
  ref: ContributorRef;
  count: number;
  basis: string;
  groups: Set<string>;
}

interface LabelSummary {
  classId: string;
  label: string;
  examples: Set<string>;
  count: number;
  groups: Set<string>;
  suggestions: Map<string, Suggestion>;
  unresolved: number;
  flags: Set<string>;
}

/**
 * Labels not yet confirmed, with one-click confirmation of a suggestion and
 * manual assignment for everything matching cannot reach (typos, kanji-only
 * titles). Confirming a suggestion is class-wide when it is the label's only
 * reading; when the same label points at different people in different groups,
 * each confirmation is limited to the groups where it was suggested.
 */
export const PeerNamesToReview: React.FC<{
  comments: AttributedComment[];
  names: PeerNameMap;
  groupNames: Map<string, string>;
  classNames: Map<string, string>;
  candidatesByClass: Map<string, PeerCandidate[]>;
  aliases: ContributorAlias[];
  saving: boolean;
  onConfirm: (aliases: ContributorAlias[]) => unknown;
  onRemove: (alias: ContributorAlias) => unknown;
}> = ({ comments, names, groupNames, classNames, candidatesByClass, aliases, saving, onConfirm, onRemove }) => {
  const [open, setOpen] = useState(false);
  const [confirmedOpen, setConfirmedOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Only the control that was used shows progress; the rest stay as they are
  // (all are inert while any save runs, but none of them visibly change).
  const [pending, setPending] = useState<string | null>(null);
  const track = async (key: string, action: () => unknown) => {
    setPending(key);
    try {
      await action();
    } finally {
      setPending(null);
    }
  };

  const nameOf = (ref: ContributorRef) => names.get(contributorKey(ref))?.full ?? contributorKey(ref);

  const summaries = useMemo(() => {
    const byLabel = new Map<string, LabelSummary>();
    for (const comment of comments) {
      if (comment.status === 'confirmed' || comment.status === 'unspecified') continue;
      const key = `${comment.classId}|${comment.label}`;
      const summary = byLabel.get(key) ?? {
        classId: comment.classId,
        label: comment.label,
        examples: new Set<string>(),
        count: 0,
        groups: new Set<string>(),
        suggestions: new Map<string, Suggestion>(),
        unresolved: 0,
        flags: new Set<string>(),
      };
      summary.examples.add(comment.labelRaw.trim());
      summary.count += 1;
      summary.groups.add(comment.groupId);
      comment.flags.forEach((flag) => summary.flags.add(flag));
      if (comment.commenter) {
        const targetKey = contributorKey(comment.commenter);
        const existing = summary.suggestions.get(targetKey) ?? {
          ref: comment.commenter,
          count: 0,
          basis: comment.basis ?? '',
          groups: new Set<string>(),
        };
        existing.count += 1;
        existing.groups.add(comment.groupId);
        summary.suggestions.set(targetKey, existing);
      } else {
        summary.unresolved += 1;
      }
      byLabel.set(key, summary);
    }
    return [...byLabel.values()].sort(
      (a, b) =>
        (classNames.get(a.classId) ?? a.classId).localeCompare(classNames.get(b.classId) ?? b.classId) ||
        b.unresolved - a.unresolved ||
        b.count - a.count
    );
  }, [comments, classNames]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? summaries.filter(
        (summary) =>
          summary.label.includes(needle) ||
          [...summary.examples].some((example) => example.toLowerCase().includes(needle)) ||
          [...summary.suggestions.values()].some((s) => nameOf(s.ref).toLowerCase().includes(needle))
      )
    : summaries;
  const multiClass = new Set(summaries.map((summary) => summary.classId)).size > 1;
  const className = (classId: string) => classNames.get(classId) ?? classId;
  const multiClassAliases = new Set(aliases.map((alias) => alias.classId)).size > 1;

  const confirmSuggestion = (summary: LabelSummary, suggestion: Suggestion) => {
    const onlyReading = summary.suggestions.size === 1 && summary.unresolved === 0;
    return track(`confirm|${summary.classId}|${summary.label}|${contributorKey(suggestion.ref)}`, () => onConfirm(
      onlyReading
        ? [{ classId: summary.classId, label: summary.label, target: suggestion.ref }]
        : [...suggestion.groups].map((groupId) => ({ classId: summary.classId, label: summary.label, target: suggestion.ref, groupId }))
    ));
  };

  const assign = (summary: LabelSummary, value: string) => {
    const candidate = candidatesByClass.get(summary.classId)?.find((c) => contributorKey(c.ref) === value);
    if (candidate) {
      track(`assign|${summary.classId}|${summary.label}`, () =>
        onConfirm([{ classId: summary.classId, label: summary.label, target: candidate.ref }])
      );
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left">
        <div>
          <h3 className="text-sm font-black text-slate-900">Names to review</h3>
          <p className="mt-1 text-xs font-medium text-slate-500">
            Confirm a suggested match, or assign the name to someone yourself. Confirmed names apply to the whole class
            and override every suggestion.
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-xs font-black text-slate-400">
          {summaries.length}
          <ChevronDown size={14} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-slate-100">
          <div className="px-5 pt-3">
            <label className="flex h-8 max-w-xs items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 shadow-sm focus-within:border-indigo-300">
              <Search size={13} className="text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a name"
                className="w-full bg-transparent text-xs font-semibold text-slate-700 focus:outline-none"
              />
            </label>
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                <th className="px-5 py-2 text-left">Label as written</th>
                <th className="px-3 py-2 text-right">Comments</th>
                <th className="px-3 py-2 text-left">Groups</th>
                <th className="px-3 py-2 text-left">Suggested match</th>
                <th className="px-5 py-2 text-left">Assign to</th>
              </tr>
            </thead>
            <tbody className="font-semibold text-slate-700">
              {visible.map((summary, index) => (
                <React.Fragment key={`${summary.classId}|${summary.label}`}>
                {multiClass && (index === 0 || visible[index - 1].classId !== summary.classId) && (
                  <tr>
                    <td colSpan={5} className="border-t border-slate-200 bg-slate-50 px-5 py-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500">
                      {className(summary.classId)}
                    </td>
                  </tr>
                )}
                <tr className="align-top">
                  <td className="border-t border-slate-100 px-5 py-2 font-black">{[...summary.examples].join(' / ')}</td>
                  <td className="border-t border-slate-100 px-3 py-2 text-right tabular-nums">{summary.count}</td>
                  <td className="border-t border-slate-100 px-3 py-2 text-slate-500">
                    {[...summary.groups].map((id) => groupNames.get(id) ?? id).join(', ')}
                  </td>
                  <td className="border-t border-slate-100 px-3 py-2">
                    {[...summary.suggestions.values()].map((suggestion) => (
                      <div key={contributorKey(suggestion.ref)} className="flex items-center gap-2 py-0.5">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => confirmSuggestion(summary, suggestion)}
                          className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-black text-indigo-700 hover:bg-indigo-100 disabled:cursor-wait"
                          title={summary.suggestions.size > 1 || summary.unresolved > 0 ? 'Confirm for the groups where this was suggested' : 'Confirm for the whole class'}
                        >
                          {pending === `confirm|${summary.classId}|${summary.label}|${contributorKey(suggestion.ref)}` ? (
                            'Saving…'
                          ) : (
                            <>
                              <Check size={11} /> Confirm
                            </>
                          )}
                        </button>
                        <span>
                          {nameOf(suggestion.ref)}{' '}
                          <span className="text-slate-400">· {BASIS_LABELS[suggestion.basis] ?? suggestion.basis} · {suggestion.count}</span>
                        </span>
                      </div>
                    ))}
                    {summary.unresolved > 0 && (
                      <div className="text-amber-700">
                        No match ({summary.unresolved})
                        {summary.flags.has('ambiguous') && ' · more than one person fits'}
                        {summary.flags.has('no-author-match') && ' · no page title in this class fits this name'}
                      </div>
                    )}
                    {summary.flags.has('cross-group') && <div className="text-slate-400">Commenter is outside the author's group</div>}
                  </td>
                  <td className="border-t border-slate-100 px-5 py-2">
                    <select
                      value=""
                      disabled={saving}
                      onChange={(event) => assign(summary, event.target.value)}
                      className="h-7 max-w-[14rem] rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-600 focus:border-indigo-300 focus:outline-none disabled:cursor-wait"
                    >
                      <option value="">{pending === `assign|${summary.classId}|${summary.label}` ? 'Saving…' : 'Choose…'}</option>
                      {(candidatesByClass.get(summary.classId) ?? []).map((candidate) => (
                        <option key={contributorKey(candidate.ref)} value={contributorKey(candidate.ref)}>
                          {candidate.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
                </React.Fragment>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="border-t border-slate-100 px-5 py-3 text-slate-400">
                    {needle ? 'No unconfirmed name matches that search.' : 'Every labelled name is confirmed.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t border-slate-100">
        <button
          type="button"
          onClick={() => setConfirmedOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left text-xs font-black text-slate-500"
        >
          Confirmed names
          <span className="flex items-center gap-2 text-slate-400">
            {aliases.length}
            <ChevronDown size={14} className={`transition-transform ${confirmedOpen ? '' : '-rotate-90'}`} />
          </span>
        </button>
        {confirmedOpen && aliases.length > 0 && (
          <ul className="space-y-1 px-5 pb-4 text-xs font-semibold text-slate-700">
            {[...aliases]
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((alias) => (
                <li key={`${alias.classId}|${alias.groupId ?? '*'}|${alias.label}`} className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => track(`remove|${alias.classId}|${alias.groupId ?? '*'}|${alias.label}`, () => onRemove(alias))}
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-red-600 disabled:cursor-wait"
                    title="Remove this confirmation"
                    aria-label={`Remove confirmation for ${alias.label}`}
                  >
                    <X size={12} />
                  </button>
                  <span className="font-black">{alias.label}</span> → {nameOf(alias.target)}
                  <span className="text-slate-400">
                    {alias.groupId ? `· ${groupNames.get(alias.groupId) ?? alias.groupId} only` : '· whole class'}
                    {multiClassAliases && ` · ${className(alias.classId)}`}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  );
};
