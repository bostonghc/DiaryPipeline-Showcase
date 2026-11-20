import React from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { isDateWeekConflict } from '../../services/diaryEntryOrder';

/** Keep date/week conflicts visible even after the entry's feedback is ready. */
export const EntryWarnings: React.FC<{
  warnings?: string[];
  ready: boolean;
  onReparse: () => void;
  canReparse: boolean;
}> = ({ warnings = [], ready, onReparse, canReparse }) => {
  const visible = ready ? warnings.filter(isDateWeekConflict) : warnings;
  if (!visible.length) return null;
  return (
    <details className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <summary className="cursor-pointer text-xs font-bold text-amber-800">
        <AlertTriangle size={12} className="mr-1.5 inline" />
        {visible.length} {visible.length === 1 ? 'entry warning' : 'entry warnings'}
      </summary>
      <ul className="mt-3 space-y-1 text-sm text-amber-900">
        {visible.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>
      {!ready && visible.some(warning => !isDateWeekConflict(warning)) && (
        <button onClick={onReparse} disabled={!canReparse}
          className="mt-3 inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
          title="Re-parse this page with AI">
          <Sparkles size={12} /> Re-parse with AI
        </button>
      )}
    </details>
  );
};
