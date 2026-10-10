import React from 'react';
import {
  Activity,
  AlertCircle,
  BookOpen,
  BrainCircuit,
  Database,
  Key,
  LogOut,
  RefreshCw,
  Search,
  ShieldCheck,
  WifiOff,
  Zap,
} from 'lucide-react';
import type { EducationClass } from '../../types';

type NextActionTone = 'primary' | 'indigo' | 'amber' | 'muted';

interface NextActionModel {
  title: string;
  body: string;
  actionLabel?: string;
  actionIcon?: React.ReactNode;
  onAction?: () => void | Promise<void>;
  disabled?: boolean;
  tone: NextActionTone;
}

interface WorkspaceHomeProps {
  account: any | null;
  firebaseUser: unknown | null;
  firebaseProjectId: string;
  hasGeminiKey: boolean;
  isConfigured: boolean;
  isSandbox: boolean;
  isInteracting: boolean;
  isCheckingAuth: boolean;
  loading: boolean;
  loadingStep: string;
  classes: EducationClass[];
  selectedNotebookCount: number;
  onSelectKey: () => void;
  onLogin: () => void;
  onLogout: () => void | Promise<void>;
  onFirebaseLogin: () => void | Promise<void>;
  onFirebaseLogout: () => void | Promise<void>;
  onDiscoverAll: () => void | Promise<void>;
  onSyncSelected: () => void | Promise<void>;
}

export const WorkspaceHome: React.FC<WorkspaceHomeProps> = ({
  account,
  firebaseUser,
  firebaseProjectId,
  hasGeminiKey,
  isConfigured,
  isSandbox,
  isInteracting,
  isCheckingAuth,
  loading,
  loadingStep,
  classes,
  selectedNotebookCount,
  onSelectKey,
  onLogin,
  onLogout,
  onFirebaseLogin,
  onFirebaseLogout,
  onDiscoverAll,
  onSyncSelected,
}) => {
  const syncedCount = classes.filter((cls) => cls.lastSynced).length;
  const discoveredCount = classes.length;
  const needsDiscovery = classes.length === 0;
  const nextAction = getWorkspaceNextAction({
    account,
    firebaseUser,
    hasGeminiKey,
    isConfigured,
    isSandbox,
    isInteracting,
    isCheckingAuth,
    loading,
    loadingStep,
    needsDiscovery,
    selectedNotebookCount,
    onSelectKey,
    onLogin,
    onFirebaseLogin,
    onDiscoverAll,
    onSyncSelected,
  });

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-6 py-8 lg:px-10">
      <header className="flex flex-col gap-5 border-b border-slate-200 pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-bold text-slate-500 shadow-sm">
            <span className={`h-2 w-2 rounded-full ${account ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            {account ? 'Session active' : isSandbox ? 'Sandbox preview' : 'Not connected'}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-sm">
              <BookOpen size={22} />
            </div>
            <div className="min-w-0">
              <h2 className="text-3xl font-bold tracking-tight text-slate-950">Journaler</h2>
              <p className="mt-1 text-sm font-bold text-slate-700">
                Journal Feedback and Research Tool
              </p>
              <p className="mt-1 max-w-2xl text-sm font-medium leading-relaxed text-slate-500">
                Review Class Notebook diaries, preserve saved feedback, and sync only the rosters you need.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm sm:min-w-80">
          <Metric label="Discovered" value={discoveredCount} />
          <Metric label="Sync recorded" value={syncedCount} />
          <Metric label="Selected" value={selectedNotebookCount} />
        </div>
      </header>

      <main className="grid flex-1 content-start gap-5 py-6 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="space-y-5">
          {!hasGeminiKey && (
            <Notice
              tone="indigo"
              icon={<BrainCircuit size={18} />}
              title="AI key required"
              body="Select your Gemini API key before generating semantic summaries or feedback drafts."
              actionLabel="Select Gemini Key"
              actionIcon={<Key size={14} />}
              onAction={onSelectKey}
            />
          )}

          {!isConfigured && (
            <Notice
              tone="amber"
              icon={<AlertCircle size={18} />}
              title="Setup required"
              body="Backend environment variables are missing. Configure ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET."
            />
          )}

          <WorkspaceNextAction action={nextAction} />
        </section>

        <aside className="grid gap-4">
          <ConnectionPanel
            icon={<ShieldCheck size={18} />}
            iconClassName="bg-indigo-50 text-indigo-600"
            label="Microsoft Session"
            title={account ? account.name || account.username : 'Not connected'}
            statusLabel={account ? 'Connected' : isCheckingAuth ? 'Checking' : 'Disconnected'}
            statusTone={account ? 'connected' : isCheckingAuth ? 'pending' : 'idle'}
            body="Used for notebook discovery, page fetches, and sending feedback."
            meta={account?.username}
            actionLabel={
              account
                ? 'Disconnect Microsoft'
                : isInteracting
                  ? 'Awaiting Microsoft...'
                  : isCheckingAuth
                    ? 'Checking Session...'
                    : 'Connect Microsoft'
            }
            actionTone={account ? 'danger' : 'primary'}
            actionIcon={account ? <LogOut size={14} /> : <WifiOff size={14} />}
            busy={!account && (isInteracting || isCheckingAuth)}
            disabled={!account && (isInteracting || isCheckingAuth)}
            onAction={account ? onLogout : onLogin}
          />

          <ConnectionPanel
            icon={<Database size={18} />}
            iconClassName="bg-emerald-50 text-emerald-600"
            label="Saved Records"
            title={firebaseUser ? 'Firestore connected' : 'Firestore not connected'}
            statusLabel={firebaseUser ? 'Connected' : 'Disconnected'}
            statusTone={firebaseUser ? 'connected' : 'idle'}
            body="Stores feedback drafts, Feedback Ready records, and past feedback history across sessions."
            meta={`Project: ${firebaseProjectId}`}
            actionLabel={firebaseUser ? 'Disconnect Firestore' : 'Connect Firestore'}
            actionTone={firebaseUser ? 'danger' : 'primary'}
            actionIcon={<Database size={14} />}
            onAction={firebaseUser ? onFirebaseLogout : onFirebaseLogin}
          />
        </aside>
      </main>
    </div>
  );
};

interface WorkspaceNextActionInput {
  account: any | null;
  firebaseUser: unknown | null;
  hasGeminiKey: boolean;
  isConfigured: boolean;
  isSandbox: boolean;
  isInteracting: boolean;
  isCheckingAuth: boolean;
  loading: boolean;
  loadingStep: string;
  needsDiscovery: boolean;
  selectedNotebookCount: number;
  onSelectKey: () => void;
  onLogin: () => void;
  onFirebaseLogin: () => void | Promise<void>;
  onDiscoverAll: () => void | Promise<void>;
  onSyncSelected: () => void | Promise<void>;
}

const getWorkspaceNextAction = ({
  account,
  firebaseUser,
  hasGeminiKey,
  isConfigured,
  isSandbox,
  isInteracting,
  isCheckingAuth,
  loading,
  loadingStep,
  needsDiscovery,
  selectedNotebookCount,
  onSelectKey,
  onLogin,
  onFirebaseLogin,
  onDiscoverAll,
  onSyncSelected,
}: WorkspaceNextActionInput): NextActionModel => {
  if (loading) {
    return {
      title: loadingStep || 'Working on notebook discovery',
      body: 'Keep this window open while the roster list refreshes.',
      tone: 'indigo',
    };
  }

  if (!isConfigured) {
    return {
      title: 'Complete backend setup',
      body: 'Server-side Entra configuration is required before tenant notebooks can be discovered.',
      tone: 'amber',
    };
  }

  if (!account && !isSandbox) {
    return {
      title: isCheckingAuth ? 'Checking Microsoft session' : 'Connect Microsoft',
      body: isCheckingAuth
        ? 'The app is looking for an existing session before asking you to sign in again.'
        : 'Sign in first so Journaler can discover Class Notebooks and fetch pages.',
      actionLabel: isCheckingAuth ? undefined : isInteracting ? 'Awaiting Microsoft...' : 'Connect Microsoft',
      actionIcon: isInteracting ? <RefreshCw size={16} className="animate-spin" /> : <ShieldCheck size={16} />,
      onAction: isCheckingAuth ? undefined : onLogin,
      disabled: isInteracting,
      tone: 'primary',
    };
  }

  if (!firebaseUser) {
    return {
      title: 'Connect saved records',
      body: 'Connect Firestore so drafts, Feedback Ready records, and exports persist across sessions.',
      actionLabel: 'Connect Firestore',
      actionIcon: <Database size={16} />,
      onAction: onFirebaseLogin,
      tone: 'primary',
    };
  }

  if (!hasGeminiKey) {
    return {
      title: 'Select the AI key',
      body: 'Choose the Gemini key before generating summaries or feedback drafts.',
      actionLabel: 'Select Gemini Key',
      actionIcon: <Key size={16} />,
      onAction: onSelectKey,
      tone: 'indigo',
    };
  }

  if (needsDiscovery) {
    return {
      title: 'Find notebooks for this workspace',
      body: 'Discovery refreshes the roster list without fetching every page.',
      actionLabel: isSandbox ? 'Preview Sandbox' : 'Discover Notebooks',
      actionIcon: isSandbox ? <Zap size={16} /> : <Search size={16} />,
      onAction: onDiscoverAll,
      tone: isSandbox ? 'amber' : 'primary',
    };
  }

  if (selectedNotebookCount === 0) {
    return {
      title: 'Select notebooks to load',
      body: 'Use the notebook panel on the left to choose the rosters you want to process.',
      tone: 'muted',
    };
  }

  return {
    title: 'Load the selected notebooks',
    body: `${selectedNotebookCount} notebook${selectedNotebookCount === 1 ? '' : 's'} selected. Load to browse the page tree, then use Sync All Selected to save content.`,
    actionLabel: 'Load Notebooks',
    actionIcon: <Activity size={16} />,
    onAction: onSyncSelected,
    tone: 'indigo',
  };
};

interface WorkspaceNextActionProps {
  action: NextActionModel;
}

const WorkspaceNextAction: React.FC<WorkspaceNextActionProps> = ({ action }) => {
  const toneClass = {
    primary: 'border-slate-200 bg-white',
    indigo: 'border-indigo-100 bg-indigo-50/60',
    amber: 'border-amber-200 bg-amber-50',
    muted: 'border-slate-100 bg-slate-50',
  }[action.tone];
  const buttonClass = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800',
    indigo: 'bg-indigo-600 text-white hover:bg-indigo-700',
    amber: 'bg-amber-500 text-white hover:bg-amber-600',
    muted: 'bg-slate-100 text-slate-400 cursor-not-allowed',
  }[action.tone];

  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${toneClass}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">
            Next Action
          </p>
          <h3 className="mt-1 text-lg font-bold text-slate-900">{action.title}</h3>
          <p className="mt-1 text-sm font-medium leading-relaxed text-slate-500">{action.body}</p>
        </div>

        {action.actionLabel && action.onAction && (
          <button
            onClick={action.onAction}
            disabled={action.disabled}
            className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 ${buttonClass}`}
          >
            {action.actionIcon}
            {action.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
};

interface MetricProps {
  label: string;
  value: number;
}

const Metric: React.FC<MetricProps> = ({ label, value }) => (
  <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-center">
    <p className="text-base font-black leading-none text-slate-900">{value}</p>
    <p className="mt-1 truncate text-[9px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
  </div>
);

interface NoticeProps {
  tone: 'indigo' | 'amber';
  icon: React.ReactNode;
  title: string;
  body: string;
  actionLabel?: string;
  actionIcon?: React.ReactNode;
  onAction?: () => void;
}

const Notice: React.FC<NoticeProps> = ({ tone, icon, title, body, actionLabel, actionIcon, onAction }) => {
  const toneClass =
    tone === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-indigo-200 bg-indigo-50 text-indigo-800';

  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">{title}</p>
          <p className="mt-1 text-xs font-medium leading-relaxed opacity-80">{body}</p>
          {actionLabel && onAction && (
            <button
              onClick={onAction}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-white/80 px-3 py-2 text-xs font-bold shadow-sm transition-colors hover:bg-white"
            >
              {actionIcon}
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface ConnectionPanelProps {
  icon: React.ReactNode;
  iconClassName: string;
  label: string;
  title: string;
  statusLabel: string;
  statusTone: 'connected' | 'pending' | 'idle';
  body: string;
  meta?: string;
  actionLabel: string;
  actionTone: 'primary' | 'danger' | 'success';
  actionIcon: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
  onAction: () => void | Promise<void>;
}

const ConnectionPanel: React.FC<ConnectionPanelProps> = ({
  icon,
  iconClassName,
  label,
  title,
  statusLabel,
  statusTone,
  body,
  meta,
  actionLabel,
  actionTone,
  actionIcon,
  busy,
  disabled,
  onAction,
}) => {
  const actionClass = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800',
    danger: 'bg-red-50 text-red-700 hover:bg-red-100',
    success: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
  }[actionTone];
  const statusClass = {
    connected: 'bg-emerald-50 text-emerald-700',
    pending: 'bg-indigo-50 text-indigo-700',
    idle: 'bg-slate-100 text-slate-500',
  }[statusTone];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconClassName}`}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-black uppercase tracking-widest text-slate-400">{label}</p>
          <p className="mt-1 truncate text-sm font-bold text-slate-900">{title}</p>
        </div>
        <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${statusClass}`}>
          {statusLabel}
        </span>
      </div>
      <p className="mt-4 text-sm font-medium leading-relaxed text-slate-500">{body}</p>
      {meta && <p className="mt-3 truncate text-xs font-medium text-slate-500">{meta}</p>}
      <button
        onClick={onAction}
        disabled={disabled}
        className={`mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 ${actionClass}`}
      >
        {busy ? <RefreshCw size={14} className="animate-spin" /> : actionIcon}
        {actionLabel}
      </button>
    </div>
  );
};
