import React from 'react';
import { BookOpen, CheckCircle, LayoutGrid, Loader2, RefreshCw } from 'lucide-react';

interface NoPageSelectedStateProps {
  isSyncingClass: boolean;
  syncProgress: { current: number; total: number; status: string };
  syncingClassName: string | null;
  hasAnySyncedClass: boolean;
  selectedNotebookCount: number;
}

export const NoPageSelectedState: React.FC<NoPageSelectedStateProps> = ({
  isSyncingClass,
  syncProgress,
  syncingClassName,
  hasAnySyncedClass,
  selectedNotebookCount,
}) => {
  if (isSyncingClass) {
    const hasProgress = syncProgress.total > 0;
    const percentage = hasProgress
      ? Math.min(100, Math.round((syncProgress.current / syncProgress.total) * 100))
      : 0;

    return (
      <div className="h-full w-full flex flex-col items-center justify-center px-8 py-12 bg-slate-50/60">
        <div className="w-full max-w-md rounded-2xl border border-indigo-100 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
              <RefreshCw size={20} className="animate-spin" />
              <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-300 opacity-50 animate-ping" />
                <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-emerald-500 border-2 border-white" />
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
                Sync Queue Running
              </p>
              <h3 className="mt-1 text-base font-bold text-slate-900">
                {syncingClassName ? `Syncing ${syncingClassName}` : 'Syncing notebooks…'}
              </h3>
              <p className="mt-1 text-xs font-medium leading-relaxed text-slate-500 truncate">
                {syncProgress.status || 'Fetching and parsing student pages…'}
              </p>
              <div className="mt-4">
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                  {hasProgress ? (
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-[width] duration-300 ease-out"
                      style={{ width: `${percentage}%` }}
                    />
                  ) : (
                    <div className="h-full w-1/3 rounded-full bg-indigo-400 animate-pulse" />
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] font-bold text-slate-400">
                  <span className="flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" />
                    Keep this window open
                  </span>
                  {hasProgress && (
                    <span>{syncProgress.current} / {syncProgress.total} pages</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (selectedNotebookCount === 0) {
    return (
      <NextActionCard
        tone="muted"
        icon={<LayoutGrid size={20} />}
        iconClassName="bg-slate-100 text-slate-400"
        title="Select notebooks to work with"
        body="Choose one or more classes in the notebook panel on the left to load their student pages."
      />
    );
  }

  if (!hasAnySyncedClass) {
    return (
      <NextActionCard
        tone="indigo"
        icon={<BookOpen size={20} />}
        iconClassName="bg-indigo-50 text-indigo-600"
        title="Sync selected notebooks"
        body={`${selectedNotebookCount} notebook${selectedNotebookCount === 1 ? '' : 's'} selected but not yet synced. Use Sync All Selected in the notebook panel to fetch and save student pages.`}
      />
    );
  }

  return (
    <NextActionCard
      tone="emerald"
      icon={<CheckCircle size={20} />}
      iconClassName="bg-emerald-50 text-emerald-600"
      title="Select a student page to review"
      body="Click any page in the notebook tree to open it, review saved entries, and compose feedback."
    />
  );
};

type NextActionTone = 'muted' | 'indigo' | 'emerald';

interface NextActionCardProps {
  tone: NextActionTone;
  icon: React.ReactNode;
  iconClassName: string;
  title: string;
  body: string;
}

const NextActionCard: React.FC<NextActionCardProps> = ({ tone, icon, iconClassName, title, body }) => {
  const borderClass = {
    muted: 'border-slate-200',
    indigo: 'border-indigo-100',
    emerald: 'border-emerald-100',
  }[tone];

  return (
    <div className="h-full w-full flex flex-col items-center justify-center px-8 py-12 bg-slate-50/60">
      <div className={`w-full max-w-md rounded-2xl border ${borderClass} bg-white p-6 shadow-sm`}>
        <div className="flex items-start gap-4">
          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconClassName}`}>
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">
              Next Action
            </p>
            <h3 className="mt-1 text-base font-bold text-slate-900">
              {title}
            </h3>
            <p className="mt-1 text-sm font-medium leading-relaxed text-slate-500">
              {body}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
