import React from 'react';
import {
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Copy,
  Database,
  EyeOff,
  Filter,
  KeyRound,
  Link2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import { DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS } from '../../services/prompts';
import { getReadTotals, resetReadMeter } from '../../services/readMeter';
import type { UserConfig, UserPreferences } from '../../types';

interface MachineConfig {
  filterStrings: string[];
  syncFrequency: UserConfig['syncFrequency'];
  syncBatchSize: number;
  syncDelayBetweenBatches: number;
}

interface ConnectionState {
  microsoftSignedIn: boolean;
  microsoftLabel: string | null;
  firebaseSignedIn: boolean;
  firebaseLabel: string | null;
  firebaseProjectId: string;
  hasGeminiKey: boolean;
}

interface RuntimeConfigStatus {
  runtime: {
    nodeEnv: string;
    appUrlSet: boolean;
    appUrlHost: string | null;
  };
  entra: {
    clientIdSet: boolean;
    tenantIdSet: boolean;
    clientSecretSet: boolean;
    tenantIdLabel: string;
  };
  session: {
    secretSet: boolean;
  };
  ai: {
    geminiApiKeySet: boolean;
  };
  firebase: {
    configFilePresent: boolean;
    projectIdSet: boolean;
    authDomainSet: boolean;
    firestoreDatabaseIdSet: boolean;
    projectId: string | null;
    firestoreDatabaseId: string | null;
  };
}

interface Props {
  machineConfig: MachineConfig;
  setMachineConfig: React.Dispatch<React.SetStateAction<MachineConfig>>;
  preferences: Required<UserPreferences>;
  savePref: (updates: Partial<UserPreferences>) => Promise<void>;
  config: { isSandbox: boolean };
  setConfig: React.Dispatch<React.SetStateAction<{ isSandbox: boolean }>>;
  connectionState: ConnectionState;
  onMicrosoftLogin: () => void | Promise<void>;
  onMicrosoftLogout: () => void | Promise<void>;
  onFirebaseLogin: () => void | Promise<void>;
  onFirebaseLogout: () => void | Promise<void>;
  onSelectGeminiKey: () => void | Promise<void>;
  addLog: (msg: string) => void;
  logs: string[];
  setLogs: React.Dispatch<React.SetStateAction<string[]>>;
  onSaveLog: () => void;
  showDebugStream: boolean;
  setShowDebugStream: React.Dispatch<React.SetStateAction<boolean>>;
  isInteracting: boolean;
  hasDebugActivity: boolean;
  onClose: () => void;
}

type SettingsTab = 'connections' | 'runtime' | 'workflow' | 'ai' | 'prompts';

type EditablePrefs = Pick<
  UserPreferences,
  'feedbackTone' | 'teacherDisplayName' | 'customSignOff' | 'aiModelFeedback' | 'aiModelParsing' | 'aiPrompts'
>;

type FeedbackPromptKey = keyof NonNullable<UserPreferences['aiPrompts']>;

const sectionClass = 'bg-white rounded-xl p-5 border border-slate-200 shadow-sm';
const sectionIconClass = 'w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center text-indigo-600';
const sectionTitleClass = 'text-[11px] font-black text-slate-700 uppercase tracking-widest';
const descriptionClass = 'text-[11px] text-slate-500 font-medium leading-relaxed';
const labelClass = 'text-[10px] font-black text-slate-500 uppercase tracking-wider';
const controlClass = 'w-full p-3 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  { id: 'connections', label: 'Connections', icon: <Cloud size={14} /> },
  { id: 'runtime', label: 'Runtime Config', icon: <KeyRound size={14} /> },
  { id: 'workflow', label: 'Workflow', icon: <SlidersHorizontal size={14} /> },
  { id: 'ai', label: 'AI Models', icon: <BrainCircuit size={14} /> },
  { id: 'prompts', label: 'Prompts', icon: <Wand2 size={14} /> },
];

const makeDraft = (p: Required<UserPreferences>): EditablePrefs => ({
  feedbackTone: p.feedbackTone,
  teacherDisplayName: p.teacherDisplayName,
  customSignOff: p.customSignOff,
  aiModelFeedback: p.aiModelFeedback,
  aiModelParsing: p.aiModelParsing,
  aiPrompts: { ...p.aiPrompts },
});

const countTrue = (values: boolean[]) => values.filter(Boolean).length;

export const SettingsModal: React.FC<Props> = ({
  machineConfig,
  setMachineConfig,
  preferences,
  savePref,
  config,
  setConfig,
  connectionState,
  onMicrosoftLogin,
  onMicrosoftLogout,
  onFirebaseLogin,
  onFirebaseLogout,
  onSelectGeminiKey,
  addLog,
  logs,
  setLogs,
  onSaveLog,
  showDebugStream,
  setShowDebugStream,
  isInteracting,
  hasDebugActivity,
  onClose,
}) => {
  const [activeTab, setActiveTab] = React.useState<SettingsTab>('connections');
  const [runtimeStatus, setRuntimeStatus] = React.useState<RuntimeConfigStatus | null>(null);
  const [runtimeError, setRuntimeError] = React.useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = React.useState(true);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<EditablePrefs>(() => makeDraft(preferences));
  const [saving, setSaving] = React.useState(false);
  const [justSaved, setJustSaved] = React.useState(false);

  // Live Firestore read count for the debug stream. Polled (not pushed) and only
  // while the stream is open, so a burst of reads never triggers re-renders.
  const [readStats, setReadStats] = React.useState(() => getReadTotals());
  React.useEffect(() => {
    if (!showDebugStream) return;
    setReadStats(getReadTotals());
    const id = window.setInterval(() => setReadStats(getReadTotals()), 1000);
    return () => window.clearInterval(id);
  }, [showDebugStream]);
  const resetReads = () => {
    resetReadMeter();
    setReadStats(getReadTotals());
  };
  const readsSince = new Date(readStats.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  React.useEffect(() => {
    setDraft(makeDraft(preferences));
  }, [preferences]);

  const loadRuntimeStatus = React.useCallback(async () => {
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      const response = await fetch('/api/config/status');
      if (!response.ok) throw new Error(`Config status request failed (${response.status})`);
      const data = await response.json() as RuntimeConfigStatus;
      setRuntimeStatus(data);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadRuntimeStatus();
  }, [loadRuntimeStatus]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(makeDraft(preferences));
  const aiPrompts = draft.aiPrompts;

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      setCopiedKey(null);
    }
  };

  const handleSavePreferences = async () => {
    setSaving(true);
    try {
      await savePref(draft);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const redirectUri = `${window.location.origin}/auth/callback`;
  const entraConfigured = runtimeStatus
    ? runtimeStatus.entra.clientIdSet && runtimeStatus.entra.tenantIdSet && runtimeStatus.entra.clientSecretSet
    : false;
  const firebaseConfigured = runtimeStatus
    ? runtimeStatus.firebase.configFilePresent && runtimeStatus.firebase.projectIdSet && runtimeStatus.firebase.authDomainSet
    : Boolean(connectionState.firebaseProjectId);
  const geminiConfigured = runtimeStatus
    ? runtimeStatus.ai.geminiApiKeySet || connectionState.hasGeminiKey
    : connectionState.hasGeminiKey;
  const requiredConfigured = runtimeStatus
    ? countTrue([
        runtimeStatus.runtime.appUrlSet,
        runtimeStatus.entra.clientIdSet,
        runtimeStatus.entra.tenantIdSet,
        runtimeStatus.entra.clientSecretSet,
        runtimeStatus.session.secretSet,
        runtimeStatus.ai.geminiApiKeySet,
        runtimeStatus.firebase.configFilePresent,
        runtimeStatus.firebase.projectIdSet,
        runtimeStatus.firebase.authDomainSet,
      ])
    : 0;

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-5xl w-full flex flex-col animate-in zoom-in duration-200 max-h-[90vh] overflow-hidden relative">
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-500 transition-colors z-20"
          title="Close Settings"
        >
          <X size={20} />
        </button>

        <div className="flex-1 p-6 md:p-8 overflow-y-auto bg-slate-50/40">
          <div className="flex flex-col gap-4 mb-6">
            <div className="flex items-start justify-between gap-4 pr-12">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-12 h-12 bg-indigo-600 text-white rounded-xl flex items-center justify-center shadow-sm">
                  <ShieldCheck size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-black tracking-tight text-slate-900">Settings & Connections</h3>
                  <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">
                    Setup status, workflow, and AI behavior
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowDebugStream(prev => !prev)}
                className={`shrink-0 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-colors ${
                  showDebugStream
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:text-slate-800'
                }`}
              >
                <ChevronRight size={14} className={`transition-transform ${showDebugStream ? 'rotate-90' : ''}`} />
                <Terminal size={14} />
                Debug Stream
                {hasDebugActivity && (
                  <span className={`inline-flex h-2.5 w-2.5 rounded-full ${isInteracting ? 'bg-emerald-400 animate-pulse' : 'bg-indigo-400'}`} />
                )}
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {SETTINGS_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-black transition-colors ${
                    activeTab === tab.id
                      ? 'border-slate-300 bg-white text-slate-900 shadow-sm'
                      : 'border-slate-200 bg-white/70 text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {showDebugStream && (
              <div className="rounded-xl bg-slate-900 border border-slate-800 overflow-hidden shadow-sm">
                <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-4">
                  <div>
                    <h4 className="text-[10px] font-black text-slate-300 uppercase tracking-widest flex items-center gap-2">
                      <Terminal size={14} /> Handshake Stream
                    </h4>
                    <p className="text-[10px] text-slate-500 mt-2">Development diagnostics for auth, popup handshakes, and connection events.</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={resetReads}
                      title="Firestore document reads counted since this time — click to reset the window"
                      className="text-[10px] font-bold uppercase tracking-wider text-slate-400 tabular-nums hover:text-white transition-colors"
                    >
                      {readStats.total.toLocaleString()} reads · since {readsSince}
                    </button>
                    <button type="button" onClick={onSaveLog} className="text-[10px] text-slate-500 font-bold uppercase hover:text-white transition-colors">Save</button>
                    <button type="button" onClick={() => setLogs([])} className="text-[10px] text-slate-500 font-bold uppercase hover:text-white transition-colors">Clear</button>
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto p-5 font-mono text-[11px] text-indigo-300 space-y-2 no-scrollbar">
                  {logs.length === 0 ? (
                    <p className="text-slate-600 italic opacity-60">Monitoring network...</p>
                  ) : (
                    logs.map((log, i) => (
                      <p key={i} className="leading-relaxed border-b border-white/5 pb-2 break-all">{log}</p>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {activeTab === 'connections' && (
            <ConnectionsTab
              connectionState={connectionState}
              entraConfigured={entraConfigured}
              firebaseConfigured={firebaseConfigured}
              geminiConfigured={geminiConfigured}
              runtimeLoading={runtimeLoading}
              runtimeError={runtimeError}
              runtimeStatus={runtimeStatus}
              redirectUri={redirectUri}
              copiedKey={copiedKey}
              onCopy={copyText}
              onRefreshStatus={loadRuntimeStatus}
              onMicrosoftLogin={onMicrosoftLogin}
              onMicrosoftLogout={onMicrosoftLogout}
              onFirebaseLogin={onFirebaseLogin}
              onFirebaseLogout={onFirebaseLogout}
              onSelectGeminiKey={onSelectGeminiKey}
            />
          )}

          {activeTab === 'runtime' && (
            <RuntimeConfigTab
              status={runtimeStatus}
              loading={runtimeLoading}
              error={runtimeError}
              requiredConfigured={requiredConfigured}
              copiedKey={copiedKey}
              onCopy={copyText}
              onRefresh={loadRuntimeStatus}
            />
          )}

          {activeTab === 'workflow' && (
            <WorkflowTab
              machineConfig={machineConfig}
              setMachineConfig={setMachineConfig}
              config={config}
              setConfig={setConfig}
              addLog={addLog}
            />
          )}

          {activeTab === 'ai' && (
            <AiModelsTab draft={draft} setDraft={setDraft} />
          )}

          {activeTab === 'prompts' && (
            <PromptsTab aiPrompts={aiPrompts} setDraft={setDraft} />
          )}
        </div>

        <div className="border-t border-slate-200 px-6 md:px-8 py-4 flex items-center justify-between bg-white">
          <span className="text-[11px] font-medium text-slate-400">
            {justSaved
              ? 'Preferences saved'
              : isDirty
                ? 'Unsaved preference changes'
                : activeTab === 'runtime'
                  ? 'Runtime config is read-only here'
                  : 'Preferences up to date'}
          </span>
          <button
            onClick={handleSavePreferences}
            disabled={!isDirty || saving}
            className="px-5 py-2.5 rounded-xl text-xs font-bold transition-colors bg-indigo-600 hover:bg-indigo-700 text-white disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save Preferences'}
          </button>
        </div>
      </div>
    </div>
  );
};

const ConnectionsTab: React.FC<{
  connectionState: ConnectionState;
  entraConfigured: boolean;
  firebaseConfigured: boolean;
  geminiConfigured: boolean;
  runtimeLoading: boolean;
  runtimeError: string | null;
  runtimeStatus: RuntimeConfigStatus | null;
  redirectUri: string;
  copiedKey: string | null;
  onCopy: (key: string, value: string) => void;
  onRefreshStatus: () => void;
  onMicrosoftLogin: () => void | Promise<void>;
  onMicrosoftLogout: () => void | Promise<void>;
  onFirebaseLogin: () => void | Promise<void>;
  onFirebaseLogout: () => void | Promise<void>;
  onSelectGeminiKey: () => void | Promise<void>;
}> = ({
  connectionState,
  entraConfigured,
  firebaseConfigured,
  geminiConfigured,
  runtimeLoading,
  runtimeError,
  runtimeStatus,
  redirectUri,
  copiedKey,
  onCopy,
  onRefreshStatus,
  onMicrosoftLogin,
  onMicrosoftLogout,
  onFirebaseLogin,
  onFirebaseLogout,
  onSelectGeminiKey,
}) => {
  const canSelectGeminiKey = Boolean(window.aistudio?.openSelectKey);
  return (
    <div className="space-y-5">
      <section className="grid gap-4 lg:grid-cols-2">
        <ConnectionCard
          icon={<ShieldCheck size={18} />}
          title="Microsoft Entra"
          subtitle="Notebook discovery, Graph access, email, and Teams delivery"
          configured={entraConfigured}
          connected={connectionState.microsoftSignedIn}
          connectedLabel="Connected"
          details={[
            ['Signed in', connectionState.microsoftLabel || 'Not signed in'],
            ['Client ID', runtimeStatus?.entra.clientIdSet ? 'Configured' : 'Missing'],
            ['Tenant', runtimeStatus?.entra.tenantIdSet ? runtimeStatus.entra.tenantIdLabel : 'Missing'],
            ['Client secret', runtimeStatus?.entra.clientSecretSet ? 'Configured server-side' : 'Missing'],
          ]}
          actionLabel={connectionState.microsoftSignedIn ? 'Disconnect' : 'Sign in'}
          actionDisabled={!entraConfigured && !connectionState.microsoftSignedIn}
          onAction={connectionState.microsoftSignedIn ? onMicrosoftLogout : onMicrosoftLogin}
        />

        <ConnectionCard
          icon={<Database size={18} />}
          title="Firebase Firestore & Auth"
          subtitle="Saved records, roster persistence, preferences, and dashboard data"
          configured={firebaseConfigured}
          connected={connectionState.firebaseSignedIn}
          connectedLabel="Connected"
          details={[
            ['Signed in', connectionState.firebaseLabel || 'Not signed in'],
            ['Project', runtimeStatus?.firebase.projectId || connectionState.firebaseProjectId || 'Not loaded'],
            ['Auth domain', runtimeStatus?.firebase.authDomainSet ? 'Configured' : 'Missing'],
            ['Database', runtimeStatus?.firebase.firestoreDatabaseId || 'default'],
          ]}
          actionLabel={connectionState.firebaseSignedIn ? 'Disconnect' : 'Connect'}
          actionDisabled={!firebaseConfigured && !connectionState.firebaseSignedIn}
          onAction={connectionState.firebaseSignedIn ? onFirebaseLogout : onFirebaseLogin}
        />

        <ConnectionCard
          icon={<BrainCircuit size={18} />}
          title="Gemini AI"
          subtitle="AI parsing fallback, feedback drafting, and semantic summaries"
          configured={geminiConfigured}
          connected={geminiConfigured}
          connectedLabel={geminiConfigured ? 'API key available' : 'API key missing'}
          details={[
            ['Parsing model', 'Gemini model selected below'],
            ['Feedback model', 'Gemini model selected below'],
            ['Secret location', canSelectGeminiKey ? 'AI Studio key selector' : '.env.local or deployment env'],
          ]}
          actionLabel={canSelectGeminiKey ? 'Select key' : 'Read-only'}
          actionDisabled={!canSelectGeminiKey}
          onAction={onSelectGeminiKey}
        />

        <ConnectionCard
          icon={<Cloud size={18} />}
          title="Email & Teams"
          subtitle="Delivery uses the active Microsoft Graph session"
          configured={entraConfigured}
          connected={connectionState.microsoftSignedIn}
          connectedLabel={connectionState.microsoftSignedIn ? 'Graph session active' : 'Sign in with Microsoft'}
          details={[
            ['Mail.Send', 'Requested during Entra sign-in'],
            ['Chat.Create', 'Requested during Entra sign-in'],
            ['Chat.ReadWrite', 'Requested during Entra sign-in'],
          ]}
          actionLabel={connectionState.microsoftSignedIn ? 'Disconnect Microsoft' : 'Sign in'}
          actionDisabled={!entraConfigured && !connectionState.microsoftSignedIn}
          onAction={connectionState.microsoftSignedIn ? onMicrosoftLogout : onMicrosoftLogin}
        />
      </section>

      <section className={sectionClass}>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className={sectionIconClass}>
                <Link2 size={16} />
              </div>
              <span className={sectionTitleClass}>Redirect URI</span>
            </div>
            <p className={descriptionClass}>
              Microsoft Entra requires this exact callback path for the current app origin.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onRefreshStatus()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-800"
          >
            <RefreshCw size={13} className={runtimeLoading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-[10px] text-slate-700">
            {redirectUri}
          </code>
          <button
            type="button"
            onClick={() => onCopy('redirect-uri', redirectUri)}
            className="rounded-lg border border-slate-200 bg-white p-3 text-slate-500 hover:text-slate-900"
            title="Copy redirect URI"
          >
            <Copy size={14} />
          </button>
        </div>
        {copiedKey === 'redirect-uri' && (
          <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-emerald-600">Copied</p>
        )}
        {runtimeError && (
          <p className="mt-3 text-xs font-semibold text-amber-700">Config status unavailable: {runtimeError}</p>
        )}
      </section>
    </div>
  );
};

const RuntimeConfigTab: React.FC<{
  status: RuntimeConfigStatus | null;
  loading: boolean;
  error: string | null;
  requiredConfigured: number;
  copiedKey: string | null;
  onCopy: (key: string, value: string) => void;
  onRefresh: () => void;
}> = ({ status, loading, error, requiredConfigured, copiedKey, onCopy, onRefresh }) => {
  const rows = buildRuntimeRows(status);
  return (
    <section className={sectionClass}>
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className={sectionIconClass}>
              <KeyRound size={16} />
            </div>
            <span className={sectionTitleClass}>Runtime Config</span>
          </div>
          <p className="mt-2 max-w-2xl text-xs font-medium leading-relaxed text-slate-500">
            This table shows whether required deployment values are present. Secret values are never returned to the browser.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill configured={Boolean(status) && requiredConfigured >= 9} label={status ? `${requiredConfigured}/9 configured` : 'Checking'} />
          <button
            type="button"
            onClick={() => onRefresh()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-800"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-800">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          Config status unavailable: {error}
        </div>
      )}

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200">
        <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
          <thead>
            <tr className="bg-slate-50 text-[10px] font-black uppercase tracking-widest text-slate-400">
              <th className="border-b border-slate-200 px-4 py-3">Name</th>
              <th className="border-b border-slate-200 px-4 py-3">Status</th>
              <th className="border-b border-slate-200 px-4 py-3">Purpose</th>
              <th className="border-b border-slate-200 px-4 py-3">Configure In</th>
              <th className="border-b border-slate-200 px-4 py-3">Restart</th>
              <th className="border-b border-slate-200 px-4 py-3 text-right">Copy</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="text-slate-600">
                <td className="border-b border-slate-100 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <code className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-[11px] font-bold text-slate-700">
                      {row.name}
                    </code>
                    {row.secret && <EyeOff size={13} className="text-slate-300" />}
                  </div>
                </td>
                <td className="border-b border-slate-100 px-4 py-3">
                  <StatusPill configured={row.configured} label={row.configured ? row.configuredLabel : 'Missing'} />
                </td>
                <td className="max-w-[260px] border-b border-slate-100 px-4 py-3 font-medium leading-relaxed">{row.purpose}</td>
                <td className="border-b border-slate-100 px-4 py-3 font-semibold text-slate-500">{row.configureIn}</td>
                <td className="border-b border-slate-100 px-4 py-3 font-semibold text-slate-500">{row.restartRequired ? 'Yes' : 'No'}</td>
                <td className="border-b border-slate-100 px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => onCopy(row.name, row.name)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-bold text-slate-500 hover:text-slate-900"
                  >
                    <Copy size={12} />
                    {copiedKey === row.name ? 'Copied' : 'Name'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const WorkflowTab: React.FC<{
  machineConfig: MachineConfig;
  setMachineConfig: React.Dispatch<React.SetStateAction<MachineConfig>>;
  config: { isSandbox: boolean };
  setConfig: React.Dispatch<React.SetStateAction<{ isSandbox: boolean }>>;
  addLog: (msg: string) => void;
}> = ({ machineConfig, setMachineConfig, config, setConfig, addLog }) => (
  <div className="space-y-4">
    <div className={sectionClass}>
      <SectionHeader icon={<Zap size={16} />} title="Environment" />
      <div className="space-y-4">
        <p className={descriptionClass}>Development-only mode switching lives here so the roster remains the primary focus in the sidebar.</p>
        <button
          onClick={() => {
            const newState = !config.isSandbox;
            setConfig(prev => ({ ...prev, isSandbox: newState }));
            localStorage.setItem('is_sandbox', String(newState));
            addLog(`Mode: ${newState ? 'Sandbox' : 'Live'}`);
          }}
          className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border transition-colors text-xs font-semibold ${
            config.isSandbox ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-white border-slate-200 text-slate-700'
          }`}
        >
          <span className="flex items-center gap-2">
            {config.isSandbox ? <Zap size={14} /> : <ShieldCheck size={14} />}
            {config.isSandbox ? 'Sandbox Preview' : 'Live Development'}
          </span>
          <div className={`w-8 h-4 rounded-full relative transition-colors ${config.isSandbox ? 'bg-amber-400' : 'bg-green-500'}`}>
            <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200 ${config.isSandbox ? 'translate-x-4' : 'translate-x-0'}`} />
          </div>
        </button>
      </div>
    </div>

    <div className={sectionClass}>
      <SectionHeader icon={<Filter size={16} />} title="Notebook Discovery" />
      <div className="space-y-4">
        <p className={descriptionClass}>Add keywords to help the app find your notebooks. Separate multiple keywords with commas.</p>
        <div className="space-y-2">
          <label className={labelClass}>Filter Keywords</label>
          <input
            type="text"
            value={machineConfig.filterStrings.join(', ')}
            onChange={e => {
              const val = e.target.value;
              const filters = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
              setMachineConfig(prev => ({ ...prev, filterStrings: filters }));
            }}
            placeholder="e.g. Education, Econ, Tolkien"
            className={controlClass}
          />
        </div>
      </div>
    </div>

    <div className={sectionClass}>
      <SectionHeader icon={<RefreshCw size={16} />} title="Sync & Performance" />
      <div className="space-y-6">
        <div className="space-y-2">
          <label className={labelClass}>Auto-Sync Frequency</label>
          <select
            value={machineConfig.syncFrequency}
            onChange={e => setMachineConfig(prev => ({ ...prev, syncFrequency: e.target.value as MachineConfig['syncFrequency'] }))}
            className={controlClass}
          >
            <option value="manual">Manual Only</option>
            <option value="daily">Daily (Recommended)</option>
            <option value="weekly">Weekly</option>
          </select>
          <p className="text-[10px] text-slate-500">Syncs happen automatically when the app is open if data is stale.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberInput
            label="Batch Size (Students)"
            value={machineConfig.syncBatchSize}
            min={1}
            max={5}
            onChange={(value) => setMachineConfig(prev => ({ ...prev, syncBatchSize: value }))}
          />
          <NumberInput
            label="Delay Between Batches (ms)"
            value={machineConfig.syncDelayBetweenBatches}
            min={0}
            step={500}
            onChange={(value) => setMachineConfig(prev => ({ ...prev, syncDelayBetweenBatches: value }))}
          />
        </div>
        <div className="space-y-2">
          <p className="text-[10px] text-amber-600 font-medium">Lower batch sizes and higher delays prevent "Rate Limit" errors from Microsoft Graph and Gemini.</p>
          <p className="text-[10px] text-slate-500 leading-relaxed">On the Gemini free tier, parsing models like Gemini 2.5 Flash can allow only a few requests per minute. For full-class sync, start with smaller batches and longer delays, then increase gradually if the workflow remains stable.</p>
        </div>
      </div>
    </div>
  </div>
);

const AiModelsTab: React.FC<{
  draft: EditablePrefs;
  setDraft: React.Dispatch<React.SetStateAction<EditablePrefs>>;
}> = ({ draft, setDraft }) => (
  <div className={sectionClass}>
    <SectionHeader icon={<BrainCircuit size={16} />} title="AI & Parser Configuration" />
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className={labelClass}>AI Parsing Model</label>
          <select
            value={draft.aiModelParsing}
            onChange={e => setDraft(d => ({ ...d, aiModelParsing: e.target.value as EditablePrefs['aiModelParsing'] }))}
            className={controlClass}
          >
            <option value="gemini-2.5-flash">Gemini 2.5 Flash (Recommended)</option>
            <option value="gemini-3-flash">Gemini 3 Flash (Legacy fallback)</option>
            <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (Budget)</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className={labelClass}>Feedback Draft Model</label>
          <select
            value={draft.aiModelFeedback}
            onChange={e => setDraft(d => ({ ...d, aiModelFeedback: e.target.value as EditablePrefs['aiModelFeedback'] }))}
            className={controlClass}
          >
            <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (Recommended)</option>
            <option value="gemini-2.5-flash">Gemini 2.5 Flash (Higher quality)</option>
            <option value="gemini-3-flash">Gemini 3 Flash (Legacy fallback)</option>
          </select>
        </div>
      </div>
      <p className="text-[10px] text-slate-500 leading-relaxed">
        Per-class parser mode is chosen in the roster list. Use <span className="font-bold text-slate-700">AI</span> for flexible legacy notebooks and <span className="font-bold text-slate-700">Labels</span> for the new labeled diary template that should parse without API calls.
      </p>
      <div className="space-y-2">
        <label className={labelClass}>Feedback Tone</label>
        <input
          type="text"
          value={draft.feedbackTone}
          onChange={e => setDraft(d => ({ ...d, feedbackTone: e.target.value }))}
          placeholder="e.g. professional and encouraging"
          className={controlClass}
        />
      </div>
      <div className="space-y-2">
        <label className={labelClass}>Display Name</label>
        <input
          type="text"
          value={draft.teacherDisplayName}
          onChange={e => setDraft(d => ({ ...d, teacherDisplayName: e.target.value }))}
          placeholder="Mr. Carr"
          className={controlClass}
        />
        <p className="text-[10px] text-slate-500">Replaces [Teacher Name] in sign-offs. Leave blank to use your Entra ID name.</p>
      </div>
      <div className="space-y-2">
        <label className={labelClass}>Custom Sign-off</label>
        <textarea
          value={draft.customSignOff}
          onChange={e => setDraft(d => ({ ...d, customSignOff: e.target.value }))}
          placeholder={"Looking forward to your next entry,\n\n[Teacher Name]"}
          className={`${controlClass} h-24`}
        />
        <p className="text-[10px] text-slate-500">Use [Teacher Name] as a placeholder for your display name above.</p>
      </div>
    </div>
  </div>
);

const PromptsTab: React.FC<{
  aiPrompts: EditablePrefs['aiPrompts'];
  setDraft: React.Dispatch<React.SetStateAction<EditablePrefs>>;
}> = ({ aiPrompts, setDraft }) => {
  const promptFields = [
    ['diaryText', 'Diary Text'],
    ['peerFeedback', 'Peer Feedback'],
    ['vocab', 'Vocabulary'],
    ['translations', 'Definitions & Examples'],
    ['overall', 'General Feedback'],
  ] as const;

  const resetPrompt = (key: FeedbackPromptKey) => {
    setDraft(d => ({
      ...d,
      aiPrompts: {
        ...d.aiPrompts,
        [key]: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS[key],
      },
    }));
  };

  const resetAllPrompts = () => {
    setDraft(d => ({
      ...d,
      aiPrompts: {
        ...d.aiPrompts,
        diaryText: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.diaryText,
        peerFeedback: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.peerFeedback,
        vocab: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.vocab,
        translations: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.translations,
        overall: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.overall,
      },
    }));
  };

  return (
    <div className={sectionClass}>
      <SectionHeader
        icon={<Wand2 size={16} />}
        title="AI Feedback Drafting Prompts"
        action={
          <button
            type="button"
            onClick={resetAllPrompts}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
          >
            Reset all
          </button>
        }
      />
      <div className="space-y-4">
        <p className={descriptionClass}>
          These instructions guide the student-facing AI Draft suggestions for each feedback field. They do not evaluate students or create diagnostic scores.
        </p>
        {promptFields.map(([key, label]) => (
          <div key={key} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className={labelClass}>{label}</label>
              <button
                type="button"
                onClick={() => resetPrompt(key)}
                className="text-[10px] font-bold uppercase tracking-wider text-slate-400 transition-colors hover:text-indigo-600"
              >
                Reset
              </button>
            </div>
            <textarea
              value={aiPrompts[key]}
              onChange={e => setDraft(d => ({ ...d, aiPrompts: { ...d.aiPrompts, [key]: e.target.value } }))}
              className={`${controlClass} resize-none`}
              rows={2}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

const SectionHeader: React.FC<{ icon: React.ReactNode; title: string; action?: React.ReactNode }> = ({ icon, title, action }) => (
  <div className="flex items-center justify-between mb-4">
    <div className="flex items-center gap-3">
      <div className={sectionIconClass}>{icon}</div>
      <span className={sectionTitleClass}>{title}</span>
    </div>
    {action}
  </div>
);

const NumberInput: React.FC<{
  label: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}> = ({ label, value, min, max, step, onChange }) => (
  <div className="space-y-2">
    <label className={labelClass}>{label}</label>
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={e => onChange(parseInt(e.target.value, 10) || min)}
      className={controlClass}
    />
  </div>
);

const ConnectionCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  configured: boolean;
  connected: boolean;
  connectedLabel: string;
  details: Array<[string, string]>;
  actionLabel: string;
  actionDisabled?: boolean;
  onAction: () => void | Promise<void>;
}> = ({ icon, title, subtitle, configured, connected, connectedLabel, details, actionLabel, actionDisabled, onAction }) => (
  <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
          {icon}
        </div>
        <div>
          <h4 className="text-sm font-black text-slate-900">{title}</h4>
          <p className="mt-1 text-xs font-medium leading-relaxed text-slate-500">{subtitle}</p>
        </div>
      </div>
      <StatusPill
        configured={configured && connected}
        label={connected ? connectedLabel : configured ? 'Ready' : 'Setup needed'}
      />
    </div>
    <div className="mt-4 space-y-2">
      {details.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4 border-t border-slate-100 pt-2">
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</span>
          <span className="truncate text-xs font-bold text-slate-600">{value}</span>
        </div>
      ))}
    </div>
    <button
      type="button"
      disabled={actionDisabled}
      onClick={() => void onAction()}
      className="mt-4 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 transition-colors hover:border-indigo-200 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {actionLabel}
    </button>
  </article>
);

const StatusPill: React.FC<{ configured: boolean; label: string }> = ({ configured, label }) => (
  <span
    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${
      configured
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : 'border-amber-200 bg-amber-50 text-amber-700'
    }`}
  >
    {configured ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
    {label}
  </span>
);

interface RuntimeRow {
  name: string;
  configured: boolean;
  configuredLabel: string;
  purpose: string;
  configureIn: string;
  restartRequired: boolean;
  secret?: boolean;
}

const buildRuntimeRows = (status: RuntimeConfigStatus | null): RuntimeRow[] => [
  {
    name: 'APP_URL',
    configured: Boolean(status?.runtime.appUrlSet),
    configuredLabel: status?.runtime.appUrlHost || 'Configured',
    purpose: 'Canonical base URL used to generate OAuth redirect callbacks in deployed environments.',
    configureIn: '.env.local / deployment env',
    restartRequired: true,
  },
  {
    name: 'ENTRA_CLIENT_ID',
    configured: Boolean(status?.entra.clientIdSet),
    configuredLabel: 'Configured',
    purpose: 'Microsoft Entra application identifier for Graph authentication.',
    configureIn: '.env.local / deployment env',
    restartRequired: true,
  },
  {
    name: 'ENTRA_TENANT_ID',
    configured: Boolean(status?.entra.tenantIdSet),
    configuredLabel: status?.entra.tenantIdLabel || 'Configured',
    purpose: 'Tenant authority used by the backend authentication client.',
    configureIn: '.env.local / deployment env',
    restartRequired: true,
  },
  {
    name: 'ENTRA_CLIENT_SECRET',
    configured: Boolean(status?.entra.clientSecretSet),
    configuredLabel: 'Configured server-side',
    purpose: 'Confidential backend credential used during OAuth token exchange.',
    configureIn: '.env.local / deployment secret',
    restartRequired: true,
    secret: true,
  },
  {
    name: 'SESSION_SECRET',
    configured: Boolean(status?.session.secretSet),
    configuredLabel: 'Configured server-side',
    purpose: 'Signs the HTTP-only server session cookie.',
    configureIn: '.env.local / deployment secret',
    restartRequired: true,
    secret: true,
  },
  {
    name: 'GEMINI_API_KEY',
    configured: Boolean(status?.ai.geminiApiKeySet),
    configuredLabel: 'Configured server-side',
    purpose: 'Enables AI parsing fallback and feedback drafting.',
    configureIn: '.env.local / deployment secret',
    restartRequired: true,
    secret: true,
  },
  {
    name: 'firebase-applet-config.json',
    configured: Boolean(status?.firebase.configFilePresent),
    configuredLabel: 'Present',
    purpose: 'Client Firebase app configuration loaded at build/runtime.',
    configureIn: 'repo/package config',
    restartRequired: true,
  },
  {
    name: 'FIREBASE_PROJECT',
    configured: Boolean(status?.firebase.projectIdSet && status.firebase.authDomainSet),
    configuredLabel: status?.firebase.projectId || 'Configured',
    purpose: 'Firestore and Firebase Auth project used for saved records and preferences.',
    configureIn: 'firebase config file',
    restartRequired: true,
  },
];
