import React from 'react';

// Small presentational pieces shared by the Class Dashboard tabs.

export const formatPercent = (count: number, total: number): string =>
  total === 0 ? '0%' : `${Math.round((count / total) * 100)}%`;

export const FilterSelect: React.FC<{
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</span>
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs font-bold text-slate-600 shadow-sm focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
    >
      {options.map(([optionValue, optionLabel]) => (
        <option key={optionValue} value={optionValue}>{optionLabel}</option>
      ))}
    </select>
  </label>
);

export const MetricTile: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: 'slate' | 'amber' | 'emerald' | 'indigo';
}> = ({ icon, label, value, detail, tone = 'slate' }) => (
  <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
    <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
      tone === 'amber'
        ? 'bg-amber-50 text-amber-600'
        : tone === 'emerald'
          ? 'bg-emerald-50 text-emerald-600'
          : tone === 'indigo'
            ? 'bg-indigo-50 text-indigo-600'
            : 'bg-slate-100 text-slate-600'
    }`}>
      {icon}
    </div>
    <div className="min-w-0">
      <p className="truncate text-[9px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
        <p className="text-2xl font-black leading-none tracking-tight text-slate-900">{value}</p>
        <p className="truncate text-xs font-semibold text-slate-500">{detail}</p>
      </div>
    </div>
  </div>
);
