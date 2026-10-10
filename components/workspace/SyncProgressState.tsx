import React from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

interface SyncProgressStateProps {
  title?: string;
  message?: string;
  current?: number;
  total?: number;
  status?: string;
}

export const SyncProgressState: React.FC<SyncProgressStateProps> = ({
  title = 'Syncing notebook structure',
  message = 'Fetching pages, rosters, and saved feedback state.',
  current = 0,
  total = 0,
  status,
}) => {
  const hasProgress = total > 0;
  const percentage = hasProgress ? Math.min(100, Math.round((current / total) * 100)) : 0;

  return (
    <div className="flex-1 min-h-full flex items-center justify-center px-6 py-12 bg-slate-50">
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
            <RefreshCw size={22} className="animate-spin" />
            <span className="absolute -right-1 -top-1 flex h-4 w-4">
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-300 opacity-50 animate-ping" />
              <span className="relative inline-flex h-4 w-4 rounded-full bg-emerald-500 border-2 border-white" />
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">
                  OneNote Sync
                </p>
                <h2 className="mt-1 text-xl font-bold tracking-tight text-slate-900">
                  {title}
                </h2>
              </div>
              {hasProgress && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">
                  {current}/{total}
                </span>
              )}
            </div>

            <p className="mt-3 text-sm font-medium leading-relaxed text-slate-500">
              {status || message}
            </p>

            <div className="mt-6">
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                {hasProgress ? (
                  <div
                    className="h-full rounded-full bg-indigo-500 transition-[width] duration-300 ease-out"
                    style={{ width: `${percentage}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 rounded-full bg-indigo-500 animate-pulse" />
                )}
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] font-bold text-slate-400">
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  Working
                </span>
                {hasProgress && <span>{percentage}%</span>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
