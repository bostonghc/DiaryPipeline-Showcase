import React from 'react';
import { FeedbackPreferencesTab } from './FeedbackPreferencesTab';
import {
  AlertTriangle,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Compass,
  Copy,
  Database,
  EyeOff,
  Filter,
  Info,
  KeyRound,
  Link2,
  RefreshCw,
  ShieldCheck,
  MessageSquare,
  SlidersHorizontal,
  Terminal,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import { DEFAULT_FIELD_REVIEW_FOCUS, type AiReviewFieldKey } from '../../services/aiFeedbackReview';
import { earlierCustomDraftingInstruction, REVIEW_FOCUS_MAX_LENGTH } from '../../services/reviewFocus';
import { getReadTotals, resetReadMeter } from '../../services/readMeter';
import { useCollaborationAccess } from '../../hooks/useCollaborationAccess';
import type { UserConfig, UserPreferences } from '../../types';
import {
  findGeminiModel,
  isDeprecatedGeminiModel,
  selectableGeminiModels,
  type GeminiModelTier,
} from '../../services/geminiModels';

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
  preferencesLoading?: boolean;
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

type SettingsTab = 'feedback' | 'connections' | 'runtime' | 'workflow' | 'ai' | 'prompts' | 'about';

type EditablePrefs = Required<Pick<
  UserPreferences,
  'feedbackTone' | 'teacherDisplayName' | 'customSignOff' | 'aiModelFeedback' | 'aiModelParsing' | 'reviewFocus'
>>;

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
  { id: 'feedback', label: 'Feedback', icon: <MessageSquare size={14} /> },
  { id: 'ai', label: 'AI Models', icon: <BrainCircuit size={14} /> },
  { id: 'prompts', label: 'Prompts', icon: <Wand2 size={14} /> },
  { id: 'about', label: 'About', icon: <Info size={14} /> },
];

const PRODUCT_PRINCIPLES = [
  'Teacher-in-the-loop review becomes student-facing feedback.',
  'Dashboard counts describe workflow and evidence, not grades.',
  'AI review assists with feedback and parsing; it does not replace instructor judgment.',
  'Firestore is the working record for review state, feedback history, exports, and dashboards.',
];

const CURRENT_ROADMAP_ITEMS = [
  {
    status: 'Active',
    title: 'Evidence-first class dashboard',
    body: 'Review Queue, Data Health, Teacher Practice, Student Trajectories, and Class Patterns.',
  },
  {
    status: 'Next',
    title: 'Template-aware parsing',
    body: 'Expand beyond the current diary template toward multiple format assignments and document structures, with parser strategies for each template.',
  },
  {
    status: 'Next',
    title: 'Responsive content panes',
    body: 'Panes adapt to the template being opened, so diaries, assignments, rubrics, and future document types do not share one fixed layout.',
  },
  {
    status: 'Next',
    title: 'AI-agnostic setup',
    body: 'Abstract parsing and feedback drafting behind provider settings so OpenAI, Anthropic, Gemini, or local models can be used.',
  },
  {
    status: 'Next',
    title: 'Feedback and rubric options',
    body: 'Add preset feedback structures, correction styles, comprehensive modes, and rubric support for summative or assignment-specific review.',
  },
];

const ROADMAP_WATCHLIST = [
  'Provision a non-capped Firestore database if daily read caps recur during normal teacher use.',
  'Add OneNote pagination insurance when section page counts exceed Graph defaults.',
  'Split local and production Entra app registrations before deployment.',
  'Add per-field AI provenance only when a dashboard consumer is ready.',
];

const makeDraft = (p: Required<UserPreferences>): EditablePrefs => ({
  feedbackTone: p.feedbackTone,
  teacherDisplayName: p.teacherDisplayName,
  customSignOff: p.customSignOff,
  aiModelFeedback: p.aiModelFeedback,
  aiModelParsing: p.aiModelParsing,
  // Blank saved values mean "use the default", so they are not part of the draft.
  reviewFocus: Object.fromEntries(
    Object.entries(p.reviewFocus ?? {}).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
  ),
});

const countTrue = (values: boolean[]) => values.filter(Boolean).length;

export const SettingsModal: React.FC<Props> = ({
  machineConfig,
  setMachineConfig,
  preferences,
  preferencesLoading = false,
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
  const { account, profile: accessProfile } = useCollaborationAccess();
  const canManageSettings = !account || accessProfile?.capabilities.canManageSettings === true;
  const tabs = SETTINGS_TABS.filter(tab => canManageSettings || ['feedback', 'prompts', 'about'].includes(tab.id));
  const [selectedTab, setActiveTab] = React.useState<SettingsTab>(canManageSettings ? 'connections' : 'feedback');
  const activeTab = tabs.some(tab => tab.id === selectedTab) ? selectedTab : 'feedback';
  const [runtimeStatus, setRuntimeStatus] = React.useState<RuntimeConfigStatus | null>(null);
  const [runtimeError, setRuntimeError] = React.useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = React.useState(true);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<EditablePrefs>(() => makeDraft(preferences));
  const [saving, setSaving] = React.useState(false);
  const [justSaved, setJustSaved] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Live Firestore read count for the debug stream. Polled (not pushed) and only
  // while the stream is open, so a burst of reads never triggers re-renders.
  const [readStats, setReadStats] = React.useState(() => getReadTotals());
  React.useEffect(() => {
    if (!showDebugStream || !canManageSettings) return;
    setReadStats(getReadTotals());
    const id = window.setInterval(() => setReadStats(getReadTotals()), 1000);
    return () => window.clearInterval(id);
  }, [showDebugStream, canManageSettings]);
  const resetReads = () => {
    resetReadMeter();
    setReadStats(getReadTotals());
  };
  const readsSince = new Date(readStats.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // App creates a fresh preferences object on render. Reset only when saved
  // values change, so background activity cannot erase an in-progress edit.
  const savedDraftKey = JSON.stringify(makeDraft(preferences));
  React.useEffect(() => {
    setDraft(JSON.parse(savedDraftKey));
  }, [savedDraftKey]);

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
    if (canManageSettings) void loadRuntimeStatus();
  }, [loadRuntimeStatus, canManageSettings]);

  const isDirty = JSON.stringify(draft) !== savedDraftKey;

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch {
      setCopiedKey(null);
    }
  };

  const saveUnavailableReason = !connectionState.firebaseSignedIn
    ? 'Connect saved records to load and save your feedback preferences.'
    : preferencesLoading ? 'Wait for your saved preferences to finish loading.' : null;

  // Firestore merges maps, so a key dropped from the draft must be sent as ''
  // to clear a value saved earlier ('' means "use the default").
  const reviewFocusForSave = () => {
    const out: Record<string, string> = {};
    const keys = new Set([...Object.keys(preferences.reviewFocus ?? {}), ...Object.keys(draft.reviewFocus)]);
    for (const key of keys) out[key] = draft.reviewFocus[key as AiReviewFieldKey] ?? '';
    return out;
  };

  const handleSavePreferences = async () => {
    if (saveUnavailableReason || saving || !isDirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      await savePref(canManageSettings ? { ...draft, reviewFocus: reviewFocusForSave(), reviewFocusVersion: 1 } : {
        feedbackTone: draft.feedbackTone,
        teacherDisplayName: draft.teacherDisplayName,
        customSignOff: draft.customSignOff,
        reviewFocus: reviewFocusForSave(),
        reviewFocusVersion: 1,
      });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveError(message);
      addLog(`Preferences save failed: ${message}`);
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

  if (account && !accessProfile?.allowed) return null;

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
                  <h3 className="text-xl font-black tracking-tight text-slate-900">{canManageSettings ? 'Settings & Connections' : 'Your Preferences'}</h3>
                  <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">
                    {canManageSettings ? 'Setup status, workflow, and feedback preferences' : 'Feedback style, closing, and review focus'}
                  </p>
                </div>
              </div>
              {canManageSettings && <button
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
              </button>}
            </div>

            <div className="flex flex-wrap gap-2">
              {tabs.map((tab) => (
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

            {canManageSettings && showDebugStream && (
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

          {saveUnavailableReason && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
              <p>{saveUnavailableReason}</p>
              {!connectionState.firebaseSignedIn && <button type="button" onClick={onFirebaseLogin} className="mt-2 font-bold underline">Connect saved records</button>}
            </div>
          )}

          {/* While saved preferences load, the draft still holds defaults. Typing now
              would be replaced by the loaded values, so the editable tabs wait. The
              banner above gives the reason. */}
          <fieldset
            disabled={preferencesLoading && ['feedback', 'ai', 'prompts'].includes(activeTab)}
            className="m-0 min-w-0 border-0 p-0 disabled:opacity-60"
          >
          {activeTab === 'feedback' && (
            <FeedbackPreferencesTab
              value={draft}
              onChange={updates => setDraft(current => ({ ...current, ...updates }))}
              aiAvailable={geminiConfigured}
            />
          )}

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
            <PromptsTab reviewFocus={draft.reviewFocus} earlierPrompts={preferences.aiPrompts} setDraft={setDraft} />
          )}

          {activeTab === 'about' && (
            <AboutTab />
          )}
          </fieldset>
        </div>

        <div className="border-t border-slate-200 px-6 md:px-8 py-4 flex items-center justify-between bg-white">
          <span className="text-[11px] font-medium text-slate-400">
            {justSaved
              ? 'Preferences saved'
              : saveError
                ? saveError
              : isDirty
                ? 'Unsaved preference changes'
                : activeTab === 'runtime'
                  ? 'Runtime config is read-only here'
                  : 'Preferences up to date'}
          </span>
          <button
            onClick={handleSavePreferences}
            disabled={!isDirty || saving || Boolean(saveUnavailableReason)}
            title={saveUnavailableReason || undefined}
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
          subtitle="AI review of your feedback (server key) and local browser parsing (BROWSER_GEMINI_API_KEY)"
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
          <label htmlFor="settings-filter-keywords" className={labelClass}>Filter Keywords</label>
          <input
            id="settings-filter-keywords"
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
          <label htmlFor="settings-sync-frequency" className={labelClass}>Auto-Sync Frequency</label>
          <select
            id="settings-sync-frequency"
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

/**
 * Model choices rendered from the shared catalog rather than hardcoded options,
 * so a retirement is a one-line catalog edit. `preferredTier` only marks the
 * recommendation for this field — both tiers stay selectable.
 *
 * A retired id that is still saved in preferences is rendered as a disabled
 * option; without it the <select> would show blank and silently rewrite the
 * user's stored value on the next save.
 */
const GeminiModelOptions: React.FC<{
  selected: string;
  preferredTier: GeminiModelTier;
}> = ({ selected, preferredTier }) => {
  const options = selectableGeminiModels();
  const retired = isDeprecatedGeminiModel(selected) ? findGeminiModel(selected) : undefined;
  return (
    <>
      {options.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label}{model.tier === preferredTier && model.kind === 'alias' ? ' — Recommended' : ''}
        </option>
      ))}
      {retired && (
        <option value={retired.id} disabled>
          {retired.label} — no longer available
        </option>
      )}
    </>
  );
};

const AiModelsTab: React.FC<{
  draft: EditablePrefs;
  setDraft: React.Dispatch<React.SetStateAction<EditablePrefs>>;
}> = ({ draft, setDraft }) => (
  <div className={sectionClass}>
    <SectionHeader icon={<BrainCircuit size={16} />} title="AI & Parser Configuration" />
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label htmlFor="settings-ai-parsing-model" className={labelClass}>AI Parsing Model</label>
          <select
            id="settings-ai-parsing-model"
            value={draft.aiModelParsing}
            onChange={e => setDraft(d => ({ ...d, aiModelParsing: e.target.value as EditablePrefs['aiModelParsing'] }))}
            className={controlClass}
          >
            <GeminiModelOptions selected={draft.aiModelParsing} preferredTier="flash" />
          </select>
        </div>
        <div className="space-y-2">
          <label htmlFor="settings-ai-review-model" className={labelClass}>AI Review Model</label>
          <select
            id="settings-ai-review-model"
            value={draft.aiModelFeedback}
            onChange={e => setDraft(d => ({ ...d, aiModelFeedback: e.target.value as EditablePrefs['aiModelFeedback'] }))}
            className={controlClass}
          >
            <GeminiModelOptions selected={draft.aiModelFeedback} preferredTier="flash-lite" />
          </select>
          <p className="text-[10px] text-slate-500 leading-relaxed">This model applies to AI review of your feedback.</p>
        </div>
      </div>
      <p className="text-[10px] text-slate-500 leading-relaxed">
        Per-class parser mode is chosen in the roster list. Use <span className="font-bold text-slate-700">AI</span> for flexible legacy notebooks and <span className="font-bold text-slate-700">Labels</span> for the new labeled diary template that should parse without API calls.
      </p>
    </div>
  </div>
);

const REVIEW_FOCUS_FIELDS: ReadonlyArray<readonly [AiReviewFieldKey, string]> = [
  ['diaryText', 'Diary Text'],
  ['peerFeedback', 'Peer Feedback'],
  ['vocab', 'Vocabulary'],
  ['translations', 'Definitions & Examples'],
  ['chatbot', 'Chatbot'],
  ['overall', 'General Feedback'],
];

const PromptsTab: React.FC<{
  reviewFocus: EditablePrefs['reviewFocus'];
  /** Earlier drafting instructions: read-only reference, never used as review focus. */
  earlierPrompts: UserPreferences['aiPrompts'];
  setDraft: React.Dispatch<React.SetStateAction<EditablePrefs>>;
}> = ({ reviewFocus, earlierPrompts, setDraft }) => {
  const setFocus = (key: AiReviewFieldKey, text: string) =>
    setDraft(d => ({ ...d, reviewFocus: { ...d.reviewFocus, [key]: text } }));
  // Reset drops the draft value; on save, a previously saved key is written as ''
  // (see handleSavePreferences) so the merge write clears it.
  const resetFocus = (key: AiReviewFieldKey) =>
    setDraft(d => {
      const { [key]: _removed, ...rest } = d.reviewFocus;
      return { ...d, reviewFocus: rest };
    });
  const resetAllFocus = () => setDraft(d => ({ ...d, reviewFocus: {} }));

  return (
    <div className={sectionClass}>
      <SectionHeader
        icon={<Wand2 size={16} />}
        title="AI Review Focus"
        action={
          <button
            type="button"
            onClick={resetAllFocus}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-700"
          >
            Reset all
          </button>
        }
      />
      <div className="space-y-4">
        <p className={descriptionClass}>
          These instructions tell the AI reviewer what good feedback on each field should do. The reviewer comments on your feedback; it never writes to students.
        </p>
        {REVIEW_FOCUS_FIELDS.map(([key, label]) => {
          const earlier = earlierCustomDraftingInstruction({ aiPrompts: earlierPrompts }, key);
          const custom = reviewFocus[key];
          return (
            <div key={key} className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={`settings-review-focus-${key}`} className={labelClass}>{label}</label>
                <button
                  type="button"
                  onClick={() => resetFocus(key)}
                  className="text-[10px] font-bold uppercase tracking-wider text-slate-400 transition-colors hover:text-indigo-600"
                >
                  Reset
                </button>
              </div>
              <textarea
                id={`settings-review-focus-${key}`}
                value={custom ?? DEFAULT_FIELD_REVIEW_FOCUS[key]}
                maxLength={REVIEW_FOCUS_MAX_LENGTH}
                onChange={e => setFocus(key, e.target.value)}
                className={`${controlClass} resize-none`}
                rows={2}
              />
              <p className="text-right text-[10px] text-slate-400">
                {(custom ?? DEFAULT_FIELD_REVIEW_FOCUS[key]).length} / {REVIEW_FOCUS_MAX_LENGTH}
              </p>
              {earlier && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                    Your earlier drafting instructions (no longer used)
                  </p>
                  <p className="text-[11px] text-slate-600 whitespace-pre-wrap">{earlier}</p>
                  <button
                    type="button"
                    onClick={() => setFocus(key, earlier.slice(0, REVIEW_FOCUS_MAX_LENGTH))}
                    className="text-[10px] font-bold uppercase tracking-wider text-indigo-500 transition-colors hover:text-indigo-700"
                  >
                    Copy into review focus
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const AboutTab: React.FC = () => (
  <div className="space-y-5">
    <section className={sectionClass}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white">
            <BookOpen size={22} />
          </div>
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Notebook Feedback Studio</p>
            <h4 className="mt-1 text-xl font-black tracking-tight text-slate-950">Feedback and research for OneNote Class Notebooks</h4>
            <p className="mt-2 max-w-3xl text-sm font-semibold leading-relaxed text-slate-500">
              A teacher-mediated workflow for collecting OneNote diary evidence, drafting focused feedback,
              sending it through Microsoft 365, and preserving the review record for reflection and research. Part of the DiaryPipeline research project.
            </p>
          </div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-indigo-700">
          Local dev
        </span>
      </div>
    </section>

    <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
      <div className={sectionClass}>
        <SectionHeader icon={<ShieldCheck size={16} />} title="Operating Principles" />
        <div className="space-y-3">
          {PRODUCT_PRINCIPLES.map((principle) => (
            <div key={principle} className="flex items-start gap-3 border-t border-slate-100 pt-3 first:border-t-0 first:pt-0">
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600" />
              <p className="text-xs font-semibold leading-relaxed text-slate-600">{principle}</p>
            </div>
          ))}
        </div>
      </div>

      <div className={sectionClass}>
        <SectionHeader icon={<Compass size={16} />} title="Current Roadmap" />
        <div className="space-y-3">
          {CURRENT_ROADMAP_ITEMS.map((item) => (
            <article key={item.title} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <h5 className="text-sm font-black text-slate-900">{item.title}</h5>
                <span
                  className={`shrink-0 rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${
                    item.status === 'Active'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-indigo-200 bg-indigo-50 text-indigo-700'
                  }`}
                >
                  {item.status}
                </span>
              </div>
              <p className="mt-2 text-xs font-medium leading-relaxed text-slate-500">{item.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>

    <section className={sectionClass}>
      <SectionHeader icon={<AlertTriangle size={16} />} title="Watchlist" />
      <div className="grid gap-3 md:grid-cols-2">
        {ROADMAP_WATCHLIST.map((item) => (
          <div key={item} className="rounded-xl border border-amber-100 bg-amber-50/60 p-4">
            <p className="text-xs font-semibold leading-relaxed text-amber-900">{item}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-[10px] font-semibold leading-relaxed text-slate-400">
        This panel is a concise operator view. The durable planning source remains ROADMAP.md and linked planning documents.
      </p>
    </section>
  </div>
);

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
}> = ({ label, value, min, max, step, onChange }) => {
  const inputId = `settings-number-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
  <div className="space-y-2">
    <label htmlFor={inputId} className={labelClass}>{label}</label>
    <input
      id={inputId}
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
};

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
    purpose: 'Server-only key for AI feedback review. Browser AI parsing in local development uses BROWSER_GEMINI_API_KEY instead.',
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
