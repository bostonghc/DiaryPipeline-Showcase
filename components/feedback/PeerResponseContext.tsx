import React, { useState, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ParsedDiaryEntry } from '../../types';

export interface PeerResponseContextProps {
  entries?: ParsedDiaryEntry[] | null;
  currentEntryIndex?: number;
}

/**
 * Returns the count of prior entries that have at least one peer comment.
 * Use this for the FeedbackSection count badge — it is more meaningful than
 * a raw comment total because it conveys longitudinal breadth, not volume.
 */
export const priorEntriesWithPeerCount = (
  entries: ParsedDiaryEntry[] | null | undefined,
  currentEntryIndex: number | undefined
): number => {
  if (!entries) return 0;
  const cutoff = currentEntryIndex != null ? currentEntryIndex : entries.length;
  return entries.slice(0, cutoff).filter(e => e.peerFeedback && e.peerFeedback.length > 0).length;
};

export const PeerResponseContext: React.FC<PeerResponseContextProps> = ({ entries, currentEntryIndex }) => {
  const [historyOpen, setHistoryOpen] = useState(false);

  const priorEntries = useMemo(() => {
    if (!entries) return [];
    const cutoff = currentEntryIndex != null ? currentEntryIndex : entries.length;
    return entries.slice(0, cutoff);
  }, [entries, currentEntryIndex]);

  const recentWithPeer = useMemo(() => {
    const withPeer = priorEntries.filter(e => e.peerFeedback && e.peerFeedback.length > 0);
    return withPeer.slice(-3);
  }, [priorEntries]);

  const contributorTotals = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of priorEntries) {
      for (const fb of entry.peerFeedback || []) {
        const name = fb.contributor || 'Unspecified';
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [priorEntries]);

  if (priorEntries.length === 0) {
    return (
      <p className="text-xs text-slate-500 leading-relaxed italic">
        No prior entries — peer context will appear as the student builds their diary.
      </p>
    );
  }

  if (recentWithPeer.length === 0) {
    return (
      <p className="text-xs text-slate-500 leading-relaxed italic">
        No peer comments on prior entries yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Last 3 prior entries with peer comments */}
      <div className="space-y-3">
        {recentWithPeer.map((entry, idx) => (
          <div key={entry.id || idx}>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
              {entry.date || entry.weekNumber || `Entry ${idx + 1}`}
            </p>
            <div className="space-y-1.5">
              {entry.peerFeedback.slice(0, 2).map((fb, fbIdx) => (
                <div key={fbIdx} className="bg-slate-50 rounded-lg px-2.5 py-2 border border-slate-100">
                  <span className="text-[10px] font-bold text-indigo-500 mr-1.5">{fb.contributor || 'Unspecified'}</span>
                  <span className="text-[11px] text-slate-600 leading-relaxed">{fb.feedback}</span>
                </div>
              ))}
              {entry.peerFeedback.length > 2 && (
                <p className="text-[10px] text-slate-400 pl-1">
                  +{entry.peerFeedback.length - 2} more from {entry.peerFeedback.slice(2).map(f => f.contributor).join(', ')}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Full history: contributor totals + all prior entries */}
      {contributorTotals.length > 0 && (
        <div>
          <button
            onClick={() => setHistoryOpen(o => !o)}
            className="flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-slate-600 uppercase tracking-wider transition-colors"
          >
            <ChevronDown size={11} className={`transition-transform ${historyOpen ? '' : '-rotate-90'}`} />
            Full peer history
          </button>
          {historyOpen && (
            <div className="mt-2 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {contributorTotals.map(([name, count]) => (
                  <span key={name} className="inline-flex items-center gap-1 bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5 rounded-full">
                    {name} · {count}
                  </span>
                ))}
              </div>
              <div className="space-y-3">
                {priorEntries.filter(e => e.peerFeedback && e.peerFeedback.length > 0).map((entry, idx) => (
                  <div key={entry.id || idx}>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                      {entry.date || entry.weekNumber || `Entry ${idx + 1}`}
                    </p>
                    <div className="space-y-1">
                      {entry.peerFeedback.map((fb, fbIdx) => (
                        <div key={fbIdx} className="bg-slate-50 rounded-lg px-2.5 py-1.5 border border-slate-100">
                          <span className="text-[10px] font-bold text-indigo-500 mr-1.5">{fb.contributor || 'Unspecified'}</span>
                          <span className="text-[11px] text-slate-600 leading-relaxed">{fb.feedback}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
