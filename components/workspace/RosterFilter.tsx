import React from 'react';
import { Search, X } from 'lucide-react';

/** Type-to-filter box for the class roster, with a status line while filtering. */
export const RosterFilterInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
  shownCount: number;
  totalCount: number;
  hiddenSelectedCount: number;
}> = ({ value, onChange, shownCount, totalCount, hiddenSelectedCount }) => {
  const filtering = value.trim() !== '';
  return (
    <div className="mb-2 space-y-1.5">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape' && value) { event.stopPropagation(); onChange(''); } }}
          placeholder="Filter classes…"
          aria-label="Filter classes"
          autoComplete="off"
          className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-7 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="Clear filter"
            title="Clear filter"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-600"
          >
            <X size={13} />
          </button>
        )}
      </div>
      {filtering && (
        <p role="status" className="ml-1 text-[10px] text-slate-400">
          {shownCount} of {totalCount} shown
          {hiddenSelectedCount > 0 && (
            <span className="font-bold text-amber-600">
              {` · ${hiddenSelectedCount} selected ${hiddenSelectedCount === 1 ? 'class is' : 'classes are'} hidden by the filter`}
            </span>
          )}
        </p>
      )}
    </div>
  );
};

/**
 * Widens the roster to notebooks whose access is not confirmed. Separate from the
 * filter on purpose: this is about access, the filter is about names.
 */
export const RosterUnavailableToggle: React.FC<{
  on: boolean;
  count: number;
  onToggle: () => void;
}> = ({ on, count, onToggle }) => {
  const nothingToShow = !on && count === 0;
  const label = on ? 'Hide unavailable' : count > 0 ? `Show unavailable (${count})` : 'Show unavailable';
  const title = on
    ? 'Go back to listing only notebooks you can open.'
    : nothingToShow
      ? 'Every notebook found is already listed.'
      : `Also list ${count} ${count === 1 ? 'notebook' : 'notebooks'} you cannot open or whose access has not been confirmed.`;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={nothingToShow}
      aria-pressed={on}
      title={title}
      className={`shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-[9px] font-bold uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        on ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
      }`}
    >
      {label}
    </button>
  );
};

export const RosterGroupHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="ml-1 mt-3 mb-1 text-[10px] font-black uppercase tracking-widest text-slate-400 first:mt-0">{children}</p>
);

export const RosterNoMatches: React.FC<{ query: string; onClear: () => void }> = ({ query, onClear }) => (
  <p className="px-1 py-6 text-center text-xs text-slate-500">
    No classes match “{query.trim()}”.{' '}
    <button type="button" onClick={onClear} className="font-bold text-indigo-600 hover:text-indigo-700">Clear filter</button>
  </p>
);
