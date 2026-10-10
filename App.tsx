
import React, { useCallback, useState, useEffect, useMemo, useRef, Component } from 'react';
import { GraphService } from './services/graphService';
import { ExportDialog } from './components/export/ExportDialog';
import { analyzeEntry, parseDiaryHTML } from './services/geminiService';
import { generateScenarioData, Scenario } from './services/mockDataService';
import { parseLabeledDiaryHTML } from './services/parserService';
import { cleanStudentDisplayName } from './services/feedbackFormatter';
import { isFirestoreQuotaError } from './services/firestoreErrors';
import { recordRead, formatReadSummary } from './services/readMeter';
import { FeedbackWorkspace } from './components/feedback/FeedbackWorkspace';
import { WorkflowBadge } from './components/feedback/WorkflowBadge';
import { ClassDashboard } from './components/dashboard/ClassDashboard';
import { SettingsModal } from './components/settings/SettingsModal';
import { EntryPositionIndicator } from './components/workspace/EntryPositionIndicator';
import { NoPageSelectedState } from './components/workspace/NoPageSelectedState';
import { SyncProgressState } from './components/workspace/SyncProgressState';
import { WorkspaceHome } from './components/workspace/WorkspaceHome';
import { useFeedbackComposition, type FeedbackBatchDecision } from './hooks/useFeedbackComposition';
import { useUserPreferences } from './hooks/useUserPreferences';
import { useArchiveCaptureStatus } from './hooks/useArchiveCaptureStatus';
import { deriveArchiveCaptureByClass } from './services/archiveCaptureStatus';
import {
  getEntryWorkflowUiState,
  getEntryWorkflowLogLabel,
  getWorkflowSummaryClassName,
  getWorkflowSummaryLabel,
  getWorkflowSummaryTooltip,
  selectBulkReadyEntries,
} from './services/feedbackWorkflowService';
import {
  buildStoredEntry,
  DEFAULT_PARSER_MODE,
  DEFAULT_TEMPLATE_VERSION,
  fetchEntriesForPage,
  fetchPageSyncRecord,
  LABEL_TEMPLATE_VERSION,
  listEntriesForClasses,
  listPageSyncRecordsForClasses,
  loadClassMetadataMap,
  loadClassStudentIdentityMap,
  mergeClassMetadata,
  replaceClassStudentIdentities,
  saveClassLastSynced,
  saveClassStudentIdentity,
  saveClassMetadata,
  fetchRecentFeedbackForPage,
  fetchRecentFeedbackForStudent,
  markFeedbackUptake,
  saveEntryRecord,
  savePageSyncRecord,
  withClassDefaults,
} from './services/firestoreDataService';
import {
  ClassStudentIdentity,
  EducationClass,
  Student,
  StudentIdentity,
  JournalEntry,
  AnalysisTemplate,
  NotebookNode,
  ParsedPageContent,
  UserConfig,
  ParsedDiaryEntry,
  ParserMode,
  EntryStatus,
  FFItemCount,
  FeedbackHistoryRecord,
  PageSyncRecord,
  PageSyncState,
  PriorFeedbackMode,
  SyncJob,
  SyncJobItem,
  SyncJobItemStatus,
  TeacherFeedbackFields,
  TemplateVersion,
} from './types';
import {
  batchWriteJobItems,
  claimItem,
  completeItem,
  createSyncJob,
  getResumableJobs,
  getSyncJob,
  listQueuedItems,
  makeItemId,
  reclaimStaleRunningItems,
  requeueRetryableRateLimitedItems,
  updateJobStatus,
} from './services/syncJobService';
import { 
  BookOpen,
  Users,
  Download,
  BrainCircuit,
  UploadCloud,
  RefreshCw, 
  AlertCircle,
  ChevronRight,
  FileSpreadsheet,
  FileJson,
  FileText,
  Settings,
  ShieldCheck,
  LayoutGrid,
  CheckCircle2,
  ArrowRight,
  Search,
  Info,
  Calendar,
  Copy,
  Check,
  ExternalLink,
  Activity,
  RotateCcw,
  ShieldAlert,
  Lock,
  WifiOff,
  ChevronLeft,
  Menu,
  Sparkles,
  Wrench,
  MoreVertical,
  Maximize2,
  Minimize2,
  HelpCircle,
  ZoomIn,
  ZoomOut,
  Code,
  Wand2,
  X,
  Database,
  CheckCircle,
  Send,
  Loader2,
  MessageSquare,
  AlertTriangle,
  BarChart3,
} from 'lucide-react';
import { auth, db, firebaseProjectInfo } from './src/firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, getDocs, deleteDoc, getDocFromServer } from 'firebase/firestore';

// --- Error Boundary ---
interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

type PageSnapshotBadgeState = 'unsaved' | 'draft' | 'approved' | 'mixed';

interface PageSnapshotMeta {
  badgeState: PageSnapshotBadgeState;
  stale: boolean;
  source: 'saved' | 'fresh-parse';
  parseFallbackUsed: boolean;
  message?: string;
}

interface PageCacheMeta {
  lastModified?: string;
}

const normalizeSnapshotText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const parseComparableTime = (value?: string): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export class ErrorBoundary extends (Component as any) {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    const state = (this as any).state;
    const props = (this as any).props;
    
    if (state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white rounded-[32px] shadow-2xl p-10 border border-red-100 text-center">
            <div className="w-20 h-20 bg-red-50 rounded-3xl flex items-center justify-center mx-auto mb-8 text-red-500 border border-red-100">
              <ShieldAlert size={40} />
            </div>
            <h2 className="text-2xl font-black text-slate-900 mb-4 tracking-tight">Something went wrong</h2>
            <p className="text-slate-500 text-sm mb-8 leading-relaxed font-medium">
              The application encountered an unexpected error. This might be due to a connection issue or a temporary service interruption.
            </p>
            <div className="bg-slate-50 rounded-2xl p-4 mb-8 text-left overflow-auto max-h-32 border border-slate-100">
              <code className="text-[10px] font-bold text-red-600 break-all">
                {state.error?.message || "Unknown Error"}
              </code>
            </div>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return props.children;
  }
}

const HelpModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-2xl rounded-[32px] shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200">
        <div className="p-8 border-b border-slate-100 flex items-center justify-between bg-indigo-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-200">
              <HelpCircle size={24} />
            </div>
            <div>
              <h2 className="text-xl font-black text-slate-900 tracking-tight">Help & Documentation</h2>
              <p className="text-xs font-bold text-indigo-600 uppercase tracking-widest">Guide & Roadmap</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white rounded-xl transition-colors text-slate-400 hover:text-slate-600 shadow-sm border border-transparent hover:border-slate-200">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-10">
          {/* Symbols Guide */}
          <section>
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2">
              <div className="w-1.5 h-4 bg-indigo-500 rounded-full" />
              Notebook Symbols
            </h3>
            <div className="grid gap-4">
              <div className="flex items-start gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center font-black text-indigo-600 shadow-sm border border-slate-100">*</div>
                <div>
                  <h4 className="text-sm font-bold text-slate-800">Recently Modified</h4>
                  <p className="text-xs text-slate-500 leading-relaxed">Indicates the student has updated their diary since your last sync or view.</p>
                </div>
              </div>
              <div className="flex items-start gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center font-black text-indigo-600 shadow-sm border border-slate-100">1234567</div>
                <div>
                  <h4 className="text-sm font-bold text-slate-800">Student ID Match</h4>
                  <p className="text-xs text-slate-500 leading-relaxed">A 7-digit ID was successfully found in the page title and extracted for sorting.</p>
                </div>
              </div>
              <div className="flex items-start gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center font-black text-indigo-600 shadow-sm border border-slate-100">?</div>
                <div>
                  <h4 className="text-sm font-bold text-slate-800">Unidentified Page</h4>
                  <p className="text-xs text-slate-500 leading-relaxed">No 7-digit ID was found. The page might be misnamed or a non-diary entry.</p>
                </div>
              </div>
              <div className="flex items-start gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center text-indigo-600 shadow-sm border border-slate-100">
                  <RefreshCw size={16} />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-slate-800">Class Sync</h4>
                  <p className="text-xs text-slate-500 leading-relaxed">The class sync button fetches the latest OneNote pages for that class and updates the saved Firestore records used for later review and export.</p>
                </div>
              </div>
            </div>
          </section>

          {/* Roadmap */}
          <section>
            <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2">
              <div className="w-1.5 h-4 bg-emerald-500 rounded-full" />
              Future Roadmap
            </h3>
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 border-b border-slate-100">
                <div className="w-2 h-2 bg-emerald-400 rounded-full" />
                <span className="text-sm font-medium text-slate-700">Background Synchronization (Phase 2)</span>
              </div>
              <div className="flex items-center gap-3 p-3 border-b border-slate-100">
                <div className="w-2 h-2 bg-slate-300 rounded-full" />
                <span className="text-sm font-medium text-slate-700">Customizable Email/Teams Templates</span>
              </div>
              <div className="flex items-center gap-3 p-3 border-b border-slate-100">
                <div className="w-2 h-2 bg-slate-300 rounded-full" />
                <span className="text-sm font-medium text-slate-700">Class-wide Performance Analytics</span>
              </div>
              <div className="flex items-center gap-3 p-3 border-b border-slate-100">
                <div className="w-2 h-2 bg-slate-300 rounded-full" />
                <span className="text-sm font-medium text-slate-700">Voice-to-Feedback Dictation</span>
              </div>
            </div>
          </section>
        </div>

        <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-end">
          <button onClick={onClose} className="px-6 py-2 bg-slate-900 text-white text-xs font-bold rounded-xl hover:bg-slate-800 transition-all shadow-md active:scale-95">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  // --- Core State ---
  const [config, setConfig] = useState({
    isSandbox: localStorage.getItem('is_sandbox') === 'true'
  });

  // Machine-local config: notebook discovery keywords and sync rate-limit tuning.
  // Pedagogical fields (tone, sign-off, models, prompts) migrated to Firestore
  // via useUserPreferences (Slice 7b). userConfig is kept as UserConfig for
  // downstream consumers; pedagogical fields are merged in from preferences below.
  const [machineConfig, setMachineConfig] = useState<Pick<UserConfig, 'filterStrings' | 'syncFrequency' | 'syncBatchSize' | 'syncDelayBetweenBatches'>>(() => {
    const saved = localStorage.getItem('user_config');
    const cfg = saved ? JSON.parse(saved) : null;
    return {
      filterStrings: cfg?.filterStrings ?? ["Education", "Econ", "Nutritional", "Seminar", "Tolkien"],
      syncFrequency: cfg?.syncFrequency ?? 'daily',
      syncBatchSize: cfg?.syncBatchSize ?? 2,
      syncDelayBetweenBatches: cfg?.syncDelayBetweenBatches ?? 2000,
    };
  });

  useEffect(() => {
    localStorage.setItem('user_config', JSON.stringify(machineConfig));
  }, [machineConfig]);
  
  const [showSettings, setShowSettings] = useState(false);
  const [showDebugStream, setShowDebugStream] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<'notebook' | 'dashboard'>('notebook');
  // Feedback composition state (showFeedbackModal, compiledFeedback,
  // activeFeedbackEntryId, isSendingFeedback, isResolvingEmail, isDrafting)
  // is now owned by useFeedbackComposition — see hook instantiation below.
  const [account, setAccount] = useState<any | null>(() => {
    const saved = sessionStorage.getItem('msal_account');
    return saved ? JSON.parse(saved) : null;
  });
  const [accessToken, setAccessToken] = useState<string | null>(() => {
    return sessionStorage.getItem('msal_token');
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [isInteracting, setIsInteracting] = useState(false);
  const hasDebugActivity = logs.length > 0 || isInteracting;
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [hasGeminiKey, setHasGeminiKey] = useState(true);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);

  // Firestore teacher preferences — loaded early so userConfig merge is available
  // to all handlers. Migration from localStorage runs inside the hook on first load.
  const { preferences, preferencesLoading, savePref, saveDefault: saveFfItemCountDefault, savePriorFeedbackDefault } =
    useUserPreferences(db, firebaseUser?.uid);

  // Merged userConfig: machine-local (filterStrings, sync) from localStorage state,
  // pedagogical (tone, sign-off, models) from Firestore preferences.
  const userConfig: UserConfig = useMemo(() => ({
    ...machineConfig,
    feedbackTone: preferences.feedbackTone,
    teacherDisplayName: preferences.teacherDisplayName,
    customSignOff: preferences.customSignOff,
    aiModelFeedback: preferences.aiModelFeedback,
    aiModelParsing: preferences.aiModelParsing,
  }), [machineConfig, preferences]);

  const [dbStatus, setDbStatus] = useState<'connecting' | 'connected' | 'offline'>('connecting');
  const firestoreAutoConnectAttemptRef = useRef<string | null>(null);

  const getFirestoreAutoConnectKey = (nextAccount: any | null): string | null =>
    nextAccount?.homeAccountId || nextAccount?.localAccountId || nextAccount?.username || null;

  const markFirestoreAutoConnectAttempted = (nextAccount: any | null) => {
    const key = getFirestoreAutoConnectKey(nextAccount);
    if (!key) return;
    firestoreAutoConnectAttemptRef.current = key;
    sessionStorage.setItem(`firestore_auto_connect:${key}`, '1');
  };

  const clearFirestoreAutoConnectAttempt = (nextAccount: any | null) => {
    const key = getFirestoreAutoConnectKey(nextAccount);
    if (!key) return;
    if (firestoreAutoConnectAttemptRef.current === key) {
      firestoreAutoConnectAttemptRef.current = null;
    }
    sessionStorage.removeItem(`firestore_auto_connect:${key}`);
  };

  const hasAttemptedFirestoreAutoConnect = (nextAccount: any | null): boolean => {
    const key = getFirestoreAutoConnectKey(nextAccount);
    if (!key) return false;
    return (
      firestoreAutoConnectAttemptRef.current === key ||
      sessionStorage.getItem(`firestore_auto_connect:${key}`) === '1'
    );
  };

  // --- Firebase Auth ---
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          setAccount(data.account);
          addLog(`Connected: ${data.account.username}`);
        }
      } catch (e) {
        console.error("Auth check failed", e);
      } finally {
        setIsCheckingAuth(false);
      }
    };

    checkAuth();

    const handleMessage = (event: MessageEvent) => {
      // Only trust auth messages from our own origin. The OAuth callback popup is
      // served by this same Express server (/auth/callback), so a legitimate
      // OAUTH_AUTH_SUCCESS always arrives same-origin. Rejecting other origins
      // closes the token-injection / token-theft vector that an unvalidated
      // listener would otherwise expose if the app were ever framed or opened
      // by another window.
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        if (event.data.account) {
          setAccount(event.data.account);
          if (event.data.accessToken) {
            setAccessToken(event.data.accessToken);
            sessionStorage.setItem('msal_account', JSON.stringify(event.data.account));
            sessionStorage.setItem('msal_token', event.data.accessToken);
          }
          addLog(`Connected: ${event.data.account.username}`);
          setIsCheckingAuth(false);
        } else {
          checkAuth();
        }
      }
    };
    window.addEventListener('message', handleMessage);

    async function testConnection(retries = 3) {
      try {
        setDbStatus('connecting');
        // Try to fetch the test connection document from server
        await getDocFromServer(doc(db, 'test', 'connection'));
        setDbStatus('connected');
        addLog("Firestore connection established.");
      } catch (error: any) {
        console.warn(`Connection attempt failed (retries left: ${retries}):`, error.message);
        
        if (retries > 0) {
          setTimeout(() => testConnection(retries - 1), 2000);
          return;
        }

        if (error.code === 'unavailable' || (error.message && error.message.includes('offline'))) {
          console.error("Firestore connection failed: The client is offline or backend is unreachable.", error);
          addLog("Firestore connection failed: The client is offline. Retrying in background...");
          setDbStatus('offline');
          // Try again in 10 seconds
          setTimeout(() => testConnection(0), 10000);
        } else {
          // Other errors (like permission denied) mean we ARE connected to the service
          console.log("Firestore connection test result:", error.code || error.message);
          setDbStatus('connected');
        }
      }
    }
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (user) {
        // Ensure user profile exists in Firestore
        const ensureProfile = async (retries = 2) => {
          try {
            const userRef = doc(db, 'users', user.uid);
            const userSnap = await getDoc(userRef);
            recordRead('user:get', 1);
            if (!userSnap.exists()) {
              await setDoc(userRef, {
                uid: user.uid,
                email: user.email,
                role: 'teacher',
                createdAt: new Date().toISOString()
              });
              addLog("User profile created.");
            }
          } catch (e: any) {
            console.error("Error ensuring user profile:", e);
            if (retries > 0 && (e.code === 'unavailable' || e.message?.includes('offline'))) {
              addLog("Firestore unavailable, retrying profile sync...");
              setTimeout(() => ensureProfile(retries - 1), 3000);
            } else {
              addLog(`Error ensuring user profile: ${e.message || String(e)}`);
            }
          }
        };
        ensureProfile();
      }
    });

    return () => {
      unsubscribe();
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  const handleFirebaseLogin = async (options?: { autoTrigger?: boolean }) => {
    try {
      if (auth.currentUser) return;
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      addLog(options?.autoTrigger ? "Connected to Firestore automatically." : "Connected to Firebase Database.");
    } catch (error: any) {
      console.error("Firebase login error:", error);
      if (options?.autoTrigger) {
        addLog(`Automatic Firestore sign-in did not complete: ${error?.message || String(error)}. You can still use Connect Firestore manually.`);
      } else {
        setError(`Database Auth Error: ${error.message}`);
      }
    }
  };

  const handleFirebaseLogout = async () => {
    try {
      await auth.signOut();
      addLog("Disconnected from Firebase Database.");
    } catch (error) {
      console.error("Firebase logout error:", error);
    }
  };

  useEffect(() => {
    if (!account || firebaseUser) return;
    if (hasAttemptedFirestoreAutoConnect(account)) return;

    markFirestoreAutoConnectAttempted(account);
    addLog('Microsoft connected. Attempting Firestore sign-in...');
    void handleFirebaseLogin({ autoTrigger: true });
  }, [account, firebaseUser]);

  // --- Gemini Key Check ---
  useEffect(() => {
    const checkGeminiKey = async () => {
      if (window.aistudio?.hasSelectedApiKey) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        setHasGeminiKey(hasKey);
      }
    };
    checkGeminiKey();
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio?.openSelectKey) {
      await window.aistudio.openSelectKey();
      setHasGeminiKey(true);
    }
  };

  // --- Data State ---
  const [syncMode, setSyncMode] = useState<'diary' | 'assignments'>('diary');
  const [showAllNotebooks, setShowAllNotebooks] = useState(false);
  const [selectedNotebookIds, setSelectedNotebookIds] = useState<Set<string>>(new Set());
  const [classes, setClasses] = useState<EducationClass[]>([]);
  const [lastDiscoveryAt, setLastDiscoveryAt] = useState<string | null>(null);
  // Slice 5: bumped after each sync run so the archive-capture hook re-reads.
  const [captureRefreshKey, setCaptureRefreshKey] = useState(0);
  // Archive capture status per class — owned by the hook, scoped to selected classes.
  const archiveCaptureByClass = useArchiveCaptureStatus(
    db,
    firebaseUser?.uid,
    Array.from(selectedNotebookIds),
    captureRefreshKey
  );
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [lastParseUsedAI, setLastParseUsedAI] = useState(false);
  const [lastParseFailureMode, setLastParseFailureMode] = useState<ParserMode | null>(null);
  const [syncingClassId, setSyncingClassId] = useState<string | null>(null);

  const selectedNotebookStorageKey = `selected_notebooks_${syncMode}`;
  const discoveredClassesStorageKey = `discovered_classes_${syncMode}`;
  
  // Load persisted selection when mode changes
  useEffect(() => {
    const loadRoster = async () => {
      const cachedClasses = loadDiscoveredClassesCache();
      if (firebaseUser) {
        try {
          const rosterRef = collection(db, 'users', firebaseUser.uid, 'roster');
          const snapshot = await getDocs(rosterRef);
          recordRead('roster:load', snapshot.size);
          const ids = snapshot.docs.map(doc => doc.id);
          setSelectedNotebookIds(new Set(ids));
          
          const savedClasses = snapshot.docs.map(doc => {
            const data = doc.data();
            return withClassDefaults({
              id: data.classId,
              displayName: data.displayName,
              description: data.description || '',
              accessStatus: 'accessible' as const,
              rosterStatus: 'saved' as const,
            });
          });
          const metadataMap = await loadClassMetadataMap(db, firebaseUser.uid, ids);
          const identityMap = await loadClassStudentIdentityMap(db, firebaseUser.uid, ids);
          const mergedSavedClasses = mergeClassMetadata(savedClasses, metadataMap).map((cls) => ({
            ...cls,
            rosterStatus: 'saved' as const,
          }));
          Object.entries(identityMap).forEach(([classId, identities]) => {
            primeClassIdentityCache(classId, identities);
          });
          setClasses(mergeClassLists(mergedSavedClasses, cachedClasses));
        } catch (e) {
          console.error("Failed to load roster from Firebase:", e);
        }
      } else {
        classIdentityMapRef.current = {};
        classIdentityLoadedRef.current = {};
        studentIdentityCacheRef.current = {};
        const saved = localStorage.getItem(selectedNotebookStorageKey);
        if (saved) {
          try {
            setSelectedNotebookIds(new Set(JSON.parse(saved)));
          } catch (e) {
            setSelectedNotebookIds(new Set());
          }
        } else {
          setSelectedNotebookIds(new Set());
        }
        setClasses(cachedClasses);
      }
    };
    loadRoster();
  }, [syncMode, firebaseUser]);

  // Save selection when it changes
  const lastRosterSyncSigRef = useRef<string>('');
  useEffect(() => {
    localStorage.setItem(selectedNotebookStorageKey, JSON.stringify(Array.from(selectedNotebookIds)));

    const saveRosterToFirebase = async () => {
      if (!firebaseUser) return;
      
      try {
        const rosterRef = collection(db, 'users', firebaseUser.uid, 'roster');
        const snapshot = await getDocs(rosterRef);
        recordRead('roster:save-diff', snapshot.size);
        const existingIds = new Set(snapshot.docs.map(doc => doc.id));
        
        // Add new ones
        for (const id of Array.from(selectedNotebookIds as Set<string>)) {
          if (!existingIds.has(id)) {
            const cls = classes.find(c => c.id === id);
            if (cls) {
              await setDoc(doc(db, 'users', firebaseUser.uid, 'roster', id), {
                classId: cls.id,
                displayName: cls.displayName,
                description: cls.description || '',
                addedAt: new Date().toISOString()
              });
              await saveClassMetadata(db, firebaseUser.uid, withClassDefaults(cls));
            }
          }
        }
        
        // Remove unselected ones
        for (const id of Array.from(existingIds)) {
          if (!selectedNotebookIds.has(id)) {
            await deleteDoc(doc(rosterRef, id));
          }
        }
      } catch (e) {
        console.error("Failed to save roster to Firebase:", e);
      }
    };
    
    // The roster only needs syncing to Firestore when the *selection* (or user/mode)
    // changes. `classes` stays a dependency so the localStorage write and the `cls`
    // lookup use current data, but it changes constantly (a `lastSynced` update on every
    // sync finalize, metadata merges, etc.). Gate the Firestore read+diff on a selection
    // signature so a classes-only change does not re-read the whole roster collection.
    // The `classes.length > 0` guard still prevents wiping the roster on initial load.
    if (classes.length > 0) {
      const selectionSig = `${firebaseUser?.uid || ''}|${syncMode}|${Array.from(selectedNotebookIds).sort().join(',')}`;
      if (selectionSig !== lastRosterSyncSigRef.current) {
        lastRosterSyncSigRef.current = selectionSig;
        saveRosterToFirebase();
      }
    }
  }, [selectedNotebookIds, syncMode, firebaseUser, classes]);

  useEffect(() => {
    if (classes.length > 0) {
      saveDiscoveredClassesCache(classes, lastDiscoveryAt || undefined);
    }
  }, [classes, discoveredClassesStorageKey, lastDiscoveryAt]);

  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [notebookTree, setNotebookTree] = useState<NotebookNode[]>([]);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(`notebook_tree_${syncMode}_v1`);
      if (!raw) return;
      const { tree, savedAt } = JSON.parse(raw) as { tree: NotebookNode[]; savedAt: number };
      if (Date.now() - savedAt > 24 * 60 * 60 * 1000) return;
      setNotebookTree(tree);
      const expanded = new Set<string>();
      tree.forEach((nb: NotebookNode) => {
        expanded.add(nb.id);
        nb.children?.forEach((sg: NotebookNode) => expanded.add(sg.id));
      });
      setExpandedNodes(expanded);
    } catch { /* malformed cache — ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncMode]);
  const [selectedPageContent, setSelectedPageContent] = useState<string | null>(null);
  const [parsedPageContent, setParsedPageContent] = useState<ParsedPageContent | null>(null);
  const [parsedCache, setParsedCache] = useState<Record<string, ParsedPageContent>>({});
  const [contentCache, setContentCache] = useState<Record<string, string>>({});
  const [teacherFeedback, setTeacherFeedback] = useState<Record<string, TeacherFeedbackFields>>({}); // entryId -> fields
  const [activeFeedbackEntryIndex, setActiveFeedbackEntryIndex] = useState(0);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const [viewMode, setViewMode] = useState<'parsed' | 'raw'>('parsed');
  // aiPrompts now come from Firestore preferences (migrated in Slice 7b).
  // The hook migrates legacy 'ai_eval_prompts' localStorage key automatically.
  const aiPrompts = preferences.aiPrompts;
  const [selectedPageTitle, setSelectedPageTitle] = useState<string>('');
  const [activePageId, setActivePageId] = useState<string>('');
  const [activePageLastModified, setActivePageLastModified] = useState<string | undefined>(undefined);
  const [activeClassId, setActiveClassId] = useState<string>('');
  const [entryStatus, setEntryStatus] = useState<Record<string, 'draft' | 'reviewed' | 'approved'>>({});
  const [loadingPage, setLoadingPage] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [isMarkingAllReady, setIsMarkingAllReady] = useState(false);
  const [isSyncingClass, setIsSyncingClass] = useState(false);
  const isSyncingClassRef = useRef(false);
  const [syncProgress, setSyncProgress] = useState({ current: 0, total: 0, status: '' });
  const [resumePrompt, setResumePrompt] = useState<{ job: SyncJob; queued: number; rateLimited: number } | null>(null);
  const [markAllReadySuccess, setMarkAllReadySuccess] = useState(false);
  const [openWarningPanel, setOpenWarningPanel] = useState<string | null>(null);
  const [syncingPages, setSyncingPages] = useState(false);
  const [pageSyncStateCache, setPageSyncStateCache] = useState<Record<string, PageSyncState>>({});

  const getClassParserConfig = (classId: string) => {
    const cls = classes.find((item) => item.id === classId);
    return {
      parserMode: cls?.parserMode || DEFAULT_PARSER_MODE,
      templateVersion: cls?.templateVersion || DEFAULT_TEMPLATE_VERSION,
    };
  };

  const mergeClassLists = (primary: EducationClass[], secondary: EducationClass[]) => {
    const merged = new Map<string, EducationClass>();
    secondary.forEach((cls) => merged.set(cls.id, withClassDefaults(cls)));
    primary.forEach((cls) => merged.set(cls.id, withClassDefaults({ ...(merged.get(cls.id) || {}), ...cls } as EducationClass)));
    return Array.from(merged.values());
  };

  const loadDiscoveredClassesCache = (): EducationClass[] => {
    const cached = localStorage.getItem(discoveredClassesStorageKey);
    if (!cached) {
      setLastDiscoveryAt(null);
      return [];
    }

    try {
      const parsed = JSON.parse(cached) as { fetchedAt?: string; classes?: EducationClass[] };
      setLastDiscoveryAt(parsed.fetchedAt || null);
      return (parsed.classes || []).map((cls) =>
        withClassDefaults({
          ...cls,
          rosterStatus: cls.rosterStatus || 'discovered',
        })
      );
    } catch {
      setLastDiscoveryAt(null);
      return [];
    }
  };

  const saveDiscoveredClassesCache = (classList: EducationClass[], fetchedAtOverride?: string) => {
    const fetchedAt = fetchedAtOverride || new Date().toISOString();
    localStorage.setItem(
      discoveredClassesStorageKey,
      JSON.stringify({
        fetchedAt,
        classes: classList.map((cls) => ({
          id: cls.id,
          displayName: cls.displayName,
          description: cls.description,
          accessStatus: cls.accessStatus || 'accessible',
          parserMode: cls.parserMode || DEFAULT_PARSER_MODE,
          templateVersion: cls.templateVersion || DEFAULT_TEMPLATE_VERSION,
          rosterStatus: cls.rosterStatus || 'discovered',
          lastSynced: cls.lastSynced,
        })),
      })
    );
    setLastDiscoveryAt(fetchedAt);
  };
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<AnalysisTemplate>('holistic');
  const [activeScenario, setActiveScenario] = useState<Scenario>('balanced');
  const [showTreeMenu, setShowTreeMenu] = useState(true);
  const [showAIPanel, setShowAIPanel] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === 'true'
  );
  const [zoomLevel, setZoomLevel] = useState(100);
  const [rawIframeHeight, setRawIframeHeight] = useState(900);
  const [graphCooldownUntil, setGraphCooldownUntil] = useState<string | null>(() => localStorage.getItem('graph_cooldown_until'));
  const [geminiCooldownUntil, setGeminiCooldownUntil] = useState<string | null>(() => localStorage.getItem('gemini_cooldown_until'));
  const [pageSnapshotMeta, setPageSnapshotMeta] = useState<PageSnapshotMeta | null>(null);
  const [pageSnapshotMetaCache, setPageSnapshotMetaCache] = useState<Record<string, PageSnapshotMeta>>({});
  const [pageCacheMeta, setPageCacheMeta] = useState<Record<string, PageCacheMeta>>({});

  const studentListRef = useRef<HTMLDivElement>(null);
  const rawIframeRef = useRef<HTMLIFrameElement>(null);
  const studentIdentityCacheRef = useRef<Record<string, StudentIdentity | null>>({});
  const classIdentityMapRef = useRef<Record<string, ClassStudentIdentity[]>>({});
  const classIdentityLoadedRef = useRef<Record<string, boolean>>({});
  const previousAccountKeyRef = useRef<string | null>(getFirestoreAutoConnectKey(account));

  // The displayed stream stays capped at 50 (cheap to re-render). A larger ring
  // buffer lives in a ref — no re-renders — so the debug-log export carries real
  // history for bug hunting rather than just the last 50 lines.
  const logBufferRef = useRef<string[]>([]);
  const LOG_BUFFER_MAX = 1000;
  const addLog = (msg: string) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logBufferRef.current.push(line);
    if (logBufferRef.current.length > LOG_BUFFER_MAX) {
      logBufferRef.current.splice(0, logBufferRef.current.length - LOG_BUFFER_MAX);
    }
    setLogs(prev => [line, ...prev].slice(0, 50));
  };

  // Export the full buffered debug log (chronological) plus the session read
  // summary as a downloadable .txt — for attaching to a bug report.
  const handleSaveLog = () => {
    const header = [
      `Diary Pipeline — debug log export`,
      `Exported: ${new Date().toISOString()}`,
      `User: ${firebaseUser?.email || account?.username || 'unknown'}`,
      '',
      formatReadSummary(),
      '',
      `--- log (${logBufferRef.current.length} lines, oldest first) ---`,
      '',
    ].join('\n');
    const body = logBufferRef.current.join('\n');
    const blob = new Blob([`${header}\n${body}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diary-debug-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog('Debug log exported.');
  };

  const getStudentIdentityCacheKey = (classId: string, studentName: string): string =>
    `${classId}::${studentName.trim().toLowerCase()}`;

  const normalizeComparableName = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Strip the "?" / "*" status prefixes that graphService adds when a page title
  // doesn't contain a recognisable student ID. These markers are display-only and
  // must never reach Firestore or the detail-view title.
  const cleanNotebookDisplayName = (value: string): string =>
    value.replace(/^[*?]\s*/, '').trim();

  const cleanNotebookStudentName = (value: string): string =>
    value.replace(/^[*?]\s*/, '').replace(/^\d{7}\s*[-:]\s*/, '').trim();

  const extractStudentNumber = (value: string): string | null => {
    const directMatch = value.match(/(?<!\d)\d{7}(?!\d)/);
    if (directMatch) return directMatch[0];

    const upnStyleMatch = value.match(/[a-z]{2}(\d{7})/i);
    return upnStyleMatch ? upnStyleMatch[1] : null;
  };

  const sortClassIdentities = (identities: ClassStudentIdentity[]): ClassStudentIdentity[] =>
    [...identities].sort((a, b) => {
      if (a.studentNumber && b.studentNumber && a.studentNumber !== b.studentNumber) {
        return a.studentNumber.localeCompare(b.studentNumber);
      }
      return a.displayName.localeCompare(b.displayName);
    });

  const primeClassIdentityCache = (
    classId: string,
    identities: ClassStudentIdentity[]
  ): ClassStudentIdentity[] => {
    const deduped = new Map<string, ClassStudentIdentity>();
    identities.forEach((identity) => {
      if (!identity.graphId || !identity.upn) return;
      deduped.set(identity.graphId, {
        ...identity,
        classId,
        updatedAt: identity.updatedAt || new Date().toISOString(),
        studentNumber:
          identity.studentNumber ||
          extractStudentNumber(`${identity.upn} ${identity.mail || ''}`) ||
          undefined,
      });
    });

    const normalized = sortClassIdentities(Array.from(deduped.values()));
    classIdentityMapRef.current[classId] = normalized;
    classIdentityLoadedRef.current[classId] = true;
    return normalized;
  };

  const toStoredClassIdentity = (
    classId: string,
    identity: StudentIdentity
  ): ClassStudentIdentity => ({
    classId,
    graphId: identity.graphId,
    displayName: identity.displayName,
    upn: identity.upn,
    mail: identity.mail,
    studentNumber: extractStudentNumber(`${identity.upn} ${identity.mail || ''}`) || undefined,
    updatedAt: new Date().toISOString(),
  });

  const matchStudentIdentityFromRoster = (
    query: string,
    identities: ClassStudentIdentity[]
  ): StudentIdentity | null => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || identities.length === 0) return null;

    const studentNumber = extractStudentNumber(normalizedQuery);
    if (studentNumber) {
      const numberMatch = identities.find((identity) =>
        identity.studentNumber === studentNumber ||
        identity.upn.toLowerCase().includes(studentNumber) ||
        (identity.mail || '').toLowerCase().includes(studentNumber)
      );
      if (numberMatch) {
        return {
          graphId: numberMatch.graphId,
          displayName: numberMatch.displayName,
          upn: numberMatch.upn,
          mail: numberMatch.mail,
        };
      }
    }

    const cleanName = normalizedQuery.replace(/^\d+[-:\s]+/, '').trim();
    const lowerName = cleanName.toLowerCase();
    const comparableName = normalizeComparableName(cleanName);

    const exactMatch = identities.find((identity) => identity.displayName.toLowerCase() === lowerName);
    if (exactMatch) {
      return {
        graphId: exactMatch.graphId,
        displayName: exactMatch.displayName,
        upn: exactMatch.upn,
        mail: exactMatch.mail,
      };
    }

    if (comparableName) {
      const normalizedExactMatch = identities.find(
        (identity) => normalizeComparableName(identity.displayName) === comparableName
      );
      if (normalizedExactMatch) {
        return {
          graphId: normalizedExactMatch.graphId,
          displayName: normalizedExactMatch.displayName,
          upn: normalizedExactMatch.upn,
          mail: normalizedExactMatch.mail,
        };
      }
    }

    const partialMatch = identities.find((identity) => {
      const dirName = identity.displayName.toLowerCase();
      return dirName.includes(lowerName) || lowerName.includes(dirName);
    });
    if (partialMatch) {
      return {
        graphId: partialMatch.graphId,
        displayName: partialMatch.displayName,
        upn: partialMatch.upn,
        mail: partialMatch.mail,
      };
    }

    if (comparableName) {
      const normalizedPartialMatch = identities.find((identity) => {
        const dirName = normalizeComparableName(identity.displayName);
        return dirName.includes(comparableName) || comparableName.includes(dirName);
      });
      if (normalizedPartialMatch) {
        return {
          graphId: normalizedPartialMatch.graphId,
          displayName: normalizedPartialMatch.displayName,
          upn: normalizedPartialMatch.upn,
          mail: normalizedPartialMatch.mail,
        };
      }
    }

    const upnLocalPart = normalizedQuery.includes('@')
      ? normalizedQuery.split('@')[0].toLowerCase()
      : normalizedQuery.toLowerCase();
    const upnMatch = identities.find((identity) => {
      const localPart = identity.upn.split('@')[0]?.toLowerCase() || '';
      return localPart === upnLocalPart;
    });
    if (upnMatch) {
      return {
        graphId: upnMatch.graphId,
        displayName: upnMatch.displayName,
        upn: upnMatch.upn,
        mail: upnMatch.mail,
      };
    }

    return null;
  };

  const ensureClassIdentityMapLoaded = async (
    classId: string,
    options: { refresh?: boolean; allowGraphFetch?: boolean } = {}
  ): Promise<ClassStudentIdentity[]> => {
    const { refresh = false, allowGraphFetch = false } = options;
    if (!classId || classId.startsWith('nb_')) return [];

    const cachedIdentities = classIdentityMapRef.current[classId] || [];
    if (
      !refresh &&
      classIdentityLoadedRef.current[classId] &&
      (cachedIdentities.length > 0 || !allowGraphFetch)
    ) {
      return cachedIdentities;
    }

    if (firebaseUser) {
      try {
        const storedIdentities = await loadClassStudentIdentityMap(db, firebaseUser.uid, [classId]);
        const cached = primeClassIdentityCache(classId, storedIdentities[classId] || []);
        if (cached.length > 0 || !allowGraphFetch) {
          return cached;
        }
      } catch (error) {
        console.error('Failed to load class identity map from Firestore', error);
      }
    }

    if (allowGraphFetch) {
      try {
        const graph = new GraphService(accessToken || undefined, true);
        const graphIdentities = await graph.listClassStudentIdentities(classId);
        const stored = primeClassIdentityCache(
          classId,
          graphIdentities.map((identity) => toStoredClassIdentity(classId, identity))
        );
        if (firebaseUser) {
          await replaceClassStudentIdentities(db, firebaseUser.uid, classId, stored);
        }
        return stored;
      } catch (error) {
        console.error('Failed to refresh class identity map from Graph', error);
      }
    }

    return primeClassIdentityCache(classId, []);
  };

  const resolveStudentIdentityForClass = async (
    studentName: string,
    classId: string,
    options: { allowGraphFallback?: boolean } = {}
  ): Promise<StudentIdentity | null> => {
    const { allowGraphFallback = true } = options;
    const normalizedName = studentName.trim();
    if (!normalizedName || !classId) return null;

    const cacheKey = getStudentIdentityCacheKey(classId, normalizedName);
    if (cacheKey in studentIdentityCacheRef.current) {
      return studentIdentityCacheRef.current[cacheKey];
    }

    const rosterIdentities = await ensureClassIdentityMapLoaded(classId, {
      allowGraphFetch: false,
    });
    const rosterMatch = matchStudentIdentityFromRoster(normalizedName, rosterIdentities);
    if (rosterMatch) {
      studentIdentityCacheRef.current[cacheKey] = rosterMatch;
      return rosterMatch;
    }

    if (!allowGraphFallback) return null;

    try {
      const graph = new GraphService(accessToken || undefined, true);
      const identity = await graph.resolveStudentIdentity(normalizedName, classId);
      if (identity && firebaseUser && !classId.startsWith('nb_')) {
        const storedIdentity = toStoredClassIdentity(classId, identity);
        await saveClassStudentIdentity(db, firebaseUser.uid, storedIdentity);
        primeClassIdentityCache(classId, [
          ...(classIdentityMapRef.current[classId] || []),
          storedIdentity,
        ]);
      }
      studentIdentityCacheRef.current[cacheKey] = identity;
      return identity;
    } catch (error) {
      console.error('Failed to resolve student identity', error);
      studentIdentityCacheRef.current[cacheKey] = null;
      return null;
    }
  };

  const pageMetadataLookup = useMemo(() => {
    const lookup: Record<
      string,
      {
        pageTitle: string;
        studentName: string;
        diaryGroupId?: string;
        diaryGroupName?: string;
      }
    > = {};

    notebookTree.forEach((classNode) => {
      classNode.children?.forEach((sectionGroup) => {
        sectionGroup.children?.forEach((section) => {
          section.children?.forEach((page) => {
            lookup[page.id] = {
              pageTitle: cleanNotebookDisplayName(page.displayName || ''),
              studentName: cleanNotebookStudentName(page.displayName || ''),
              diaryGroupId: section.id,
              diaryGroupName: section.displayName,
            };
          });
        });
      });
    });

    return lookup;
  }, [notebookTree]);

  // Batch-load page sync states from Firestore when the notebook tree is populated.
  // This populates the tree-level dot badges without requiring each page to be opened first.
  useEffect(() => {
    if (!firebaseUser || notebookTree.length === 0) return;
    const classIds = notebookTree.map(nb => nb.id);
    listPageSyncRecordsForClasses(db, firebaseUser.uid, classIds)
      .then(records => {
        setPageSyncStateCache(prev => {
          const next = { ...prev };
          records.forEach(r => { next[r.pageId] = r.syncState; });
          return next;
        });
      })
      .catch(err => console.warn('Failed to load page sync states for tree:', err));
  }, [notebookTree, firebaseUser]);

  const ensureUniqueEntryIds = (pageId: string, parsedEntries: ParsedPageContent): ParsedPageContent => {
    const usedIds = new Set<string>();
    return parsedEntries.map((entry, idx) => {
      let baseId = entry.id;
      if (!baseId) {
        if (entry.date) baseId = `date_${entry.date.replace(/[^a-zA-Z0-9]/g, '')}`;
        else if (entry.weekNumber) baseId = `week_${entry.weekNumber.replace(/[^a-zA-Z0-9]/g, '')}`;
        else baseId = `idx${idx}`;
      }

      const normalizedBaseId = baseId.startsWith(pageId) ? baseId : `${pageId}_${baseId}`;
      let uniqueId = normalizedBaseId;
      let counter = 1;
      while (usedIds.has(uniqueId)) {
        uniqueId = `${normalizedBaseId}_${counter}`;
        counter++;
      }
      usedIds.add(uniqueId);

      return {
        ...entry,
        id: uniqueId.replace(/!/g, '__'),
      };
    });
  };

  const buildParsedEntryFingerprint = (entry: ParsedDiaryEntry): string =>
    [
      normalizeSnapshotText(entry.date || ''),
      normalizeSnapshotText(entry.weekNumber || ''),
      normalizeSnapshotText(entry.weather || ''),
      normalizeSnapshotText(entry.diaryText || ''),
      entry.photoCount || 0,
      normalizeSnapshotText(JSON.stringify(entry.peerFeedback || [])),
      normalizeSnapshotText(JSON.stringify(entry.vocabItems || [])),
      normalizeSnapshotText(JSON.stringify(entry.translations || [])),
      normalizeSnapshotText(JSON.stringify(entry.chatbotFeedback || { present: false, data: '' })),
    ].join('|');

  const buildParsedEntrySlotKey = (entry: ParsedDiaryEntry, index: number): string => {
    const dateKey = normalizeSnapshotText(entry.date || '');
    const weekKey = normalizeSnapshotText(entry.weekNumber || '');
    if (dateKey || weekKey) return `slot:${dateKey}|${weekKey}`;

    const diaryKey = normalizeSnapshotText(entry.diaryText || '').slice(0, 160);
    return diaryKey ? `diary:${diaryKey}` : `idx:${index}`;
  };

  const isGenericParsedId = (entryId?: string): boolean =>
    /^(?:entry_\d+|idx\d+)(?:_\d+)?$/i.test(String(entryId || ''));

  const getParsedEntryRichnessScore = (entry: ParsedDiaryEntry): number =>
    [
      entry.date ? 1 : 0,
      entry.weekNumber ? 1 : 0,
      entry.weather ? 1 : 0,
      entry.diaryText ? Math.min(4, Math.ceil(entry.diaryText.length / 120)) : 0,
      entry.peerFeedback.length > 0 ? 2 : 0,
      entry.vocabItems.length > 0 ? 1 : 0,
      entry.translations.length > 0 ? 1 : 0,
      entry.chatbotFeedback.present ? 1 : 0,
      entry.photoCount > 0 ? 1 : 0,
    ].reduce((sum, value) => sum + value, 0);

  const preferParsedEntry = (current: ParsedDiaryEntry, candidate: ParsedDiaryEntry): ParsedDiaryEntry => {
    const currentGeneric = isGenericParsedId(current.id);
    const candidateGeneric = isGenericParsedId(candidate.id);
    if (currentGeneric !== candidateGeneric) {
      return candidateGeneric ? current : candidate;
    }

    const currentScore = getParsedEntryRichnessScore(current);
    const candidateScore = getParsedEntryRichnessScore(candidate);
    if (candidateScore !== currentScore) {
      return candidateScore > currentScore ? candidate : current;
    }

    return (candidate.diaryText || '').length > (current.diaryText || '').length ? candidate : current;
  };

  const collapseParsedEntries = (entries: ParsedPageContent): ParsedPageContent => {
    const byFingerprint = new Map<string, ParsedDiaryEntry>();
    entries.forEach((entry) => {
      const fingerprint = buildParsedEntryFingerprint(entry);
      const existing = byFingerprint.get(fingerprint);
      byFingerprint.set(fingerprint, existing ? preferParsedEntry(existing, entry) : entry);
    });

    const bySlot = new Map<string, ParsedDiaryEntry>();
    Array.from(byFingerprint.values()).forEach((entry, index) => {
      const slotKey = buildParsedEntrySlotKey(entry, index);
      const existing = bySlot.get(slotKey);
      bySlot.set(slotKey, existing ? preferParsedEntry(existing, entry) : entry);
    });

    return Array.from(bySlot.values());
  };

  const remapSavedEntryState = (
    parsedEntries: ParsedPageContent,
    reconstructedEntries: ParsedDiaryEntry[],
    statusMap: Record<string, EntryStatus>,
    feedbackMap: Record<string, TeacherFeedbackFields>
  ) => {
    const remappedStatus = { ...statusMap };
    const remappedFeedback = { ...feedbackMap };
    const usedSavedIds = new Set<string>();

    parsedEntries.forEach((entry, index) => {
      const parsedId = entry.id || '';
      if (!parsedId) return;

      let sourceId: string | null = statusMap[parsedId] || feedbackMap[parsedId] ? parsedId : null;
      if (!sourceId) {
        const fallbackEntry = reconstructedEntries[index];
        if (fallbackEntry?.id && !usedSavedIds.has(fallbackEntry.id)) {
          sourceId = fallbackEntry.id;
        }
      }

      if (!sourceId) return;
      usedSavedIds.add(sourceId);

      if (statusMap[sourceId] && !remappedStatus[parsedId]) {
        remappedStatus[parsedId] = statusMap[sourceId];
      }

      if (feedbackMap[sourceId] && !remappedFeedback[parsedId]) {
        remappedFeedback[parsedId] = feedbackMap[sourceId];
      }
    });

    return { remappedStatus, remappedFeedback };
  };

  const isProviderRateLimitError = (error: any): boolean => {
    const message = String(error?.message || error || '');
    return /429|RESOURCE_EXHAUSTED|quota exceeded|rate limit/i.test(message);
  };

  const isGraphRateLimitError = (error: any): boolean => {
    const message = String(error?.message || error || '');
    return error?.statusCode === 429 || error?.code === 'GRAPH_RATE_LIMIT' || /429|too many requests on behalf of this user|microsoft graph rate limit/i.test(message);
  };

  const SESSION_EXPIRED_MSG = "Your Microsoft sign-in has expired. Please sign in again to continue.";

  const isSessionExpiredError = (e: any): boolean => {
    const msg = String(e?.message || e || '');
    return e?.statusCode === 401 || e?.errorCode === 'token_expired' ||
      msg.includes('IDX14100') || msg.includes('session_expired') ||
      msg.includes('401') || msg.includes('expired');
  };

  const extractRetryDelayMs = (error: any): number | null => {
    const message = String(error?.message || error || '');
    const secondsMatch = message.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)\s*s/i);
    if (secondsMatch) return Math.ceil(Number(secondsMatch[1]) * 1000);
    return null;
  };

  const extractGraphRetryDelayMs = (error: any): number => {
    if (typeof error?.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)) {
      return Math.max(5000, error.retryAfterMs);
    }

    return extractRetryDelayMs(error) ?? 60000;
  };

  const buildNextRetryAt = (error: any): string | undefined => {
    const delayMs = extractRetryDelayMs(error);
    if (!delayMs) return undefined;
    return new Date(Date.now() + delayMs).toISOString();
  };

  const getActiveGraphCooldownUntil = (): string | null => {
    if (!graphCooldownUntil) return null;
    if (new Date(graphCooldownUntil).getTime() <= Date.now()) {
      setGraphCooldownUntil(null);
      return null;
    }
    return graphCooldownUntil;
  };

  const formatGraphCooldownMessage = (until: string): string =>
    `Microsoft is temporarily rate-limiting notebook requests. Saved work is safe. Please try again after ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;

  const formatFirestoreQuotaMessage = (queued?: number): string => {
    const queuedNote = queued && queued > 0 ? ` (${queued} still queued)` : '';
    return `Firestore daily free-tier read quota reached. Your sync queue is saved${queuedNote} and will resume where it left off — no work is lost. This quota resets daily (around midnight US Pacific); click Resume after it resets.`;
  };

  const startGraphCooldown = (error: any, context: string): string => {
    const retryAfterMs = extractGraphRetryDelayMs(error);
    const nextRetryAt = new Date(Date.now() + retryAfterMs).toISOString();
    setGraphCooldownUntil(nextRetryAt);
    addLog(`Microsoft Graph rate limit hit while ${context}. Cooling down until ${new Date(nextRetryAt).toLocaleTimeString()}.`);
    return nextRetryAt;
  };

  const ensureGraphReady = (context: string): boolean => {
    const activeCooldown = getActiveGraphCooldownUntil();
    if (!activeCooldown) return true;

    const message = formatGraphCooldownMessage(activeCooldown);
    setError(message);
    addLog(`Skipped ${context}: ${message}`);
    return false;
  };

  const getActiveGeminiCooldownUntil = (): string | null => {
    if (!geminiCooldownUntil) return null;
    if (new Date(geminiCooldownUntil).getTime() <= Date.now()) {
      setGeminiCooldownUntil(null);
      return null;
    }
    return geminiCooldownUntil;
  };

  const formatGeminiCooldownMessage = (until: string): string =>
    `AI parsing is rate-limited. Saved work is safe. Parsing will resume after ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;

  const startGeminiCooldown = (error: any, context: string): string => {
    const delayMs = extractRetryDelayMs(error) ?? 60000;
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    setGeminiCooldownUntil(nextRetryAt);
    addLog(`Gemini rate limit hit while ${context}. AI parsing paused until ${new Date(nextRetryAt).toLocaleTimeString()}.`);
    return nextRetryAt;
  };

  const getGraphBatchConfig = () => ({
    batchSize: Math.max(1, Math.min(userConfig.syncBatchSize, 2)),
    delayMs: Math.max(userConfig.syncDelayBetweenBatches, 1500),
  });

  const deriveSnapshotBadgeState = (statuses: EntryStatus[]): PageSnapshotBadgeState => {
    if (statuses.length === 0) return 'unsaved';
    const normalized = statuses.map((status) => (status === 'approved' ? 'approved' : 'draft'));
    const allApproved = normalized.every((status) => status === 'approved');
    const allDraft = normalized.every((status) => status === 'draft');
    if (allApproved) return 'approved';
    if (allDraft) return 'draft';
    return 'mixed';
  };

  const buildSnapshotMeta = (
    statuses: EntryStatus[],
    options: {
      stale: boolean;
      source: 'saved' | 'fresh-parse';
      parseFallbackUsed?: boolean;
      message?: string;
    }
  ): PageSnapshotMeta => ({
    badgeState: deriveSnapshotBadgeState(statuses),
    stale: options.stale,
    source: options.source,
    parseFallbackUsed: options.parseFallbackUsed ?? false,
    message: options.message,
  });

  const getSnapshotBadgeLabel = (meta: PageSnapshotMeta): string => {
    if (meta.stale) {
      if (meta.badgeState === 'unsaved') return 'Stale Snapshot';
      if (meta.badgeState === 'approved') return 'Stale Feedback Ready';
      return `Stale ${meta.badgeState}`;
    }
    switch (meta.badgeState) {
      case 'approved':
        return 'Feedback Ready';
      case 'draft':
        return 'Saved Draft';
      case 'mixed':
        return 'Mixed Status';
      default:
        return meta.source === 'fresh-parse' ? 'Unsaved Parse' : 'Saved Snapshot';
    }
  };

  const getSnapshotBadgeClassName = (meta: PageSnapshotMeta): string => {
    if (meta.stale) return 'bg-amber-50 text-amber-700 border-amber-200';
    switch (meta.badgeState) {
      case 'approved':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'draft':
        return 'bg-slate-100 text-slate-600 border-slate-200';
      case 'mixed':
        return 'bg-indigo-50 text-indigo-700 border-indigo-200';
      default:
        return 'bg-slate-50 text-slate-500 border-slate-200';
    }
  };

  const getSnapshotBadgeTooltip = (meta: PageSnapshotMeta): string => {
    if (meta.stale) return 'The OneNote source was modified after this was last saved. Re-open the page to check for changes.';
    switch (meta.badgeState) {
      case 'approved': return 'All entries on this page are saved as feedback ready.';
      case 'draft':    return 'Entries are saved as drafts. Use Mark All Ready for entries with student diary text, or save individual entries below.';
      case 'mixed':    return 'Some entries are feedback ready; others are still drafts. Review individual entries below.';
      default:
        return meta.source === 'fresh-parse'
          ? 'This page was parsed from OneNote but not yet saved. Entries will be lost if you navigate away — use Mark All Ready or Save Draft to preserve them.'
          : 'A saved snapshot of this page is available.';
    }
  };

  const getSyncDotClassName = (state: PageSyncState): string => {
    switch (state) {
      case 'saved':       return 'bg-emerald-400';
      case 'rate_limited': return 'bg-amber-400';
      case 'error':       return 'bg-red-400';
      case 'syncing':     return 'bg-indigo-400 animate-pulse';
      default:            return '';
    }
  };

  const getSyncDotTitle = (state: PageSyncState): string => {
    switch (state) {
      case 'saved':       return 'Synced';
      case 'rate_limited': return 'Waiting — rate limit. Click to retry.';
      case 'error':       return 'Sync error. Click to retry.';
      case 'syncing':     return 'Syncing…';
      default:            return '';
    }
  };

  const getNotebookSyncSummary = (nb: NotebookNode): { saved: number; errors: number; rateLimited: number; total: number } | null => {
    const pageIds: string[] = [];
    const collect = (node: NotebookNode) => {
      if (node.type === 'page') pageIds.push(node.id);
      node.children?.forEach(collect);
    };
    nb.children?.forEach(collect);
    const known = pageIds.filter(id => pageSyncStateCache[id] && pageSyncStateCache[id] !== 'idle');
    if (known.length === 0) return null;
    const saved = known.filter(id => pageSyncStateCache[id] === 'saved').length;
    const errors = known.filter(id => pageSyncStateCache[id] === 'error').length;
    const rateLimited = known.filter(id => pageSyncStateCache[id] === 'rate_limited').length;
    return { saved, errors, rateLimited, total: known.length };
  };

  const getNotebookSyncTitle = (summary: NonNullable<ReturnType<typeof getNotebookSyncSummary>>): string => {
    const parts: string[] = [`${summary.saved} of ${summary.total} pages synced`];
    if (summary.errors > 0) parts.push(`${summary.errors} failed — click the red dot to retry`);
    if (summary.rateLimited > 0) parts.push(`${summary.rateLimited} waiting on rate limit — click the amber dot to retry`);
    return parts.join(' · ');
  };

  const setActivePageSnapshotMeta = (pageId: string, meta: PageSnapshotMeta | null) => {
    setPageSnapshotMeta(meta);
    if (!pageId) return;
    setPageSnapshotMetaCache((prev) => {
      const next = { ...prev };
      if (meta) next[pageId] = meta;
      else delete next[pageId];
      return next;
    });
  };

  const clearParsedCacheForPage = (pageId: string) => {
    setParsedCache((prev) => {
      const next = { ...prev };
      delete next[pageId];
      return next;
    });
  };

  const reopenActivePage = (forceAIParse: boolean = false) => {
    if (!activePageId || !selectedPageTitle || !activeClassId) return;
    clearParsedCacheForPage(activePageId);
    handlePageClick(
      activePageId,
      selectedPageTitle,
      activeClassId,
      activeStudentName,
      activePageLastModified,
      forceAIParse
    );
  };

  const forceReparseActivePage = () => {
    if (!activePageId || !selectedPageTitle || !activeClassId) return;
    clearParsedCacheForPage(activePageId);
    handlePageClick(
      activePageId,
      selectedPageTitle,
      activeClassId,
      activeStudentName,
      activePageLastModified,
      false,
      true
    );
  };

  const setSidebarCollapsedPersisted = (v: boolean) => {
    setSidebarCollapsed(v);
    localStorage.setItem('sidebarCollapsed', String(v));
  };

  const getClassWorkspaceUnavailableReason = (): string | null => {
    if (!firebaseUser) return 'Connect Firestore before opening class dashboard or export tools.';
    if (selectedNotebookIds.size === 0) return 'Select at least one class before opening class dashboard or export tools.';
    return null;
  };

  const classWorkspaceUnavailableReason = getClassWorkspaceUnavailableReason();
  const classWorkspaceToolsReady = classWorkspaceUnavailableReason === null;

  const openClassDashboard = () => {
    if (classWorkspaceUnavailableReason) {
      setError(classWorkspaceUnavailableReason);
      return;
    }
    setWorkspaceMode('dashboard');
    setSidebarCollapsedPersisted(true);
  };

  const openExportDialog = () => {
    if (classWorkspaceUnavailableReason) {
      setError(classWorkspaceUnavailableReason);
      return;
    }
    setShowExportDialog(true);
  };

  useEffect(() => {
    const accountKey = getFirestoreAutoConnectKey(account);
    const wasDisconnected = previousAccountKeyRef.current === null;
    if (accountKey && wasDisconnected) {
      setSidebarCollapsedPersisted(false);
      setShowTreeMenu(true);
      addLog('Notebook sync panel opened.');
    }
    previousAccountKeyRef.current = accountKey;
  }, [account]);

  useEffect(() => {
    if (graphCooldownUntil) {
      localStorage.setItem('graph_cooldown_until', graphCooldownUntil);
    } else {
      localStorage.removeItem('graph_cooldown_until');
    }
  }, [graphCooldownUntil]);

  useEffect(() => {
    if (geminiCooldownUntil) {
      localStorage.setItem('gemini_cooldown_until', geminiCooldownUntil);
    } else {
      localStorage.removeItem('gemini_cooldown_until');
    }
  }, [geminiCooldownUntil]);

  const buildRawIframeDocument = (htmlContent: string, zoom: number): string => {
    const zoomScale = Math.max(0.25, zoom / 100);
    const injectedStyles = `
      <style>
        html, body {
          margin: 0;
          padding: 0;
          background: #ffffff;
        }
        body {
          zoom: ${zoomScale};
          transform-origin: top left;
          overflow-x: auto;
        }
        img {
          max-width: 100%;
          height: auto;
        }
      </style>
    `;

    if (/<html[\s>]/i.test(htmlContent)) {
      if (/<\/head>/i.test(htmlContent)) {
        return htmlContent.replace(/<\/head>/i, `${injectedStyles}</head>`);
      }
      return htmlContent.replace(/<html[^>]*>/i, (match) => `${match}<head>${injectedStyles}</head>`);
    }

    return `<!doctype html><html><head>${injectedStyles}</head><body>${htmlContent}</body></html>`;
  };

  const updateRawIframeHeight = () => {
    const iframe = rawIframeRef.current;
    if (!iframe) return;

    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const nextHeight = Math.max(
        doc.body?.scrollHeight || 0,
        doc.documentElement?.scrollHeight || 0,
        900
      );
      setRawIframeHeight(nextHeight + 24);
    } catch (error) {
      console.error('Failed to measure raw iframe height', error);
    }
  };

  const persistPageSyncState = async ({
    pageId,
    classId,
    pageTitle,
    studentName,
    diaryGroupId,
    diaryGroupName,
    studentGraphId,
    studentUpn,
    parserMode,
    templateVersion,
    syncState,
    entryCount = 0,
    oneNoteLastModified,
    lastParsedAt,
    lastViewedAt,
    lastError,
    nextRetryAt,
  }: Omit<PageSyncRecord, 'updatedAt'>) => {
    if (!firebaseUser) return;

    try {
      const rosterIdentity =
        (!studentGraphId || !studentUpn) && classId
          ? await resolveStudentIdentityForClass(
              [pageTitle, studentName].filter(Boolean).join(' ').trim(),
              classId,
              { allowGraphFallback: false }
            )
          : null;

      await savePageSyncRecord(db, firebaseUser.uid, {
        pageId,
        classId,
        pageTitle,
        studentName,
        diaryGroupId: diaryGroupId || pageMetadataLookup[pageId]?.diaryGroupId,
        diaryGroupName: diaryGroupName || pageMetadataLookup[pageId]?.diaryGroupName,
        studentGraphId: studentGraphId || rosterIdentity?.graphId,
        studentUpn: studentUpn || rosterIdentity?.upn,
        parserMode,
        templateVersion,
        syncState,
        entryCount,
        oneNoteLastModified,
        lastParsedAt,
        lastViewedAt,
        lastError,
        nextRetryAt,
        updatedAt: new Date().toISOString(),
      });
      setPageSyncStateCache(prev => ({ ...prev, [pageId]: syncState }));
    } catch (error: any) {
      console.error('Failed to persist page sync metadata', error);
      addLog(`Page sync metadata warning: ${error?.message || String(error)}`);
    }
  };

  /**
   * Defensive URL detection matched to services/authConfig.ts
   */
  const currentRedirectUri = useMemo(() => {
    let href = window.location.href;
    let cleanUrl = href.startsWith('blob:') ? href.substring(5) : href;
    const urlParts = cleanUrl.split('?');
    let baseWithHash = urlParts[0];
    
    try {
      const urlObj = new URL(baseWithHash);
      return (urlObj.origin + urlObj.pathname + urlObj.hash).replace(/\/$/, "");
    } catch (e) {
      return baseWithHash.replace(/\/$/, "");
    }
  }, []);


  // Keep ref in sync so the auto-sync effect can read it without it being a dep.
  useEffect(() => { isSyncingClassRef.current = isSyncingClass; }, [isSyncingClass]);

  // --- Auto-Sync Logic ---
  // isSyncingClass is intentionally read via ref rather than listed as a dep.
  // Adding it as a dep causes the effect to re-fire when a sync ends, which
  // re-triggers auto-sync immediately if the class is still stale (e.g. after
  // a rate-limit failure that didn't reach finalizeSyncJob) — creating a loop.
  useEffect(() => {
    if (userConfig.syncFrequency === 'manual') return;
    if (isSyncingClassRef.current || loading || syncingPages) return;
    if (!activeClassId || !firebaseUser) return;

    const activeClass = classes.find(c => c.id === activeClassId);
    if (!activeClass) return;

    const lastSyncedTime = activeClass.lastSynced ? new Date(activeClass.lastSynced).getTime() : 0;
    const now = Date.now();

    const staleThreshold = userConfig.syncFrequency === 'weekly'
      ? 7 * 24 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;

    if (now - lastSyncedTime > staleThreshold) {
      console.log(`[AutoSync] Triggering for ${activeClass.displayName}. Last sync: ${activeClass.lastSynced}. Frequency: ${userConfig.syncFrequency}`);
      addLog(`Class ${activeClass.displayName} is stale. Triggering auto-sync...`);
      handleSyncClass(activeClassId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClassId, firebaseUser, classes.length, loading, syncingPages, userConfig.syncFrequency]);

  // On login, check for in-progress sync jobs that survived a browser close.
  // Show a resume prompt rather than auto-resuming to avoid unexpected AI/Graph
  // activity when the teacher opens the app to do something else.
  useEffect(() => {
    if (!firebaseUser) return;
    let cancelled = false;
    const check = async () => {
      try {
        const jobs = await getResumableJobs(db, firebaseUser.uid);
        if (cancelled || jobs.length === 0) return;
        const job = jobs[0];
        const queued = job.counts.queued;
        const rateLimited = job.counts.rate_limited;
        if (queued > 0 || rateLimited > 0) {
          setResumePrompt({ job, queued, rateLimited });
          addLog(`Pending sync job found: ${queued} queued, ${rateLimited} rate-limited. Click Resume to continue.`);
        }
      } catch {
        // Non-fatal — resume detection is best-effort
      }
    };
    void check();
    return () => { cancelled = true; };
  }, [firebaseUser?.uid]);

  // Pre-load the class roster into the identity cache when the active class
  // changes, so Review & Send recipient resolution is instant for the common
  // case. Falls back to Firestore-cached identities first (no Graph call if
  // the cache is fresh), only hits Graph if Firestore returns empty.
  // Fires in the background — failure is silent and the lazy on-demand path
  // in resolveStudentIdentityForClass / findStudentEmail still works.
  useEffect(() => {
    if (!activeClassId || activeClassId.startsWith('nb_') || !firebaseUser) return;
    // Already warm — skip the round-trip.
    if (
      classIdentityLoadedRef.current[activeClassId] &&
      (classIdentityMapRef.current[activeClassId]?.length ?? 0) > 0
    ) return;

    void ensureClassIdentityMapLoaded(activeClassId, { allowGraphFetch: true }).then(
      (identities) => {
        if (identities.length > 0) {
          addLog(`Roster pre-loaded: ${identities.length} identities cached for class ${activeClassId}.`);
        }
      }
    ).catch(() => {
      // Non-fatal — on-demand resolution still works.
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClassId, firebaseUser?.uid]);

  // --- Handlers ---
  const handleLogin = async () => {
    if (isInteracting) return;
    
    setIsInteracting(true);
    setError(null);
    addLog("Opening Identity Popup...");
    
    try {
      const response = await fetch('/api/auth/url');
      if (!response.ok) throw new Error('Failed to get auth URL');
      const { url } = await response.json();

      const authWindow = window.open(
        url,
        'oauth_popup',
        'width=600,height=700'
      );

      if (!authWindow) {
        setError("Popup blocked. Please allow popups for this site.");
      }
    } catch (e: any) {
      addLog(`Auth Failed: ${e.message}`);
      setError(`Auth Error: ${e.message}`);
    } finally {
      setIsInteracting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout');
      clearFirestoreAutoConnectAttempt(account);
      setAccount(null);
      setAccessToken(null);
      sessionStorage.removeItem('msal_account');
      sessionStorage.removeItem('msal_token');
      setClasses([]);
      setEntries([]);
      setNotebookTree([]);
      studentIdentityCacheRef.current = {};
      classIdentityMapRef.current = {};
      classIdentityLoadedRef.current = {};
      setExpandedNodes(new Set());
      setSelectedPageContent(null);
      setSelectedNotebookIds(new Set());
      addLog("User disconnected.");
    } catch (e) {
      console.error("Logout failed", e);
    }
  };

  // Helper for batching promises
  const batchPromises = async <T, R>(items: T[], fn: (item: T) => Promise<R>, batchSize: number = 3, delay: number = 0): Promise<R[]> => {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(fn));
      results.push(...batchResults);
      
      if (delay > 0 && i + batchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return results;
  };

  const handleDiscoverAll = async () => {
    setLoading(true);
    setError(null);
    
    if (config.isSandbox) {
      setLoadingStep('Mocking Sync...');
      setTimeout(() => {
        setClasses([
          { id: '1', displayName: 'Grade 10 Biology - Period 2', description: 'Class Notebook', accessStatus: 'accessible' },
          { id: '2', displayName: 'Intro to Computer Science', description: 'Teams Group', accessStatus: 'accessible' }
        ]);
        setLoading(false);
        setLoadingStep('');
        addLog("Sandbox data synced.");
      }, 800);
      return;
    }

    if (!account) {
      setLoading(false);
      return setError("Please sign in first.");
    }

    if (!ensureGraphReady('notebook discovery')) {
      setLoading(false);
      return;
    }

    try {
      addLog(`[Telemetry] discovery_started`);
      setLoadingStep('Discovering Notebooks...');
      addLog("Executing Graph Traverse via Proxy...");
      const graph = new GraphService(accessToken || undefined, true);
      const fetched = await graph.getClasses(userConfig.filterStrings);
      
      // Default all discovered items to 'accessible' initially to avoid blocking discovery.
      // We will handle access errors gracefully during the sync phase.
      const initialClasses = fetched.map(cls =>
        withClassDefaults({
          ...cls,
          accessStatus: 'accessible' as const,
          rosterStatus: selectedNotebookIds.has(cls.id) ? 'saved' as const : 'discovered' as const,
        })
      );
      
      // Fetch class metadata from Firestore (last sync status, parser mode, etc.).
      // Seed the merge with the current in-memory parser selections so a failed or
      // partial Firestore read (e.g. during a read-quota outage) cannot silently reset a
      // class's parser mode to the AI default; Firestore values override the seed when
      // present, so the normal success path is unchanged. See ARCHITECTURE §25.
      let classesWithMetadata = initialClasses;
      if (firebaseUser) {
        const inMemoryMeta: Record<string, Partial<EducationClass>> = {};
        classes.forEach((c) => {
          if (c.parserMode) {
            inMemoryMeta[c.id] = { parserMode: c.parserMode, templateVersion: c.templateVersion };
          }
        });

        let firestoreMeta: Record<string, Partial<EducationClass>> = {};
        try {
          firestoreMeta = await loadClassMetadataMap(db, firebaseUser.uid, initialClasses.map((cls) => cls.id));
        } catch (err) {
          console.warn("Failed to fetch class metadata from Firestore", err);
          addLog("Could not load saved class settings from the database — keeping current parser-mode selections.");
        }

        const mergedMeta: Record<string, Partial<EducationClass>> = {};
        initialClasses.forEach((cls) => {
          const combined = { ...(inMemoryMeta[cls.id] || {}), ...(firestoreMeta[cls.id] || {}) };
          if (Object.keys(combined).length > 0) mergedMeta[cls.id] = combined;
        });
        classesWithMetadata = mergeClassMetadata(initialClasses, mergedMeta);
      }
      
      const mergedClasses = mergeClassLists(classesWithMetadata, classes);
      setClasses(mergedClasses);
      saveDiscoveredClassesCache(mergedClasses);
      
      addLog(`[Telemetry] discovery_completed`);
      addLog(`[Telemetry] candidates_discovered_count: ${fetched.length}`);
      
      if (initialClasses.length === 0) {
        setError("Auth success, but no Class Notebooks were detected. If your session has been active for over an hour, your token may have expired. Please click Disconnect and Connect again.");
        addLog("Search complete: 0 results. Token may be expired.");
      } else {
        setGraphCooldownUntil(null);
        addLog(`Found ${initialClasses.length} rosters.`);
      }
    } catch (e: any) {
      addLog(`Sync error: ${e.message}`);
      if (isSessionExpiredError(e)) {
        setError(SESSION_EXPIRED_MSG);
      } else if (isGraphRateLimitError(e)) {
        const nextRetryAt = startGraphCooldown(e, 'discovering notebooks');
        setError(formatGraphCooldownMessage(nextRetryAt));
      } else {
        setError(`Graph Error: ${e.message}`);
      }
    } finally {
      setLoading(false);
      setLoadingStep('');
    }
  };

  const handleSyncSelected = async () => {
    if (selectedNotebookIds.size === 0) {
      return setError("Please select at least one notebook to sync.");
    }

    if (!ensureGraphReady('selected notebook sync')) {
      return;
    }
    
    setSyncingPages(true);
    setError(null);
    setShowTreeMenu(true);
    setNotebookTree([]);
    setExpandedNodes(new Set());
    
    if (config.isSandbox) {
      setTimeout(() => {
        setEntries(generateScenarioData(activeScenario));
        setNotebookTree([
          {
            id: 'mock_nb_1',
            displayName: 'Grade 10 Biology - Period 2',
            type: 'sectionGroup',
            children: [
              {
                id: 'mock_sg_1',
                displayName: '_Collaboration Space',
                type: 'sectionGroup',
                children: [
                  {
                    id: 'mock_sec_1',
                    displayName: 'Diary Group',
                    type: 'section',
                    children: [
                      { id: 'mock_page_1', displayName: '1234567 - John Doe', type: 'page', contentUrl: '', lastModified: '10/24/2023' },
                      { id: 'mock_page_2', displayName: '7654321 - Jane Smith', type: 'page', contentUrl: '', lastModified: '10/24/2023' }
                    ]
                  }
                ]
              }
            ]
          }
        ]);
        setExpandedNodes(new Set(['mock_nb_1', 'mock_sg_1', 'mock_sec_1']));
        setSyncingPages(false);
        addLog("Mock entries loaded.");
      }, 600);
      return;
    }
    
    try {
      addLog(`[Telemetry] refresh_scope_selected_only`);
      const startTime = Date.now();
      const graph = new GraphService(accessToken || undefined, true);
      let requestCount = 0;
      const { batchSize, delayMs } = getGraphBatchConfig();
      
      const combinedTree: NotebookNode[] = (await batchPromises(
        Array.from(selectedNotebookIds),
        async (id) => {
          const cls = classes.find(c => c.id === id);
          if (!cls) return null;
          
          addLog(`Fetching structure for ${cls.displayName} in ${syncMode} mode...`);
          const tree = await graph.getNotebookStructure(cls.id, syncMode);
          requestCount++;
          
          return {
            id: cls.id,
            displayName: cls.displayName,
            type: 'sectionGroup',
            children: tree
          } as NotebookNode;
        },
        batchSize,
        delayMs
      )).filter((node): node is NotebookNode => node !== null);
      
      setNotebookTree(combinedTree);
      try {
        localStorage.setItem(
          `notebook_tree_${syncMode}_v1`,
          JSON.stringify({ tree: combinedTree, savedAt: Date.now() })
        );
      } catch { /* localStorage full — non-critical */ }
      setGraphCooldownUntil(null);

      // Auto-expand the notebooks and their first level
      const initialExpanded = new Set<string>();
      combinedTree.forEach(nbNode => {
        initialExpanded.add(nbNode.id);
        nbNode.children?.forEach(sg => initialExpanded.add(sg.id));
      });
      setExpandedNodes(initialExpanded);
      
      const duration = Date.now() - startTime;
      addLog(`[Telemetry] average_refresh_duration_ms: ${duration}`);
      addLog(`[Telemetry] requests_per_refresh: ${requestCount}`);
      addLog(`Sync complete. Loaded ${selectedNotebookIds.size} notebooks.`);
    } catch (e: any) {
      addLog(`Sync Error: ${e.message}`);
      if (isSessionExpiredError(e)) {
        setError(SESSION_EXPIRED_MSG);
      } else if (isGraphRateLimitError(e)) {
        const nextRetryAt = startGraphCooldown(e, 'syncing notebook structure');
        setError(formatGraphCooldownMessage(nextRetryAt));
      } else {
        setError(`Data extraction failed: ${e.message}`);
      }
    } finally {
      setSyncingPages(false);
    }
  };

  const toggleNode = async (id: string, type: 'sectionGroup' | 'section' | 'page') => {
    const isExpanding = !expandedNodes.has(id);
    
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

    // Lazy load pages if expanding a section and it has no children yet
    if (isExpanding && type === 'section') {
      const sectionNode = findNodeInTree(notebookTree, id);
      if (sectionNode && (!sectionNode.children || sectionNode.children.length === 0)) {
        try {
          // Find which class this section belongs to by looking at the root nodes
          let classId = "";
          for (const root of notebookTree) {
            if (findNodeInTree([root], id)) {
              classId = root.id;
              break;
            }
          }
          
          if (classId) {
            if (!ensureGraphReady('loading section pages')) {
              return;
            }

            const graph = new GraphService(accessToken || undefined, true);
            const pages = await graph.getSectionPages(classId, id);
            
            setNotebookTree(prevTree => {
              const newTree = JSON.parse(JSON.stringify(prevTree)); // Deep copy
              const node = findNodeInTree(newTree, id);
              if (node) {
                node.children = pages;
              }
              return newTree;
            });
            setGraphCooldownUntil(null);
          }
        } catch (e: any) {
          if (isGraphRateLimitError(e)) {
            const nextRetryAt = startGraphCooldown(e, 'loading section pages');
            addLog(`Failed to load pages for section ${id}: ${formatGraphCooldownMessage(nextRetryAt)}`);
          } else {
            addLog(`Failed to load pages for section ${id}: ${e.message}`);
          }
        }
      }
    }
  };

  const findNodeInTree = (tree: NotebookNode[], id: string): NotebookNode | null => {
    for (const node of tree) {
      if (node.id === id) return node;
      if (node.children) {
        const found = findNodeInTree(node.children, id);
        if (found) return found;
      }
    }
    return null;
  };

  const [activeStudentName, setActiveStudentName] = useState<string>('Student');
  const [activeStudentUpn, setActiveStudentUpn] = useState<string>('');
  const [pastFeedbackForStudent, setPastFeedbackForStudent] = useState<FeedbackHistoryRecord[]>([]);
  const [isLoadingPastFeedback, setIsLoadingPastFeedback] = useState(false);

  const [ffItemCount, setFfItemCount] = useState<FFItemCount>('3-4');
  const [priorFeedback, setPriorFeedback] = useState<PriorFeedbackMode>('off');
  const [prefsApplied, setPrefsApplied] = useState(false);

  // Initialise session controls from persisted defaults on first load.
  useEffect(() => {
    if (!preferencesLoading && !prefsApplied) {
      setFfItemCount(preferences.ffItemCount);
      setPriorFeedback(preferences.priorFeedbackMode);
      setPrefsApplied(true);
    }
  }, [preferencesLoading, prefsApplied, preferences]);

  // Fetch recent feedback for the active student. Queries by (classId, studentUpn) once
  // the UPN is resolved from the PageSyncRecord so history spans all pages for this student,
  // not just the current page. Falls back to the page-scoped query for unresolved pages
  // (e.g. owner accounts not in the class roster).
  useEffect(() => {
    if (!firebaseUser || !activePageId) {
      setPastFeedbackForStudent([]);
      return;
    }
    let cancelled = false;
    setIsLoadingPastFeedback(true);
    (async () => {
      try {
        const records = activeClassId && activeStudentUpn
          ? await fetchRecentFeedbackForStudent(db, firebaseUser.uid, activeClassId, activeStudentUpn, 5)
          : await fetchRecentFeedbackForPage(db, firebaseUser.uid, activePageId, 5);
        if (cancelled) return;
        setPastFeedbackForStudent(records);
      } catch (e: any) {
        if (cancelled) return;
        addLog(`[PastFeedback] Error: ${e?.message || String(e)}`);
        console.error('Could not load past feedback for student', e);
        setPastFeedbackForStudent([]);
      } finally {
        if (!cancelled) setIsLoadingPastFeedback(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firebaseUser?.uid, activePageId, activeClassId, activeStudentUpn]);

  // Stable callback the feedback composition hook can use to invoke
  // saveEntryToFirebase. The actual function is defined further down so
  // it can close over local state and the hook-owned setSavedTeacherFeedback;
  // the ref is rebound on every render so the hook always sees the latest
  // closure without needing to be re-created.
  const saveEntryRef = useRef<
    | ((
        entry: ParsedDiaryEntry,
        entryIndex: number,
        status: EntryStatus
      ) => Promise<void>)
    | null
  >(null);
  const saveEntryFromHook = useCallback(
    async (entry: ParsedDiaryEntry, entryIndex: number, status: EntryStatus) => {
      if (saveEntryRef.current) {
        await saveEntryRef.current(entry, entryIndex, status);
      }
    },
    []
  );

  const handleMarkUptake = async (feedbackId: string, observed: boolean) => {
    if (!firebaseUser) return;
    await markFeedbackUptake(db, firebaseUser.uid, feedbackId, observed);
    setPastFeedbackForStudent(prev =>
      prev.map(r => r.feedbackId === feedbackId
        ? { ...r, uptakeObservedAt: observed ? new Date().toISOString() : null }
        : r
      )
    );
  };

  const {
    showFeedbackModal,
    compiledFeedback,
    setCompiledFeedback,
    activeFeedbackEntryId,
    isSendingFeedback,
    isResolvingEmail,
    emailResolutionSource,
    markEmailManuallyEdited,
    isDrafting,
    batchEntryOptions,
    includedBatchPreviewItems,
    updateBatchEntryDecision,
    reviewAndSend: handleReviewAndSend,
    sendFeedback: handleSendFeedback,
    draftFeedback: handleDraftFeedback,
    closeModal: closeFeedbackModal,
    savedTeacherFeedback,
    setSavedTeacherFeedback,
    currentPageHasUnsavedFeedback,
    pageWorkflowSummary,
    confirmDiscardCurrentFeedbackChanges,
    updateTeacherFeedbackField,
    handleSaveDraft,
    handleSaveAndMarkReady,
    handleReviewAndSendEntry,
  } = useFeedbackComposition({
    accessToken,
    firebaseUser,
    db,
    account,
    userConfig,
    aiPrompts,
    parsedPageContent,
    activeStudentName,
    activeClassId,
    activePageId,
    selectedPageTitle,
    teacherFeedback,
    setTeacherFeedback,
    entryStatus,
    saveEntry: saveEntryFromHook,
    ffItemCount,
    priorFeedback,
    pastFeedbackForStudent,
    onFeedbackHistorySaved: (record) => {
      setPastFeedbackForStudent(prev =>
        [record, ...prev.filter(item => item.feedbackId !== record.feedbackId)].slice(0, 5)
      );
    },
    setError,
    addLog,
  });

  useEffect(() => {
    setActiveFeedbackEntryIndex(0);
  }, [activePageId]);

  useEffect(() => {
    if (!parsedPageContent || parsedPageContent.length === 0) {
      setActiveFeedbackEntryIndex(0);
      return;
    }
    if (activeFeedbackEntryIndex >= parsedPageContent.length) {
      setActiveFeedbackEntryIndex(parsedPageContent.length - 1);
    }
  }, [activeFeedbackEntryIndex, parsedPageContent]);

  const activeWorkflowEntry = useMemo(() => {
    if (!parsedPageContent || parsedPageContent.length === 0) return null;
    const index = Math.min(activeFeedbackEntryIndex, parsedPageContent.length - 1);
    const entry = parsedPageContent[index];
    const entryKey = entry.id || String(index);
    const workflowUiState = getEntryWorkflowUiState(
      entryStatus[entryKey],
      teacherFeedback[entryKey],
      savedTeacherFeedback[entryKey]
    );
    return { entry, entryKey, index, workflowUiState };
  }, [activeFeedbackEntryIndex, entryStatus, parsedPageContent, savedTeacherFeedback, teacherFeedback]);

  const handleWorkspaceOverview = () => {
    if (!confirmDiscardCurrentFeedbackChanges()) {
      addLog(`Stayed on ${selectedPageTitle || 'current page'} to preserve unsaved feedback changes.`);
      return;
    }

    setShowAIPanel(false);
    setShowTreeMenu(true);
    setSidebarCollapsedPersisted(false);
    setSelectedPageContent(null);
    setParsedPageContent(null);
    setSelectedPageTitle('');
    setActivePageId('');
    setActivePageLastModified(undefined);
    setActiveClassId('');
    setActiveFeedbackEntryIndex(0);
    setPageSnapshotMeta(null);
    addLog('Workspace overview opened.');
  };

  const handleParsedContentScroll = () => {
    if (!parsedPageContent || parsedPageContent.length === 0 || !contentScrollRef.current) return;
    const containerRect = contentScrollRef.current.getBoundingClientRect();
    const anchorY = containerRect.top + 32;
    let nextIndex = activeFeedbackEntryIndex;
    let nearestDistance = Number.POSITIVE_INFINITY;

    parsedPageContent.forEach((_, index) => {
      const el = document.getElementById(`entry-${index}`);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const isVisible = rect.bottom > containerRect.top + 48 && rect.top < containerRect.bottom - 48;
      if (!isVisible) return;
      const distance = Math.abs(rect.top - anchorY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nextIndex = index;
      }
    });

    if (nextIndex !== activeFeedbackEntryIndex) {
      setActiveFeedbackEntryIndex(nextIndex);
    }
  };

  const handlePageClick = async (
    pageId: string,
    pageTitle: string,
    classId: string,
    studentName?: string,
    lastModified?: string,
    forceAIParse: boolean = false,
    forceReparse: boolean = false
  ) => {
    // Prevent redundant loads for the same page, but allow switching to a different page
    if (loadingPage && activePageId === pageId) {
      addLog(`Page ${pageTitle} is already loading. Ignoring duplicate click.`);
      return;
    }

    const wouldReplaceCurrentWork =
      Boolean(activePageId) && (pageId !== activePageId || forceAIParse || forceReparse);
    if (wouldReplaceCurrentWork && !confirmDiscardCurrentFeedbackChanges()) {
      addLog(`Stayed on ${selectedPageTitle || 'current page'} to preserve unsaved feedback changes.`);
      return;
    }
    
    setLoadingPage(true);
    setLoadingMessage('Fetching from OneNote...');
    setSelectedPageContent(null);
    setParsedPageContent(null);
    setSelectedPageTitle(pageTitle);
    setActivePageId(pageId);
    setActivePageLastModified(lastModified);
    setActiveClassId(classId);
    if (studentName) setActiveStudentName(studentName);
    setActiveStudentUpn('');
    setZoomLevel(100);
    setLastParseUsedAI(forceAIParse);
    setLastParseFailureMode(null);
    setPageSnapshotMeta(pageSnapshotMetaCache[pageId] || null);
    let loadedContentForFallback: string | null = null;
    let didFreshParse = false;
    let parseFailureMode: ParserMode | null = null;
    
    try {
      let parsed = parsedCache[pageId];
      let content = contentCache[pageId];
      
      const cachedPageMeta = pageCacheMeta[pageId];
      const cacheMatchesCurrentSource =
        (!lastModified && !cachedPageMeta?.lastModified) ||
        (Boolean(lastModified) && cachedPageMeta?.lastModified === lastModified);

      // If we have both in cache for the current OneNote page version, we can show immediately.
      if (parsed && content && cacheMatchesCurrentSource && !forceReparse) {
        addLog(`${pageTitle}: loaded from cache.`);
        setParsedPageContent(parsed);
        setSelectedPageContent(content);
        setViewMode('parsed');
        setLoadingPage(false);
        return;
      }

      const activeGraphCooldown = getActiveGraphCooldownUntil();
      const graph = new GraphService(accessToken || undefined, true);
      
      // Parallel fetch: Graph API (HTML) + Firebase (Saved Entries + Page Sync Record)
      setLoadingMessage('Fetching data from OneNote and Database...');
      
      const [fetchedContent, storedEntries, pageSyncRecord] = await Promise.all([
        (content && !forceReparse)
          ? Promise.resolve(content)
          : activeGraphCooldown
            ? Promise.resolve<string | null>(null)
            : graph.getPageContent(classId, pageId).catch(e => { console.error(e); throw e; }),
        firebaseUser ? fetchEntriesForPage(db, firebaseUser.uid, pageId).catch(e => { console.error(e); return null; }) : Promise.resolve(null),
        firebaseUser ? fetchPageSyncRecord(db, firebaseUser.uid, pageId).catch(e => { console.error(e); return null; }) : Promise.resolve(null),
      ]);
      
      content = fetchedContent || content || null;
      if (pageSyncRecord) {
        setPageSyncStateCache(prev => ({ ...prev, [pageId]: pageSyncRecord.syncState }));
        if (pageSyncRecord.studentUpn) setActiveStudentUpn(pageSyncRecord.studentUpn);
      }
      // Fallback: storedEntries carry studentUpn written at parse time — use the
      // first entry's UPN when the PageSyncRecord predates UPN resolution.
      if (!pageSyncRecord?.studentUpn && storedEntries && storedEntries.length > 0) {
        const upnFromEntry = storedEntries[0]?.storedEntry?.studentUpn;
        if (upnFromEntry) setActiveStudentUpn(upnFromEntry);
      }
      loadedContentForFallback = content;
      setSelectedPageContent(content || (activeGraphCooldown ? formatGraphCooldownMessage(activeGraphCooldown) : null));
      if (content) {
        setContentCache(prev => ({ ...prev, [pageId]: content! }));
      }
      
      const newFeedback = { ...teacherFeedback };
      const newSavedFeedback = { ...savedTeacherFeedback };
      const newStatus = { ...entryStatus };
      const reconstructedEntries: ParsedDiaryEntry[] = [];
      let hasStaleSavedSnapshot = false;
      let nextSnapshotMeta: PageSnapshotMeta | null = null;
      
      if (storedEntries && storedEntries.length > 0) {
        storedEntries.forEach(({ parsedEntry, storedEntry }) => {
          reconstructedEntries.push(parsedEntry);
          newFeedback[storedEntry.entryId] = storedEntry.teacherFeedback || {};
          newSavedFeedback[storedEntry.entryId] = storedEntry.teacherFeedback || {};
          newStatus[storedEntry.entryId] = storedEntry.status;
        });
      }

        // Smart Logic: Decide if we need to re-parse
        const parserConfig = getClassParserConfig(classId);
        let shouldParse = forceAIParse || forceReparse || reconstructedEntries.length === 0;
        if (!shouldParse && lastModified && storedEntries) {
          const oneNoteTime = parseComparableTime(lastModified);
          const latestEntrySavedTime = storedEntries.reduce((latest, { storedEntry }) => {
            const next = parseComparableTime(storedEntry.oneNoteLastModified) ?? 0;
            return Math.max(latest, next);
          }, 0);
          const latestSavedTime = Math.max(
            latestEntrySavedTime,
            parseComparableTime(pageSyncRecord?.oneNoteLastModified) ?? 0
          );
          
          if (oneNoteTime !== null && (latestSavedTime === 0 || oneNoteTime > latestSavedTime)) {
            addLog(`${pageTitle}: updated since last sync — re-parsing...`);
            shouldParse = true;
            hasStaleSavedSnapshot = reconstructedEntries.length > 0;
          }
        }

        if (
          shouldParse &&
          parserConfig.parserMode === 'ai' &&
          !forceAIParse &&
          pageSyncRecord?.syncState === 'rate_limited' &&
          pageSyncRecord.nextRetryAt &&
          new Date(pageSyncRecord.nextRetryAt).getTime() > Date.now()
        ) {
          addLog(`AI parsing is cooling down for this page until ${new Date(pageSyncRecord.nextRetryAt).toLocaleTimeString()}. Loading saved data instead.`);
          shouldParse = false;
        }

        if (shouldParse && activeGraphCooldown) {
          if (reconstructedEntries.length > 0) {
            addLog(`Microsoft Graph is cooling down until ${new Date(activeGraphCooldown).toLocaleTimeString()}. Loading saved data first.`);
            shouldParse = false;
          } else {
            throw Object.assign(new Error(formatGraphCooldownMessage(activeGraphCooldown)), {
              statusCode: 429,
              code: 'GRAPH_RATE_LIMIT',
              retryAfterMs: Math.max(new Date(activeGraphCooldown).getTime() - Date.now(), 5000),
            });
          }
        }

        if (!shouldParse) {
          addLog(`${pageTitle}: loaded ${reconstructedEntries.length} entries from database.`);
          parsed = reconstructedEntries;
          setTeacherFeedback(newFeedback);
          setSavedTeacherFeedback(newSavedFeedback);
          setEntryStatus(newStatus);
          nextSnapshotMeta = buildSnapshotMeta(
            reconstructedEntries.map((entry) => newStatus[entry.id] || 'draft'),
            {
              stale: false,
              source: 'saved',
            }
          );
          setActivePageSnapshotMeta(pageId, nextSnapshotMeta);
          if (firebaseUser) {
            void persistPageSyncState({
              pageId,
              classId,
              pageTitle,
              studentName: studentName || activeStudentName || 'Unknown Student',
              parserMode: parserConfig.parserMode,
              templateVersion: parserConfig.templateVersion,
              syncState: pageSyncRecord?.syncState === 'rate_limited' ? 'rate_limited' : 'saved',
              entryCount: reconstructedEntries.length,
              oneNoteLastModified: pageSyncRecord?.oneNoteLastModified || lastModified,
              lastParsedAt: pageSyncRecord?.lastParsedAt,
              lastViewedAt: new Date().toISOString(),
              lastError: pageSyncRecord?.lastError,
              nextRetryAt: pageSyncRecord?.nextRetryAt,
            }).catch((err) => console.error('Failed to update page view metadata', err));
          }
        } else {
          if (firebaseUser) {
            await persistPageSyncState({
              pageId,
              classId,
              pageTitle,
              studentName: studentName || activeStudentName || 'Unknown Student',
              parserMode: parserConfig.parserMode,
              templateVersion: parserConfig.templateVersion,
              syncState: 'syncing',
              entryCount: reconstructedEntries.length,
              oneNoteLastModified: lastModified,
              lastParsedAt: pageSyncRecord?.lastParsedAt,
              lastViewedAt: new Date().toISOString(),
              lastError: undefined,
              nextRetryAt: undefined,
            });
          }

          if (!forceAIParse && parserConfig.parserMode === 'label-first') {
            setLoadingMessage('Parsing labeled template without AI...');
            addLog(`${pageTitle}: parsing with label-first parser...`);
            if (forceReparse) addLog(`Force re-parse: Graph HTML length = ${content.length}`);
            parsed = parseLabeledDiaryHTML(content, parserConfig.templateVersion);
            if (forceReparse) addLog(`Force re-parse: raw parsed count = ${parsed?.length ?? 0}`);
            setLastParseUsedAI(false);
            didFreshParse = true;
            if (!parsed || parsed.length === 0) {
              parseFailureMode = 'label-first';
              setLastParseFailureMode('label-first');
              addLog(`Label-first parser did not produce a valid entry. Showing the recovery panel with the original page still available.`);
              if (hasStaleSavedSnapshot) {
                parsed = reconstructedEntries;
                setTeacherFeedback(newFeedback);
                setSavedTeacherFeedback(newSavedFeedback);
                setEntryStatus(newStatus);
                nextSnapshotMeta = buildSnapshotMeta(
                  reconstructedEntries.map((entry) => newStatus[entry.id] || 'draft'),
                  {
                    stale: true,
                    source: 'saved',
                    parseFallbackUsed: true,
                    message: 'This page changed after the last saved review. You are viewing the previous structured snapshot until you re-parse this page with AI.',
                  }
                );
                setActivePageSnapshotMeta(pageId, nextSnapshotMeta);
              }
              if (firebaseUser) {
                await persistPageSyncState({
                  pageId,
                  classId,
                  pageTitle,
                  studentName: studentName || activeStudentName || 'Unknown Student',
                  parserMode: parserConfig.parserMode,
                  templateVersion: parserConfig.templateVersion,
                  syncState: 'error',
                  entryCount: reconstructedEntries.length,
                  oneNoteLastModified: lastModified,
                  lastParsedAt: pageSyncRecord?.lastParsedAt,
                  lastViewedAt: new Date().toISOString(),
                  lastError: 'Label-first parser did not produce a valid entry.',
                  nextRetryAt: undefined,
                });
              }
            }
          } else {
            setLoadingMessage('Analyzing content with AI (this takes a few seconds)...');
            addLog(`${pageTitle}: parsing with AI...`);
            setLastParseUsedAI(true);
            try {
              parsed = await parseDiaryHTML(content, userConfig.aiModelParsing, (attempt, delay) => {
                setLoadingMessage(`Rate limit hit. Retrying in ${Math.round(delay/1000)}s... (Attempt ${attempt}/3)`);
              }, parserConfig.templateVersion);
              didFreshParse = true;
              if (!parsed || parsed.length === 0) {
                parseFailureMode = 'ai';
                setLastParseFailureMode('ai');
              }
            } catch (parseError: any) {
              parseFailureMode = 'ai';
              if (firebaseUser) {
                await persistPageSyncState({
                  pageId,
                  classId,
                  pageTitle,
                  studentName: studentName || activeStudentName || 'Unknown Student',
                  parserMode: 'ai',
                  templateVersion: DEFAULT_TEMPLATE_VERSION,
                  syncState: isProviderRateLimitError(parseError) ? 'rate_limited' : 'error',
                  entryCount: reconstructedEntries.length,
                  oneNoteLastModified: lastModified,
                  lastParsedAt: pageSyncRecord?.lastParsedAt,
                  lastViewedAt: new Date().toISOString(),
                  lastError: String(parseError?.message || parseError),
                  nextRetryAt: buildNextRetryAt(parseError),
                });
              }
              if (hasStaleSavedSnapshot) {
                parsed = reconstructedEntries;
                setTeacherFeedback(newFeedback);
                setSavedTeacherFeedback(newSavedFeedback);
                setEntryStatus(newStatus);
                nextSnapshotMeta = buildSnapshotMeta(
                  reconstructedEntries.map((entry) => newStatus[entry.id] || 'draft'),
                  {
                    stale: true,
                    source: 'saved',
                    parseFallbackUsed: true,
                    message: isProviderRateLimitError(parseError)
                      ? 'This page changed after the last saved review, and AI parsing is temporarily unavailable. You are viewing the previous structured snapshot until AI parsing can be retried.'
                      : 'This page changed after the last saved review, and AI could not safely complete a re-parse. You are viewing the previous structured snapshot for now.',
                  }
                );
                setActivePageSnapshotMeta(pageId, nextSnapshotMeta);
                setLastParseFailureMode('ai');
              } else {
                setLastParseFailureMode('ai');
                addLog(`AI parsing did not produce a structured entry. Keeping the recovery view available with the original page behind it.`);
              }
            }
          }
        }

        if (parsed && parsed.length > 0) {
          parsed = ensureUniqueEntryIds(pageId, collapseParsedEntries(parsed));
          if (forceReparse) addLog(`Force re-parse: post-collapse count = ${parsed.length}`);
          const { remappedStatus, remappedFeedback } = remapSavedEntryState(
            parsed,
            reconstructedEntries,
            newStatus,
            newFeedback
          );
          const { remappedFeedback: remappedSavedFeedback } = remapSavedEntryState(
            parsed,
            reconstructedEntries,
            newStatus,
            newSavedFeedback
          );
          setTeacherFeedback(remappedFeedback);
          setSavedTeacherFeedback(remappedSavedFeedback);
          setEntryStatus(remappedStatus);
          if (!nextSnapshotMeta || !nextSnapshotMeta.parseFallbackUsed) {
            nextSnapshotMeta = buildSnapshotMeta(
              parsed.map((entry) => (remappedStatus[entry.id] || 'draft') as EntryStatus),
              {
                stale: false,
                source: didFreshParse ? 'fresh-parse' : 'saved',
              }
            );
            setActivePageSnapshotMeta(pageId, nextSnapshotMeta);
          }
          
          setParsedPageContent(parsed);
          setParsedCache(prev => ({ ...prev, [pageId]: parsed! }));
          setPageCacheMeta(prev => ({
            ...prev,
            [pageId]: {
              lastModified: lastModified || pageSyncRecord?.oneNoteLastModified,
            },
          }));
          setViewMode('parsed');
          
          if (firebaseUser && didFreshParse) {
            if (forceReparse) addLog(`Force re-parse: saving ${parsed.length} entries to database...`);
            addLog(`${pageTitle}: saving ${parsed.length} parsed entries to database...`);
            try {
              await Promise.all(parsed.map((entry, idx) => {
                // Preserve existing status if it exists, otherwise 'draft'
                const existingStatus = remappedStatus[entry.id!] || 'draft';
                return saveEntryToFirebase(
                  entry,
                  idx,
                  existingStatus as EntryStatus,
                  pageId,
                  classId,
                  pageTitle,
                  studentName || activeStudentName,
                  lastModified,
                  forceAIParse
                    ? { parserMode: 'ai', templateVersion: DEFAULT_TEMPLATE_VERSION }
                    : getClassParserConfig(classId)
                );
              }));
              await persistPageSyncState({
                pageId,
                classId,
                pageTitle,
                studentName: studentName || activeStudentName || 'Unknown Student',
                parserMode: forceAIParse ? 'ai' : getClassParserConfig(classId).parserMode,
                templateVersion: forceAIParse ? DEFAULT_TEMPLATE_VERSION : getClassParserConfig(classId).templateVersion,
                syncState: 'saved',
                entryCount: parsed.length,
                oneNoteLastModified: lastModified,
                lastParsedAt: new Date().toISOString(),
                lastViewedAt: new Date().toISOString(),
                lastError: undefined,
                nextRetryAt: undefined,
              });
            } catch (saveError: any) {
              console.error('Non-fatal page auto-save failure', saveError);
              addLog(`Auto-save warning: ${saveError?.message || String(saveError)}`);
            }
          }
        } else {
          if (parseFailureMode && content) {
            addLog(`No parsed entries available. Showing the recovery panel first, with the original page available on demand.`);
            setViewMode('parsed');
          } else {
            addLog(`No parsed entries available, falling back to raw HTML view.`);
            setViewMode('raw');
          }
        }
    } catch (e: any) {
      if (isGraphRateLimitError(e)) {
        startGraphCooldown(e, `opening ${pageTitle}`);
      }
      addLog(`Failed to load page: ${e.message}`);
      if (!loadedContentForFallback || loadedContentForFallback === "Error loading HTML") {
        setSelectedPageContent(`Error loading page: ${e.message}`);
      }
      if (!loadedContentForFallback || loadedContentForFallback === "Error loading HTML") {
        setActivePageSnapshotMeta(pageId, null);
      }
      setViewMode('raw');
    } finally {
      setLoadingPage(false);
      setLoadingMessage('');
    }
  };

  const handleFirestoreError = (error: any, operation: string, path: string) => {
    const errInfo = {
      error: error?.message || String(error),
      operation,
      path,
      authInfo: {
        uid: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        emailVerified: auth.currentUser?.emailVerified
      }
    };
    const jsonError = JSON.stringify(errInfo);
    console.error("Firestore Error:", jsonError);
    addLog(`Database Error: ${jsonError}`);
    throw new Error(jsonError);
  };

  const saveEntryToFirebase = async (
    entry: ParsedDiaryEntry, 
    entryIndex: number, 
    status: EntryStatus,
    overridePageId?: string,
    overrideClassId?: string,
    overridePageTitle?: string,
    overrideStudentName?: string,
    oneNoteLastModified?: string,
    parserConfigOverride?: { parserMode: ParserMode; templateVersion: TemplateVersion },
    identityOverride?: StudentIdentity | null,
    diaryGroupOverride?: { id?: string; name?: string }
  ) => {
    if (!firebaseUser) {
      addLog("Cannot save entry: Database not connected.");
      return;
    }
    
    const pId = String(overridePageId || activePageId || '');
    const cId = String(overrideClassId || activeClassId || '');
    const pTitle = String(overridePageTitle || selectedPageTitle || '');
    const sName = String(overrideStudentName || activeStudentName || 'Unknown Student');
    const pageMeta = pageMetadataLookup[pId];
    const diaryGroupId = diaryGroupOverride?.id || pageMeta?.diaryGroupId;
    const diaryGroupName = diaryGroupOverride?.name || pageMeta?.diaryGroupName;
    const entryKey = entry.id || String(entryIndex);
    const feedback = teacherFeedback[entryKey] || {};
    const parserConfig = parserConfigOverride || getClassParserConfig(cId);
    const studentIdentity =
      identityOverride ||
      (await resolveStudentIdentityForClass([pTitle, sName].filter(Boolean).join(' ').trim(), cId));
    const storedEntry = buildStoredEntry({
      entry: {
        ...entry,
        id: entry.id || `${pId}_${entryIndex}`,
      },
      status,
      classId: cId,
      pageId: pId,
      pageTitle: pTitle,
      diaryGroupId,
      diaryGroupName,
      studentName: sName,
      studentGraphId: studentIdentity?.graphId,
      studentUpn: studentIdentity?.upn,
      teacherFeedback: feedback,
      parserMode: parserConfig.parserMode,
      templateVersion: parserConfig.templateVersion,
      oneNoteLastModified,
    });

    const entryPath = `users/${firebaseUser.uid}/entries/${storedEntry.entryId}`;
    try {
      await saveEntryRecord(db, firebaseUser.uid, storedEntry);
      setEntryStatus(prev => ({ ...prev, [entryKey]: status, [storedEntry.entryId]: status }));
      setSavedTeacherFeedback(prev => ({
        ...prev,
        [entryKey]: feedback,
        [storedEntry.entryId]: feedback,
      }));
      addLog(`Saved entry ${storedEntry.entryId} as ${getEntryWorkflowLogLabel(status)}.`);
    } catch (error) {
      handleFirestoreError(error, "WRITE", entryPath);
    }
  };

  // Bind the saveEntryToFirebase closure into the ref so the feedback hook's
  // workflow handlers (handleSaveDraft / SaveAndMarkReady / ReviewAndSendEntry)
  // can invoke it. The ref is rebound on every render so the hook always sees
  // the most current closure without re-running its useCallbacks.
  saveEntryRef.current = saveEntryToFirebase;

  // ── Sync phase helpers ────────────────────────────────────────────────────
  // Component-scope closures so they share db, firebaseUser, addLog,
  // setSyncProgress, and all the rate-limit / identity utilities without a
  // large parameter list. handleSyncClass is the coordinator; B3's
  // handleSyncAllClasses will call the same three primitives.

  const populateSyncJobForClass = async (
    jobId: string,
    classId: string,
    graph: GraphService,
    batchSize: number,
    delayMs: number,
    forceResync = false
  ): Promise<{ queued: number; skipped: number; preserved: number }> => {
    if (!firebaseUser) throw new Error('Not authenticated');

    if (!classId.startsWith('nb_')) {
      setSyncProgress(prev => ({ ...prev, status: 'Refreshing class identity map...' }));
      try {
        const graphIdentities = await graph.listClassStudentIdentities(classId);
        const storedIdentities = primeClassIdentityCache(
          classId,
          graphIdentities.map(identity => toStoredClassIdentity(classId, identity))
        );
        await replaceClassStudentIdentities(db, firebaseUser.uid, classId, storedIdentities);
        addLog(`Loaded ${storedIdentities.length} student identities for class ${classId}.`);
      } catch (identityError: any) {
        if (isGraphRateLimitError(identityError)) throw identityError;
        console.error('Failed to refresh class identity map during sync', identityError);
        addLog(`Identity map warning: ${identityError?.message || String(identityError)}`);
        await ensureClassIdentityMapLoaded(classId, { allowGraphFetch: false });
      }
    }

    setSyncProgress(prev => ({ ...prev, status: 'Fetching student roster...' }));
    const structure = await graph.getNotebookStructure(classId);
    const studentSections = structure.flatMap(sg =>
      (sg.children || []).map(section => ({
        section,
        diaryGroupId: section.id,
        diaryGroupName: section.displayName,
      }))
    );
    setSyncProgress({ current: 0, total: studentSections.length, status: `Found ${studentSections.length} students. Discovering pages...` });

    const parserConfig = getClassParserConfig(classId);
    const allItems: SyncJobItem[] = [];

    await batchPromises(studentSections, async ({ section, diaryGroupId, diaryGroupName }) => {
      const currentIndex = studentSections.findIndex(s => s.section.id === section.id);
      setSyncProgress(prev => ({ ...prev, current: currentIndex + 1, status: `Discovering ${section.displayName}...` }));

      try {
        const pages = await graph.getSectionPages(classId, section.id);
        const pagesToSync = pages.filter(p => p.displayName && p.displayName.trim().length > 0);

        for (const page of pagesToSync) {
          const sectionIdentity = matchStudentIdentityFromRoster(
            `${section.displayName} ${page.displayName}`,
            classIdentityMapRef.current[classId] || []
          );
          const pageSyncRecord = await fetchPageSyncRecord(db, firebaseUser.uid, page.id);

          let initialStatus: SyncJobItemStatus = 'queued';

          if (!forceResync && pageSyncRecord?.syncState === 'saved') {
            const oneNoteModified = parseComparableTime(page.lastModified);
            const firebaseModified = parseComparableTime(pageSyncRecord.oneNoteLastModified) ?? 0;
            if (oneNoteModified !== null && firebaseModified > 0 && oneNoteModified <= firebaseModified) {
              initialStatus = 'skipped';
              addLog(`Discovering ${section.displayName} / ${page.displayName}: Up to date. Skipping.`);
            }
          }

          if (
            initialStatus === 'queued' &&
            parserConfig.parserMode === 'ai' &&
            pageSyncRecord?.syncState === 'rate_limited' &&
            pageSyncRecord.nextRetryAt &&
            new Date(pageSyncRecord.nextRetryAt).getTime() > Date.now()
          ) {
            initialStatus = 'rate_limited';
            addLog(`Discovering ${section.displayName} / ${page.displayName}: AI cooldown active until ${new Date(pageSyncRecord.nextRetryAt).toLocaleTimeString()}. Preserving.`);
          }

          const now = new Date().toISOString();
          allItems.push({
            itemId: makeItemId(classId, page.id),
            jobId,
            classId,
            pageId: page.id,
            pageTitle: cleanNotebookDisplayName(page.displayName),
            studentName: section.displayName,
            diaryGroupId,
            diaryGroupName,
            studentGraphId: sectionIdentity?.graphId,
            studentUpn: sectionIdentity?.upn,
            parserMode: parserConfig.parserMode,
            templateVersion: parserConfig.templateVersion,
            oneNoteLastModified: page.lastModified,
            status: initialStatus,
            createdAt: now,
            updatedAt: now,
          });
        }
      } catch (err: any) {
        if (isGraphRateLimitError(err)) {
          const graphPausedUntil = startGraphCooldown(err, `discovering ${section.displayName}`);
          addLog(`Error discovering ${section.displayName}: ${formatGraphCooldownMessage(graphPausedUntil)}`);
          throw Object.assign(new Error(formatGraphCooldownMessage(graphPausedUntil)), {
            code: 'GRAPH_RATE_LIMIT_PAUSE',
            nextRetryAt: graphPausedUntil,
          });
        }
        console.error(`Failed to discover pages for ${section.displayName}:`, err);
        addLog(`Error discovering ${section.displayName}: ${err.message}`);
      }
    }, batchSize, delayMs);

    setSyncProgress(prev => ({ ...prev, status: `Writing ${allItems.length} pages to sync queue...` }));
    await batchWriteJobItems(db, firebaseUser.uid, jobId, allItems);

    const queued = allItems.filter(i => i.status === 'queued').length;
    const skipped = allItems.filter(i => i.status === 'skipped').length;
    const preserved = allItems.length - queued - skipped;
    return { queued, skipped, preserved };
  };

  const processSyncJobItems = async (
    jobId: string,
    graph: GraphService,
    progressScope: { currentOffset?: number; totalOverride?: number; label?: string } = {}
  ): Promise<{ hasRemainingWork: boolean; geminiCooldownUntil: string | null; processedCount: number }> => {
    if (!firebaseUser) throw new Error('Not authenticated');

    const runId = crypto.randomUUID();
    const currentOffset = progressScope.currentOffset ?? 0;

    // Gate the reclaim/requeue scans on the job counters so a fresh class (nothing
    // running, nothing rate-limited) does not pay two full collection scans per tick.
    // claimItem (transaction) and completeItem (batch) keep these counts atomic with
    // item status, and a crashed worker leaves counts.running > 0 — so this never
    // strands a stale item. One small getDoc replaces two getDocs scans when idle.
    const jobBeforeScan = await getSyncJob(db, firebaseUser.uid, jobId);
    const reclaimed =
      (jobBeforeScan?.counts.running ?? 1) > 0
        ? await reclaimStaleRunningItems(db, firebaseUser.uid, jobId)
        : 0;
    const requeued =
      (jobBeforeScan?.counts.rate_limited ?? 1) > 0
        ? await requeueRetryableRateLimitedItems(db, firebaseUser.uid, jobId)
        : 0;
    if (reclaimed > 0) addLog(`Reclaimed ${reclaimed} stale running item(s).`);
    if (requeued > 0) addLog(`Re-queued ${requeued} retry-ready rate-limited item(s).`);

    const queuedItems = await listQueuedItems(db, firebaseUser.uid, jobId);
    const progressTotal = progressScope.totalOverride ?? queuedItems.length;
    const progressLabel = progressScope.label ? `${progressScope.label}: ` : '';
    setSyncProgress({
      current: currentOffset,
      total: progressTotal,
      status: `${progressLabel}Processing ${queuedItems.length} pages...`,
    });

    let processed = 0;
    for (const item of queuedItems) {
      if (item.parserMode === 'ai' && getActiveGeminiCooldownUntil()) {
        addLog(`Queuing ${item.studentName} / ${item.pageTitle}: Gemini cooling down — will retry on next sync.`);
        processed++;
        continue;
      }

      setSyncProgress(prev => ({
        ...prev,
        current: currentOffset + processed + 1,
        status: `${progressLabel}Syncing ${item.studentName} / ${item.pageTitle}...`,
      }));

      const claimed = await claimItem(db, firebaseUser.uid, jobId, item.itemId, runId);
      if (!claimed) {
        addLog(`Item ${item.itemId} already claimed by another worker. Skipping.`);
        processed++;
        continue;
      }

      const pageSyncRecord = await fetchPageSyncRecord(db, firebaseUser.uid, item.pageId);
      // The intermediate status writes below only need a count for display. Reuse the
      // page record's last-known entryCount instead of reading every stored entry on the
      // page (a major Firestore read amplifier). The success path below writes the real
      // post-parse count from normalizedEntries.length.
      const knownEntryCount = pageSyncRecord?.entryCount ?? 0;

      await persistPageSyncState({
        pageId: item.pageId,
        classId: item.classId,
        pageTitle: item.pageTitle,
        studentName: item.studentName,
        diaryGroupId: item.diaryGroupId,
        diaryGroupName: item.diaryGroupName,
        studentGraphId: item.studentGraphId,
        studentUpn: item.studentUpn,
        parserMode: item.parserMode,
        templateVersion: item.templateVersion,
        syncState: 'syncing',
        entryCount: knownEntryCount,
        oneNoteLastModified: item.oneNoteLastModified,
        lastParsedAt: pageSyncRecord?.lastParsedAt,
        lastViewedAt: pageSyncRecord?.lastViewedAt,
        lastError: undefined,
        nextRetryAt: undefined,
      });

      addLog(`Syncing ${item.studentName} / ${item.pageTitle}: Fetching & parsing...`);

      let parsed: ParsedPageContent | null = null;
      try {
        const content = await graph.getPageContent(item.classId, item.pageId);
        parsed = item.parserMode === 'label-first'
          ? parseLabeledDiaryHTML(content, item.templateVersion)
          : await parseDiaryHTML(content, userConfig.aiModelParsing, undefined, item.templateVersion);
      } catch (parseError: any) {
        const errorMsg = String(parseError?.message || parseError);

        // A Firestore daily-quota error is not a parse failure: do not mark the item
        // 'error' (that burns a write and loses the item). Rethrow so the outer handler
        // stops the run cleanly with the queue preserved.
        if (isFirestoreQuotaError(parseError)) {
          throw parseError;
        }

        if (isGraphRateLimitError(parseError)) {
          const graphPausedUntil = startGraphCooldown(parseError, `fetching ${item.studentName} / ${item.pageTitle}`);
          await persistPageSyncState({
            pageId: item.pageId,
            classId: item.classId,
            pageTitle: item.pageTitle,
            studentName: item.studentName,
            diaryGroupId: item.diaryGroupId,
            diaryGroupName: item.diaryGroupName,
            studentGraphId: item.studentGraphId,
            studentUpn: item.studentUpn,
            parserMode: item.parserMode,
            templateVersion: item.templateVersion,
            syncState: 'rate_limited',
            entryCount: knownEntryCount,
            oneNoteLastModified: item.oneNoteLastModified,
            lastParsedAt: pageSyncRecord?.lastParsedAt,
            lastViewedAt: pageSyncRecord?.lastViewedAt,
            lastError: errorMsg,
            nextRetryAt: graphPausedUntil,
          });
          await completeItem(db, firebaseUser.uid, jobId, item.itemId, 'rate_limited',
            { lastError: errorMsg, nextRetryAt: graphPausedUntil }
          );
          throw Object.assign(new Error(formatGraphCooldownMessage(graphPausedUntil)), {
            code: 'GRAPH_RATE_LIMIT_PAUSE',
            nextRetryAt: graphPausedUntil,
          });
        }

        const nextRetryAt = buildNextRetryAt(parseError);
        const syncState = isProviderRateLimitError(parseError) ? 'rate_limited' : 'error';

        await persistPageSyncState({
          pageId: item.pageId,
          classId: item.classId,
          pageTitle: item.pageTitle,
          studentName: item.studentName,
          diaryGroupId: item.diaryGroupId,
          diaryGroupName: item.diaryGroupName,
          studentGraphId: item.studentGraphId,
          studentUpn: item.studentUpn,
          parserMode: item.parserMode,
          templateVersion: item.templateVersion,
          syncState,
          entryCount: knownEntryCount,
          oneNoteLastModified: item.oneNoteLastModified,
          lastParsedAt: pageSyncRecord?.lastParsedAt,
          lastViewedAt: pageSyncRecord?.lastViewedAt,
          lastError: errorMsg,
          nextRetryAt,
        });
        await completeItem(db, firebaseUser.uid, jobId, item.itemId,
          syncState === 'rate_limited' ? 'rate_limited' : 'error',
          { lastError: errorMsg, nextRetryAt }
        );

        if (syncState === 'rate_limited') {
          startGeminiCooldown(parseError, `parsing ${item.studentName} / ${item.pageTitle}`);
        } else {
          addLog(`Error syncing ${item.studentName} / ${item.pageTitle}: ${errorMsg}`);
        }

        processed++;
        continue;
      }

      if (parsed && parsed.length > 0) {
        const sectionIdentity = item.studentGraphId
          ? { graphId: item.studentGraphId, displayName: item.studentName, upn: item.studentUpn || '' }
          : null;
        const normalizedEntries = ensureUniqueEntryIds(item.pageId, collapseParsedEntries(parsed));
        for (let j = 0; j < normalizedEntries.length; j++) {
          await saveEntryToFirebase(
            normalizedEntries[j],
            j,
            'draft',
            item.pageId,
            item.classId,
            item.pageTitle,
            item.studentName,
            item.oneNoteLastModified,
            { parserMode: item.parserMode, templateVersion: item.templateVersion },
            sectionIdentity,
            { id: item.diaryGroupId, name: item.diaryGroupName }
          );
        }
        await persistPageSyncState({
          pageId: item.pageId,
          classId: item.classId,
          pageTitle: item.pageTitle,
          studentName: item.studentName,
          diaryGroupId: item.diaryGroupId,
          diaryGroupName: item.diaryGroupName,
          studentGraphId: item.studentGraphId,
          studentUpn: item.studentUpn,
          parserMode: item.parserMode,
          templateVersion: item.templateVersion,
          syncState: 'saved',
          entryCount: normalizedEntries.length,
          oneNoteLastModified: item.oneNoteLastModified,
          lastParsedAt: new Date().toISOString(),
          lastViewedAt: pageSyncRecord?.lastViewedAt,
          lastError: undefined,
          nextRetryAt: undefined,
        });
        await completeItem(db, firebaseUser.uid, jobId, item.itemId, 'done');
        addLog(`Synced ${item.studentName} / ${item.pageTitle}: ${normalizedEntries.length} entries saved (${item.parserMode === 'label-first' ? 'label-first' : 'AI'}).`);
      } else if (item.parserMode === 'label-first') {
        await persistPageSyncState({
          pageId: item.pageId,
          classId: item.classId,
          pageTitle: item.pageTitle,
          studentName: item.studentName,
          diaryGroupId: item.diaryGroupId,
          diaryGroupName: item.diaryGroupName,
          studentGraphId: item.studentGraphId,
          studentUpn: item.studentUpn,
          parserMode: item.parserMode,
          templateVersion: item.templateVersion,
          syncState: 'error',
          entryCount: knownEntryCount,
          oneNoteLastModified: item.oneNoteLastModified,
          lastParsedAt: pageSyncRecord?.lastParsedAt,
          lastViewedAt: pageSyncRecord?.lastViewedAt,
          lastError: 'Label-first parser found no valid entry.',
          nextRetryAt: undefined,
        });
        await completeItem(db, firebaseUser.uid, jobId, item.itemId, 'error',
          { lastError: 'Label-first parser found no valid entry.' }
        );
        addLog(`Syncing ${item.studentName} / ${item.pageTitle}: label-first parser found no valid entry. AI fallback remains explicit only.`);
      } else {
        await completeItem(db, firebaseUser.uid, jobId, item.itemId, 'error',
          { lastError: 'AI parser returned no entries.' }
        );
      }

      processed++;
    }

    const latestJob = await getSyncJob(db, firebaseUser.uid, jobId);
    const hasRemainingWork =
      (latestJob?.counts.queued ?? 0) > 0 ||
      (latestJob?.counts.running ?? 0) > 0 ||
      (latestJob?.counts.rate_limited ?? 0) > 0;

    return { hasRemainingWork, geminiCooldownUntil: getActiveGeminiCooldownUntil(), processedCount: processed };
  };

  const finalizeSyncJob = async (
    jobId: string,
    classIds: string[],
    hasRemainingWork: boolean,
    geminiCooldownUntil: string | null
  ): Promise<void> => {
    if (!firebaseUser) throw new Error('Not authenticated');

    if (!hasRemainingWork) {
      await updateJobStatus(db, firebaseUser.uid, jobId, 'done');
      setResumePrompt(null);
    }

    const now = new Date().toISOString();
    for (const classId of classIds) {
      const cls = classes.find(c => c.id === classId);
      if (cls) await saveClassLastSynced(db, firebaseUser.uid, cls, now);
    }
    setClasses(prev => prev.map(c => classIds.includes(c.id) ? { ...c, lastSynced: now } : c));

    if (geminiCooldownUntil) {
      const retryTime = new Date(geminiCooldownUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      addLog(`Sync run complete. Some AI-mode pages queued — resume after ${retryTime}.`);
      setSyncProgress(prev => ({ ...prev, status: `Partial sync — AI pages queued until ${retryTime}. Re-sync after that time to complete.` }));
    } else {
      const completedLabel = classIds.length === 1 ? 'Class sync complete.' : `${classIds.length} classes synced.`;
      addLog(completedLabel);
      setSyncProgress(prev => ({ ...prev, status: classIds.length === 1 ? 'Sync complete!' : `${classIds.length} classes synced.` }));
    }

    // Slice 5: post-run archive-capture verdict. Read the just-written page
    // records and report each class's capture state — surfacing errored pages
    // that export cannot reveal, instead of a blanket "complete".
    try {
      const records = await listPageSyncRecordsForClasses(db, firebaseUser.uid, classIds);
      const statusByClass = deriveArchiveCaptureByClass(records);
      for (const classId of classIds) {
        const status = statusByClass.get(classId);
        if (!status || status.state === 'none') continue;
        const name = classes.find(c => c.id === classId)?.displayName ?? classId;
        addLog(`Archive capture: ${name} — ${status.label}`);
      }
    } catch (err) {
      console.warn('[finalizeSyncJob] archive capture summary failed:', err);
    }
    setCaptureRefreshKey(prev => prev + 1);
  };

  // ── Coordinator ───────────────────────────────────────────────────────────

  const handleSyncClass = async (classId?: string, resumeJobId?: string, forceResync = false) => {
    const targetClassId = classId || activeClassId;
    if (!targetClassId || !firebaseUser) return;

    if (isSyncingClass) {
      addLog('A sync is already in progress. Please wait.');
      return;
    }

    setIsSyncingClass(true);
    setSyncingClassId(targetClassId);
    setSyncProgress({ current: 0, total: 0, status: 'Starting sync...' });

    try {
      if (!ensureGraphReady('class sync')) {
        setIsSyncingClass(false);
        setSyncingClassId(null);
        setSyncProgress({ current: 0, total: 0, status: formatGraphCooldownMessage(getActiveGraphCooldownUntil() || new Date(Date.now() + 60000).toISOString()) });
        return;
      }

      const graph = new GraphService(accessToken || undefined, true);
      const { batchSize, delayMs } = getGraphBatchConfig();
      let jobId: string;

      if (resumeJobId) {
        jobId = resumeJobId;
        addLog(`Resuming sync job ${jobId} for class ${targetClassId}...`);
      } else {
        const targetClass = classes.find(c => c.id === targetClassId);
        const job = await createSyncJob(db, firebaseUser.uid, targetClassId, targetClass?.displayName || targetClassId);
        jobId = job.jobId;
        addLog(`Starting sync for class ${targetClassId} (job ${jobId})`);
        const { queued, skipped, preserved } = await populateSyncJobForClass(jobId, targetClassId, graph, batchSize, delayMs, forceResync);
        addLog(`Queue populated: ${queued} queued, ${skipped} up-to-date, ${preserved} preserved${forceResync ? ' (freshness check bypassed)' : ''}. Starting processing...`);
      }

      const { hasRemainingWork, geminiCooldownUntil } = await processSyncJobItems(jobId, graph);
      await finalizeSyncJob(jobId, [targetClassId], hasRemainingWork, geminiCooldownUntil);

      setTimeout(() => {
        setIsSyncingClass(false);
        setSyncingClassId(null);
      }, 3000);
    } catch (e: any) {
      if (e?.code === 'GRAPH_RATE_LIMIT_PAUSE' || isGraphRateLimitError(e)) {
        const nextRetryAt = e?.nextRetryAt || startGraphCooldown(e, 'class sync');
        const message = formatGraphCooldownMessage(nextRetryAt);
        addLog(message);
        setSyncProgress(prev => ({ ...prev, status: message }));
        setError(message);
      } else if (isFirestoreQuotaError(e)) {
        const message = formatFirestoreQuotaMessage(resumePrompt?.queued);
        addLog(message);
        setSyncProgress(prev => ({ ...prev, status: message }));
        setError(message);
        // Leave resumePrompt intact so Resume stays available once the daily quota resets.
      } else {
        addLog(`Sync failed: ${e.message}`);
      }
      setIsSyncingClass(false);
      setSyncingClassId(null);
    }
  };

  const handleSyncAllClasses = async () => {
    if (selectedNotebookIds.size === 0) {
      setError("Please select at least one notebook to sync.");
      return;
    }

    if (!firebaseUser) {
      setError("Connect saved records before running the sync queue.");
      return;
    }

    if (isSyncingClass) {
      addLog('A sync is already in progress. Please wait.');
      return;
    }

    if (!ensureGraphReady('all selected class sync')) {
      setSyncProgress({
        current: 0,
        total: 0,
        status: formatGraphCooldownMessage(getActiveGraphCooldownUntil() || new Date(Date.now() + 60000).toISOString()),
      });
      return;
    }

    const selectedClassIds: string[] = Array.from(selectedNotebookIds);
    const graph = new GraphService(accessToken || undefined, true);
    const { batchSize, delayMs } = getGraphBatchConfig();
    const jobs: Array<{ jobId: string; classId: string; displayName: string; queued: number }> = [];
    const failedClassIds: string[] = [];

    setIsSyncingClass(true);
    setSyncingClassId(null);
    setError(null);
    setSyncProgress({ current: 0, total: 0, status: `Preparing sync for ${selectedClassIds.length} classes...` });

    try {
      for (const classId of selectedClassIds) {
        const targetClass = classes.find(c => c.id === classId);
        const displayName = targetClass?.displayName || classId;
        setSyncingClassId(classId);

        try {
          const job = await createSyncJob(db, firebaseUser.uid, classId, displayName);
          addLog(`Preparing sync for ${displayName} (job ${job.jobId})`);
          const { queued, skipped, preserved } = await populateSyncJobForClass(job.jobId, classId, graph, batchSize, delayMs);
          jobs.push({ jobId: job.jobId, classId, displayName, queued });
          addLog(`${displayName}: ${queued} queued, ${skipped} up-to-date, ${preserved} preserved.`);
        } catch (e: any) {
          failedClassIds.push(classId);
          const message = e?.message || String(e);
          addLog(`Failed to prepare ${displayName}: ${message}`);
          if (e?.code === 'GRAPH_RATE_LIMIT_PAUSE' || isGraphRateLimitError(e)) {
            const nextRetryAt = e?.nextRetryAt || startGraphCooldown(e, `preparing ${displayName}`);
            setError(formatGraphCooldownMessage(nextRetryAt));
          }
        }
      }

      const totalQueued = jobs.reduce((sum, job) => sum + job.queued, 0);
      let doneOffset = 0;
      let anyRemainingWork = false;
      let latestGeminiCooldown: string | null = null;
      const completedClassIds: string[] = [];

      setSyncProgress({
        current: 0,
        total: totalQueued,
        status: totalQueued > 0 ? `Processing ${totalQueued} pages across ${jobs.length} classes...` : 'No queued pages to process.',
      });

      for (const job of jobs) {
        setSyncingClassId(job.classId);

        try {
          const { hasRemainingWork, geminiCooldownUntil, processedCount } = await processSyncJobItems(job.jobId, graph, {
            currentOffset: doneOffset,
            totalOverride: totalQueued,
            label: job.displayName,
          });
          doneOffset += processedCount;
          anyRemainingWork = anyRemainingWork || hasRemainingWork;
          latestGeminiCooldown = geminiCooldownUntil || latestGeminiCooldown;
          await finalizeSyncJob(job.jobId, [job.classId], hasRemainingWork, geminiCooldownUntil);
          completedClassIds.push(job.classId);
        } catch (e: any) {
          if (isFirestoreQuotaError(e)) {
            // Daily read quota hit — every remaining class would fail the same way.
            // Stop cleanly with the queue preserved instead of hammering the cap.
            const message = formatFirestoreQuotaMessage();
            addLog(message);
            setSyncProgress(prev => ({ ...prev, status: message }));
            setError(message);
            break;
          }
          failedClassIds.push(job.classId);
          const message = e?.message || String(e);
          addLog(`Failed to process ${job.displayName}: ${message}`);
          if (e?.code === 'GRAPH_RATE_LIMIT_PAUSE' || isGraphRateLimitError(e)) {
            const nextRetryAt = e?.nextRetryAt || startGraphCooldown(e, `processing ${job.displayName}`);
            setError(formatGraphCooldownMessage(nextRetryAt));
          }
        }
      }

      const summaryParts = [
        completedClassIds.length > 0 ? `${completedClassIds.length} class${completedClassIds.length === 1 ? '' : 'es'} processed` : '',
        failedClassIds.length > 0 ? `${failedClassIds.length} failed` : '',
        anyRemainingWork || latestGeminiCooldown ? 'some work remains queued' : '',
      ].filter(Boolean);
      setSyncProgress(prev => ({
        ...prev,
        current: Math.min(doneOffset, totalQueued),
        total: totalQueued,
        status: summaryParts.length > 0 ? `Sync all complete: ${summaryParts.join(', ')}.` : 'Sync all complete.',
      }));
      addLog(`Sync all selected complete: ${summaryParts.join(', ') || 'no selected pages required processing'}.`);
    } finally {
      setTimeout(() => {
        setIsSyncingClass(false);
        setSyncingClassId(null);
      }, 3000);
    }
  };

  const handleMarkAllReady = async () => {
    if (!parsedPageContent || !firebaseUser) return;

    const { ready, skipped } = selectBulkReadyEntries(parsedPageContent);
    if (ready.length === 0) {
      addLog(`Mark All Ready skipped: no entries with student diary text were found.`);
      return;
    }

    setIsMarkingAllReady(true);
    addLog(
      `Marking ${ready.length} entries feedback ready` +
      (skipped.length > 0 ? `; skipping ${skipped.length} with no student diary text detected.` : '.')
    );
    try {
      for (const { entry, index } of ready) {
        await saveEntryToFirebase(entry, index, 'approved');
      }
      addLog(`Mark All Ready complete: ${ready.length} entries saved as feedback ready.`);
      setMarkAllReadySuccess(true);
      setTimeout(() => setMarkAllReadySuccess(false), 2000);
    } finally {
      setIsMarkingAllReady(false);
    }
  };

  const handleClassParserModeChange = async (classId: string, parserMode: ParserMode) => {
    const nextTemplateVersion =
      parserMode === 'label-first' ? LABEL_TEMPLATE_VERSION : DEFAULT_TEMPLATE_VERSION;

    let nextClassRecord: EducationClass | null = null;
    setClasses((prev) =>
      prev.map((cls) => {
        if (cls.id !== classId) return cls;
        nextClassRecord = withClassDefaults({
          ...cls,
          parserMode,
          templateVersion: nextTemplateVersion,
        });
        return nextClassRecord!;
      })
    );

    addLog(
      `Parser mode for ${
        classes.find((cls) => cls.id === classId)?.displayName || classId
      } set to ${parserMode === 'label-first' ? 'label-first template' : 'AI-assisted parsing'}.`
    );

    if (firebaseUser && nextClassRecord) {
      try {
        await saveClassMetadata(db, firebaseUser.uid, nextClassRecord);
      } catch (e: any) {
        console.error('Failed to save class parser metadata', e);
        addLog(`Failed to save parser mode metadata: ${e.message || String(e)}`);
      }
    }
  };


   const goToNextPage = () => {
    const allPages: { pageId: string, pageTitle: string, classId: string, studentName: string, lastModified?: string }[] = [];
    
    notebookTree.forEach(nb => {
      nb.children?.forEach(sg => {
        sg.children?.forEach(section => {
          section.children?.forEach(page => {
            let sName = sg.displayName;
            if (sName.includes('Collaboration Space') || sName.includes('Content Library')) {
              sName = page.displayName.replace(/^[0-9\s-]+/, '');
            }
            allPages.push({
              pageId: page.id,
              pageTitle: cleanNotebookDisplayName(page.displayName),
              classId: nb.id,
              studentName: sName,
              lastModified: page.lastModified
            });
          });
        });
      });
    });

    const currentIndex = allPages.findIndex(p => p.pageId === activePageId);
    if (currentIndex !== -1 && currentIndex < allPages.length - 1) {
      const next = allPages[currentIndex + 1];
      handlePageClick(next.pageId, next.pageTitle, next.classId, next.studentName, next.lastModified);
    } else {
      addLog("No more pages to review in this notebook.");
    }
  };

  const handleNextNotReady = () => {
    if (!parsedPageContent) return;
    
    const notReadyIndex = parsedPageContent.findIndex((entry, i) => {
      const id = entry.id || String(i);
      return entryStatus[id] !== 'approved';
    });
    
    if (notReadyIndex !== -1) {
      const el = document.getElementById(`entry-${notReadyIndex}`);
      if (el) {
        setActiveFeedbackEntryIndex(notReadyIndex);
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        addLog(`Jumping to entry ${notReadyIndex + 1} not yet marked feedback ready.`);
      }
    } else {
      goToNextPage();
    }
  };

  const handleAnalyzeAll = async () => {
    setAnalyzing(true);
    addLog(`AI Batch Audit (${selectedTemplate})...`);
    const updated = [...entries];
    for (let i = 0; i < updated.length; i++) {
      if (!updated[i].analysis) {
        addLog(`Analyzing ${updated[i].studentName}...`);
        const res = await analyzeEntry(updated[i], selectedTemplate, (attempt, delay) => {
          addLog(`Analysis rate limit hit. Retrying in ${Math.round(delay/1000)}s... (Attempt ${attempt}/3)`);
        });
        updated[i] = { ...updated[i], analysis: res, templateUsed: selectedTemplate };
        setEntries([...updated]);
      }
    }
    setAnalyzing(false);
    addLog("Batch audit complete.");
  };

  const stats = useMemo(() => {
    const total = entries.length;
    const analyzed = entries.filter(e => e.analysis).length;
    return { total, analyzed, completion: total > 0 ? Math.round((analyzed / total) * 100) : 0 };
  }, [entries]);

  const visibleClasses = useMemo(
    () => classes.filter((cls) => showAllNotebooks || cls.accessStatus === 'accessible'),
    [classes, showAllNotebooks]
  );
  const savedRosterCount = useMemo(
    () => classes.filter((cls) => cls.rosterStatus === 'saved').length,
    [classes]
  );
  const discoveredOnlyCount = useMemo(
    () => classes.filter((cls) => cls.rosterStatus !== 'saved').length,
    [classes]
  );

  const scrollToStudent = (id: string) => {
    const element = document.getElementById(`student-${id}`);
    if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const isConfigured = true; // Config is now server-side

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-slate-50 text-slate-900 overflow-hidden">
      {/* Sidebar */}
      <aside className={`${sidebarCollapsed ? 'w-16' : 'w-full md:w-80'} bg-white border-r border-slate-200 flex flex-col h-screen z-40 transition-[width] duration-200 ease-out overflow-hidden flex-shrink-0`}>

        {/* Collapsed icon rail */}
        {sidebarCollapsed && (
          <div className="flex flex-col items-center py-3 gap-0.5 flex-1">
            <button
              onClick={handleWorkspaceOverview}
              className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-sm mb-0.5 hover:bg-indigo-700 transition-colors"
              title="Workspace overview"
              aria-label="Open workspace overview"
            >
              <BookOpen className="text-white w-5 h-5" />
            </button>
            <button onClick={() => setSidebarCollapsedPersisted(false)} className="p-2.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors" title="Expand sidebar">
              <ChevronRight size={22} strokeWidth={2.5} />
            </button>
            <div className="w-8 border-t border-slate-100 my-1.5" />
            <button onClick={() => setShowSettings(true)} className="p-2.5 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors" title="Settings">
              <Settings size={20} />
            </button>
            <div className="w-8 border-t border-slate-100 my-1.5" />
            <button
              onClick={() => { const next = syncMode === 'diary' ? 'assignments' : 'diary'; setSyncMode(next); addLog(`[Telemetry] mode_changed: ${next}`); }}
              className={`p-2.5 rounded-lg transition-colors ${syncMode === 'diary' ? 'text-indigo-600 bg-indigo-50' : 'text-slate-500 hover:text-indigo-600 hover:bg-indigo-50'}`}
              title={syncMode === 'diary' ? 'Diary mode — click for Assignments' : 'Assignments mode — click for Diary'}
            >
              {syncMode === 'diary' ? <BookOpen size={20} /> : <FileText size={20} />}
            </button>
            <button
              onClick={() => { setSidebarCollapsedPersisted(false); addLog('[Telemetry] refresh_scope_full_rescan'); handleDiscoverAll(); }}
              disabled={loading}
              className="p-2.5 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors disabled:opacity-40"
              title="Discover Notebooks (expands sidebar)"
            >
              {loading ? <RefreshCw size={20} className="animate-spin text-indigo-400" /> : <Search size={20} />}
            </button>
            <button onClick={handleSyncSelected} disabled={loading || syncingPages || isSyncingClass || selectedNotebookIds.size === 0} className="p-2.5 rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors disabled:opacity-40" title="Load Notebooks">
              {syncingPages ? <RefreshCw size={20} className="animate-spin text-indigo-400" /> : <UploadCloud size={20} />}
            </button>
            <div className="flex-1" />
            <button
              onClick={openClassDashboard}
              aria-disabled={!classWorkspaceToolsReady}
              className={`p-2.5 rounded-lg transition-colors mb-1 ${
                classWorkspaceToolsReady
                  ? 'text-slate-500 hover:text-indigo-600 hover:bg-indigo-50'
                  : 'text-slate-300 hover:text-amber-600 hover:bg-amber-50'
              }`}
              title={classWorkspaceUnavailableReason || 'Open Class Dashboard'}
            >
              <BarChart3 size={20} />
            </button>
            <button
              onClick={openExportDialog}
              aria-disabled={!classWorkspaceToolsReady}
              className={`p-2.5 rounded-lg transition-colors mb-1 ${
                classWorkspaceToolsReady
                  ? 'text-slate-500 hover:text-indigo-600 hover:bg-indigo-50'
                  : 'text-slate-300 hover:text-amber-600 hover:bg-amber-50'
              }`}
              title={classWorkspaceUnavailableReason || 'Export records'}
            >
              <Download size={20} />
            </button>
          </div>
        )}

        {/* Expanded sidebar */}
        {!sidebarCollapsed && (
        <><div className="p-4 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={handleWorkspaceOverview}
              className="flex items-center gap-2 min-w-0 rounded-xl p-1 -m-1 hover:bg-indigo-50 transition-colors"
              title="Workspace overview"
              aria-label="Open workspace overview"
            >
              <div className="w-8 h-8 bg-indigo-600 rounded-xl flex items-center justify-center shadow-indigo-100 shadow-lg">
                <BookOpen className="text-white w-4 h-4" />
              </div>
              <h1 className="font-bold text-base tracking-tight text-slate-800">Journaler</h1>
            </button>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setShowSettings(true); }}
                className={`p-1.5 rounded-lg transition-all relative ${!isConfigured ? 'text-amber-500 bg-amber-50 animate-pulse' : 'text-slate-500 hover:bg-slate-200'}`}
                title="Settings"
              >
                <Settings size={18} />
                {!isConfigured && <div className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full border-2 border-white"></div>}
              </button>
              <button onClick={() => setSidebarCollapsedPersisted(true)} className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors" title="Collapse sidebar">
                <ChevronLeft size={22} strokeWidth={2.5} />
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-col gap-1">
              <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest ml-1">Sync Mode</label>
              <div className="flex bg-slate-100 p-1 rounded-lg">
                <button 
                  onClick={() => {
                    setSyncMode('diary');
                    addLog(`[Telemetry] mode_changed: diary`);
                  }}
                  className={`flex-1 py-1 text-[11px] font-bold rounded-md transition-all ${syncMode === 'diary' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Diary
                </button>
                <button 
                  onClick={() => {
                    setSyncMode('assignments');
                    addLog(`[Telemetry] mode_changed: assignments`);
                  }}
                  className={`flex-1 py-1 text-[11px] font-bold rounded-md transition-all ${syncMode === 'assignments' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  Assignments
                </button>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button 
                onClick={() => {
                  addLog(`[Telemetry] refresh_scope_full_rescan`);
                  handleDiscoverAll();
                }}
                disabled={loading}
                title="Refresh the list of available class notebooks from Microsoft 365"
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-bold transition-all shadow-sm ${
                  loading ? 'bg-slate-50 text-slate-400 border-slate-100' : 'bg-white border border-slate-200 hover:border-indigo-300 text-slate-700 active:scale-95 disabled:opacity-50'
                }`}
              >
                {loading ? <RefreshCw size={12} className="animate-spin text-indigo-400"/> : <Search size={12} className="text-indigo-500"/>}
                Discover Notebooks
              </button>
              <button 
                onClick={handleSyncSelected}
                disabled={loading || syncingPages || isSyncingClass || selectedNotebookIds.size === 0}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-bold transition-all shadow-sm ${
                  loading || syncingPages || isSyncingClass || selectedNotebookIds.size === 0 ? 'bg-slate-50 text-slate-400 border-slate-100' : 'bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95'
                }`}
              >
                {syncingPages ? <RefreshCw size={12} className="animate-spin"/> : <RefreshCw size={12}/>}
                Load Notebooks
              </button>
            </div>
            <button
              onClick={handleSyncAllClasses}
              disabled={loading || syncingPages || isSyncingClass || selectedNotebookIds.size === 0 || !firebaseUser}
              className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-bold transition-all shadow-sm ${
                loading || syncingPages || isSyncingClass || selectedNotebookIds.size === 0 || !firebaseUser
                  ? 'bg-slate-50 text-slate-400 border-slate-100'
                  : 'bg-emerald-600 text-white hover:bg-emerald-700 active:scale-95'
              }`}
              title={!firebaseUser ? 'Connect saved records before running the sync queue' : 'Run the Firestore sync queue for all selected notebooks'}
            >
              {isSyncingClass ? <RefreshCw size={12} className="animate-spin" /> : <UploadCloud size={12} />}
              Sync All Selected
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          <div className="flex items-start justify-between mb-2 gap-3">
            <div>
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1 block">Active Roster</label>
              <p className="text-[10px] text-slate-400 ml-1 mt-1">
                {savedRosterCount} saved, {discoveredOnlyCount} discovered
                {lastDiscoveryAt ? ` · found ${new Date(lastDiscoveryAt).toLocaleString()}` : ''}
              </p>
            </div>
            <button 
              onClick={() => setShowAllNotebooks(!showAllNotebooks)}
              className={`text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded-md transition-colors ${showAllNotebooks ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
            >
              Show All
            </button>
          </div>
          {visibleClasses.map(cls => (
            <div key={cls.id} className={`flex items-start gap-2.5 px-3 py-3 rounded-xl text-sm transition-all border ${
                selectedNotebookIds.has(cls.id)
                  ? 'bg-indigo-50 border-indigo-200 shadow-sm' 
                  : 'bg-white border-slate-100 hover:border-indigo-100'
              }`}>
              <input 
                type="checkbox" 
                checked={selectedNotebookIds.has(cls.id)}
                disabled={syncingPages || isSyncingClass}
                onChange={(e) => {
                  const next = new Set(selectedNotebookIds);
                  if (e.target.checked) next.add(cls.id);
                  else next.delete(cls.id);
                  setSelectedNotebookIds(next);
                  setClasses((prev) =>
                    prev.map((item) =>
                      item.id === cls.id
                        ? { ...item, rosterStatus: e.target.checked ? 'saved' : 'discovered' }
                        : item
                    )
                  );
                }}
                className="w-3.5 h-3.5 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer disabled:opacity-50"
              />
              <div className={`flex-1 min-w-0 ${syncingPages || isSyncingClass ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`} onClick={() => {
                  if (syncingPages || isSyncingClass) return;
                  const next = new Set(selectedNotebookIds);
                  const willSelect = !next.has(cls.id);
                  if (next.has(cls.id)) next.delete(cls.id);
                  else next.add(cls.id);
                  setSelectedNotebookIds(next);
                  setClasses((prev) =>
                    prev.map((item) =>
                      item.id === cls.id
                        ? { ...item, rosterStatus: willSelect ? 'saved' : 'discovered' }
                        : item
                    )
                  );
              }}>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-bold text-[13px] truncate text-slate-700 min-w-0" title={cls.displayName}>{cls.displayName}</p>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className={`text-[8px] font-bold uppercase px-2 py-0.5 rounded-full whitespace-nowrap ${
                      isSyncingClass && syncingClassId === cls.id
                        ? 'bg-indigo-50 text-indigo-600'
                        : cls.lastSynced
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-slate-100 text-slate-500'
                    }`}>
                      {isSyncingClass && syncingClassId === cls.id
                        ? 'Syncing…'
                        : cls.lastSynced
                          ? 'Sync recorded'
                          : 'Not synced'}
                    </span>
                    {cls.accessStatus === 'inaccessible' && <Lock size={12} className="text-slate-400"/>}
                    {selectedNotebookIds.has(cls.id) && (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSyncClass(cls.id);
                          }}
                          disabled={isSyncingClass}
                          className="p-1 hover:bg-indigo-100 rounded-md text-indigo-500 transition-colors"
                          title="Sync: fetch updated pages only"
                        >
                          <RefreshCw size={10} className={isSyncingClass && syncingClassId === cls.id ? 'animate-spin' : ''} />
                        </button>
                        {cls.lastSynced && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSyncClass(cls.id, undefined, true);
                            }}
                            disabled={isSyncingClass}
                            className="p-1 hover:bg-amber-100 rounded-md text-amber-500 transition-colors"
                            title="Force re-sync: reprocess all pages, ignoring freshness. Use to backfill legacy data."
                          >
                            <RotateCcw size={10} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {/* cls.description hidden by default — it is a Teams class team field
                    intended for Teams-context use and adds noise in this UI. The data
                    is still loaded and stored; only the visual rendering is suppressed. */}
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className="text-[9px] text-slate-400 font-medium">
                    {cls.lastSynced ? `Last synced ${new Date(cls.lastSynced).toLocaleString()}` : 'Not synced yet'}
                  </span>
                  {(() => {
                    // Slice 5: archive-capture verdict, by-exception. "Captured" stays
                    // quiet; states needing action (rate-limited / errored pages) speak up.
                    // Prefixed "Archive capture:" so it is never read as classroom freshness.
                    const capture = archiveCaptureByClass.get(cls.id);
                    if (!capture || capture.state === 'none') return null;
                    const needsAction = capture.state !== 'captured';
                    return (
                      <span
                        className={`text-[9px] whitespace-nowrap ${needsAction ? 'font-bold text-amber-600' : 'font-medium text-slate-400'}`}
                        title={`Archive capture: ${capture.saved} saved, ${capture.pending} pending, ${capture.errored} failed`}
                      >
                        {`Archive capture: ${capture.label}`}
                      </span>
                    );
                  })()}
                </div>
                <div
                  className="mt-2 flex items-center justify-between gap-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">
                      Parser
                    </span>
                    <span className="text-[9px] text-slate-500 font-medium truncate">
                      {cls.parserMode === 'label-first'
                        ? 'Labels first, AI retry only on demand'
                        : 'AI first for flexible layouts'}
                    </span>
                  </div>
                  <div className="flex bg-slate-100 p-0.5 rounded-lg shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleClassParserModeChange(cls.id, 'ai');
                      }}
                      className={`px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-wider transition-colors ${
                        (cls.parserMode || DEFAULT_PARSER_MODE) === 'ai'
                          ? 'bg-white text-indigo-600 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                      title="Use Gemini parsing first for this class"
                    >
                      AI
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleClassParserModeChange(cls.id, 'label-first');
                      }}
                      className={`px-2 py-1 rounded-md text-[9px] font-black uppercase tracking-wider transition-colors ${
                        cls.parserMode === 'label-first'
                          ? 'bg-white text-indigo-600 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}
                      title="Use the labeled diary template parser first for this class"
                    >
                      Labels
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
          {classes.length === 0 && !loading && (
            <div className="text-center py-16 px-6 bg-slate-50/50 rounded-3xl border border-dashed border-slate-200">
              <LayoutGrid className="mx-auto text-slate-200 mb-4" size={48} />
              <p className="text-[11px] text-slate-400 font-bold uppercase tracking-widest leading-relaxed">No notebooks found.<br/>Click 'Discover Notebooks' to begin.</p>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-slate-100 bg-slate-50/50 flex items-center gap-2">
          <button
            onClick={openClassDashboard}
            aria-disabled={!classWorkspaceToolsReady}
            className={`flex flex-1 items-center gap-1.5 px-2 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-md border transition-colors ${
              classWorkspaceToolsReady
                ? 'text-indigo-700 hover:bg-white border-indigo-100 bg-indigo-50'
                : 'text-slate-400 border-slate-200 bg-white/60 hover:text-amber-700 hover:border-amber-200 hover:bg-amber-50'
            }`}
            title={classWorkspaceUnavailableReason || 'Open the read-only Class Dashboard for selected classes'}
          >
            <BarChart3 size={11} />
            Class Dashboard
          </button>
          <button
            onClick={openExportDialog}
            aria-disabled={!classWorkspaceToolsReady}
            className={`flex items-center gap-1 px-2 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-md border transition-colors ${
              classWorkspaceToolsReady
                ? 'text-slate-500 hover:text-indigo-700 hover:bg-white border-transparent hover:border-slate-200'
                : 'text-slate-400 border-slate-200 bg-white/60 hover:text-amber-700 hover:border-amber-200 hover:bg-amber-50'
            }`}
            title={classWorkspaceUnavailableReason || 'Export records'}
          >
            <Download size={10} />
            Export
          </button>
        </div>
        </>)}
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden h-screen relative">
        {showFeedbackModal && (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-5xl w-full flex flex-col animate-in zoom-in duration-200 max-h-[90vh] overflow-hidden relative">
              <button
                onClick={closeFeedbackModal}
                className="absolute top-5 right-5 p-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-500 transition-colors z-20"
                title="Close"
              >
                <X size={20} />
              </button>

              <div className="flex-1 p-6 md:p-8 overflow-y-auto bg-slate-50/40">
                {compiledFeedback && (
                  <div className="space-y-5">
                    <div className="flex items-start justify-between gap-4 pr-12">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-12 h-12 bg-indigo-600 text-white rounded-xl flex items-center justify-center shadow-sm">
                          <Send size={24} />
                        </div>
                        <div>
                          <h2 className="text-xl font-black tracking-tight text-slate-900">Review & Send Feedback</h2>
                          <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">
                            {cleanStudentDisplayName(activeStudentName) || 'This student'} · Email and Teams delivery
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-5 items-start">
                      <div className="space-y-4 lg:sticky lg:top-0">
                    <div className="bg-white border border-slate-200 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <label className="block text-sm font-bold text-slate-700">Student Email (UPN)</label>
                        {/* Resolution status chip */}
                        {isResolvingEmail && (
                          <span className="flex items-center gap-1.5 text-xs font-medium text-indigo-600">
                            <Loader2 className="animate-spin" size={13} />
                            Resolving recipient...
                          </span>
                        )}
                        {!isResolvingEmail && emailResolutionSource === 'roster' && (
                          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                            <CheckCircle size={13} />
                            Resolved from class roster
                          </span>
                        )}
                        {!isResolvingEmail && emailResolutionSource === 'graph_search' && (
                          <span className="flex items-center gap-1.5 text-xs font-medium text-indigo-500">
                            <CheckCircle size={13} />
                            Resolved from Microsoft search
                          </span>
                        )}
                        {!isResolvingEmail && emailResolutionSource === 'manual' && (
                          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                            <Info size={13} />
                            Manually entered
                          </span>
                        )}
                        {!isResolvingEmail && !emailResolutionSource && compiledFeedback.studentEmail && (
                          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                            <Info size={13} />
                            Manually entered
                          </span>
                        )}
                      </div>
                      <input
                        type="email"
                        value={compiledFeedback.studentEmail || ''}
                        onChange={(e) => {
                          setCompiledFeedback({...compiledFeedback, studentEmail: e.target.value});
                          markEmailManuallyEdited();
                        }}
                        placeholder={isResolvingEmail ? "Resolving automatically..." : "student@school.edu"}
                        disabled={isResolvingEmail}
                        className={`w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 ${isResolvingEmail ? 'opacity-70' : ''}`}
                      />
                      {!isResolvingEmail && !compiledFeedback.studentEmail && (
                        <p className="text-xs text-amber-600 mt-2 font-medium flex items-center gap-1.5">
                          <AlertCircle size={13} /> Not found in directory. Enter the student's UPN manually to enable sending.
                        </p>
                      )}
                      <p className="text-xs text-slate-400 mt-2">This is the student's User Principal Name (UPN). In Microsoft 365, this single address routes both Emails and Teams messages.</p>
                    </div>

                    {batchEntryOptions.length > 1 && (
                      <div className="bg-white border border-slate-200 rounded-xl p-4">
                        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 mb-3">
                          <div>
                            <h3 className="text-sm font-bold text-slate-700">Feedback Weeks</h3>
                            <p className="text-xs text-slate-400 mt-1">
                              Reviewed is internal only and is not sent to the student.
                            </p>
                          </div>
                        </div>
                        <div className="divide-y divide-slate-100 border-y border-slate-100">
                          {batchEntryOptions.map((option) => (
                            <div
                              key={option.entryId}
                              className="space-y-2 py-2.5"
                            >
                              <div className="min-w-0 flex items-center gap-2">
                                <p className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">
                                  {option.label}
                                </p>
                                {option.isCurrent && (
                                  <span className="shrink-0 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-indigo-600">
                                    Current
                                  </span>
                                )}
                                {!option.hasTeacherFeedback && !option.isCurrent && (
                                  <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-700">
                                    No feedback
                                  </span>
                                )}
                              </div>
                              <div className="grid w-full grid-cols-3 overflow-hidden rounded-lg border border-slate-200 bg-slate-100 p-0.5">
                                {[
                                  ['include_feedback', 'Send'],
                                  ['reviewed_no_feedback', 'Reviewed'],
                                  ['pending', 'Pending'],
                                ].map(([value, label]) => {
                                  const includeDisabled =
                                    value === 'include_feedback' &&
                                    !option.isCurrent &&
                                    !option.hasTeacherFeedback;
                                  return (
                                    <label
                                      key={value}
                                      className={`flex min-h-[28px] items-center justify-center rounded-md px-1.5 text-center text-[11px] font-bold transition-colors ${
                                        option.decision === value
                                          ? 'bg-white text-indigo-700 shadow-sm'
                                          : 'text-slate-500'
                                      } ${includeDisabled ? 'opacity-40' : 'cursor-pointer hover:text-indigo-600'}`}
                                    >
                                      <input
                                        type="radio"
                                        name={`batch-entry-${option.entryId}`}
                                        value={value}
                                        checked={option.decision === value}
                                        disabled={includeDisabled}
                                        onChange={() =>
                                          updateBatchEntryDecision(
                                            option.entryId,
                                            value as FeedbackBatchDecision
                                          )
                                        }
                                        className="sr-only"
                                      />
                                      <span>{label}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                      </div>
                      <div className="space-y-4">
                    {batchEntryOptions.length > 1 && includedBatchPreviewItems.length > 0 && (
                      <div className="bg-white border border-indigo-200 rounded-xl p-4 shadow-sm">
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <div>
                            <h3 className="text-sm font-bold text-slate-800">Outgoing Feedback Preview</h3>
                            <p className="text-xs text-slate-400 mt-1">
                              This is the message set selected for delivery.
                            </p>
                          </div>
                          <span className="shrink-0 rounded-full bg-indigo-50 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-indigo-600">
                            {includedBatchPreviewItems.length} {includedBatchPreviewItems.length === 1 ? 'week' : 'weeks'}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 max-h-[300px] overflow-y-auto pr-1">
                          {includedBatchPreviewItems.map((item) => (
                            <div
                              key={item.entryId}
                              className="rounded-lg border border-slate-100 bg-slate-50/70 p-2.5"
                            >
                              <div className="flex items-center gap-2 mb-1.5">
                                <h4 className="min-w-0 flex-1 truncate text-xs font-black text-slate-700">
                                  {item.label}
                                </h4>
                                {item.isCurrent && (
                                  <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-indigo-600">
                                    Current
                                  </span>
                                )}
                              </div>
                              <div className="space-y-1 text-[11px] leading-snug text-slate-500">
                                {item.feedback.includeDiary && item.feedback.diaryFeedback && (
                                  <p className="line-clamp-2">
                                    <span className="font-bold text-slate-600">Diary:</span> {item.feedback.diaryFeedback}
                                  </p>
                                )}
                                {item.feedback.includePeer && item.feedback.peerFeedback && (
                                  <p className="line-clamp-2">
                                    <span className="font-bold text-slate-600">Peer:</span> {item.feedback.peerFeedback}
                                  </p>
                                )}
                                {item.feedback.includeVocab && item.feedback.vocabFeedback && (
                                  <p className="line-clamp-2">
                                    <span className="font-bold text-slate-600">Vocabulary:</span> {item.feedback.vocabFeedback}
                                  </p>
                                )}
                                {item.feedback.includeTranslations && item.feedback.translationsFeedback && (
                                  <p className="line-clamp-2">
                                    <span className="font-bold text-slate-600">Definitions:</span> {item.feedback.translationsFeedback}
                                  </p>
                                )}
                                {item.feedback.includeChatbot && item.feedback.chatbotFeedback && (
                                  <p className="line-clamp-2">
                                    <span className="font-bold text-slate-600">Chatbot:</span> {item.feedback.chatbotFeedback}
                                  </p>
                                )}
                                {item.feedback.includeOverall && item.feedback.overallFeedback && (
                                  <p className="line-clamp-2">
                                    <span className="font-bold text-slate-600">Overall:</span> {item.feedback.overallFeedback}
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="bg-white border border-slate-200 rounded-xl p-3">
                      <label className="block text-xs font-bold text-slate-700 mb-1.5">Greeting</label>
                      <textarea 
                        value={compiledFeedback.greeting}
                        onChange={(e) => setCompiledFeedback({...compiledFeedback, greeting: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm leading-relaxed text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y"
                        rows={batchEntryOptions.length > 1 ? 3 : 2}
                      />
                      {batchEntryOptions.length > 1 && (
                        <div className="mt-3">
                          <label className="block text-xs font-bold text-slate-700 mb-1.5">Closing</label>
                          <textarea
                            value={compiledFeedback.closing}
                            onChange={(e) => setCompiledFeedback({...compiledFeedback, closing: e.target.value})}
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm leading-relaxed text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y"
                            rows={2}
                          />
                        </div>
                      )}
                    </div>

                    {batchEntryOptions.length <= 1 && (
                      <>
                    <div className={`bg-white border ${compiledFeedback.includeDiary ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-slate-200 opacity-70'} rounded-xl p-4 transition-all`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <input 
                            type="checkbox" 
                            checked={compiledFeedback.includeDiary}
                            onChange={(e) => setCompiledFeedback({...compiledFeedback, includeDiary: e.target.checked})}
                            className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
                          />
                          <label className="block text-sm font-bold text-slate-700">Diary Feedback</label>
                        </div>
                        <span className="text-xs font-medium text-slate-400">Focused Correction</span>
                      </div>
                      <textarea
                        disabled={!compiledFeedback.includeDiary}
                        value={compiledFeedback.diaryFeedback}
                        onChange={(e) => setCompiledFeedback({...compiledFeedback, diaryFeedback: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y disabled:bg-slate-100 disabled:text-slate-400"
                        rows={3}
                        placeholder="Leave blank to omit..."
                      />
                    </div>

                    <div className={`bg-white border ${compiledFeedback.includePeer ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-slate-200 opacity-70'} rounded-xl p-4 transition-all`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={!!compiledFeedback.includePeer}
                            onChange={(e) => setCompiledFeedback({...compiledFeedback, includePeer: e.target.checked})}
                            className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
                          />
                          <label className="block text-sm font-bold text-slate-700">Peer Feedback</label>
                        </div>
                        <span className="text-xs font-medium text-slate-400">Focused Correction</span>
                      </div>
                      <textarea
                        disabled={!compiledFeedback.includePeer}
                        value={compiledFeedback.peerFeedback || ''}
                        onChange={(e) => setCompiledFeedback({...compiledFeedback, peerFeedback: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y disabled:bg-slate-100 disabled:text-slate-400"
                        rows={3}
                        placeholder="Leave blank to omit..."
                      />
                    </div>

                    <div className={`bg-white border ${compiledFeedback.includeVocab ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-slate-200 opacity-70'} rounded-xl p-4 transition-all`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <input 
                            type="checkbox" 
                            checked={compiledFeedback.includeVocab}
                            onChange={(e) => setCompiledFeedback({...compiledFeedback, includeVocab: e.target.checked})}
                            className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
                          />
                          <label className="block text-sm font-bold text-slate-700">Vocabulary Feedback</label>
                        </div>
                        <span className="text-xs font-medium text-slate-400">Focused Correction</span>
                      </div>
                      <textarea
                        disabled={!compiledFeedback.includeVocab}
                        value={compiledFeedback.vocabFeedback}
                        onChange={(e) => setCompiledFeedback({...compiledFeedback, vocabFeedback: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y disabled:bg-slate-100 disabled:text-slate-400"
                        rows={3}
                        placeholder="Leave blank to omit..."
                      />
                    </div>

                    <div className={`bg-white border ${compiledFeedback.includeTranslations ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-slate-200 opacity-70'} rounded-xl p-4 transition-all`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={!!compiledFeedback.includeTranslations}
                            onChange={(e) => setCompiledFeedback({...compiledFeedback, includeTranslations: e.target.checked})}
                            className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
                          />
                          <label className="block text-sm font-bold text-slate-700">Definitions & Examples Feedback</label>
                        </div>
                        <span className="text-xs font-medium text-slate-400">Focused Correction</span>
                      </div>
                      <textarea
                        disabled={!compiledFeedback.includeTranslations}
                        value={compiledFeedback.translationsFeedback || ''}
                        onChange={(e) => setCompiledFeedback({...compiledFeedback, translationsFeedback: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y disabled:bg-slate-100 disabled:text-slate-400"
                        rows={3}
                        placeholder="Leave blank to omit..."
                      />
                    </div>

                    <div className={`bg-white border ${compiledFeedback.includeChatbot ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-slate-200 opacity-70'} rounded-xl p-4 transition-all`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={!!compiledFeedback.includeChatbot}
                            onChange={(e) => setCompiledFeedback({...compiledFeedback, includeChatbot: e.target.checked})}
                            className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
                          />
                          <label className="block text-sm font-bold text-slate-700">Chatbot Feedback</label>
                        </div>
                        <span className="text-xs font-medium text-slate-400">Focused Correction</span>
                      </div>
                      <textarea
                        disabled={!compiledFeedback.includeChatbot}
                        value={compiledFeedback.chatbotFeedback || ''}
                        onChange={(e) => setCompiledFeedback({...compiledFeedback, chatbotFeedback: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y disabled:bg-slate-100 disabled:text-slate-400"
                        rows={3}
                        placeholder="Leave blank to omit..."
                      />
                    </div>

                    <div className={`bg-white border ${compiledFeedback.includeOverall ? 'border-indigo-200 ring-1 ring-indigo-100' : 'border-slate-200 opacity-70'} rounded-xl p-4 transition-all`}>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <input 
                            type="checkbox" 
                            checked={compiledFeedback.includeOverall}
                            onChange={(e) => setCompiledFeedback({...compiledFeedback, includeOverall: e.target.checked})}
                            className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500 cursor-pointer"
                          />
                          <label className="block text-sm font-bold text-slate-700">Overall Comments</label>
                        </div>
                        <span className="text-xs font-medium text-slate-400">Praise & Action Items</span>
                      </div>
                      <textarea 
                        disabled={!compiledFeedback.includeOverall}
                        value={compiledFeedback.overallFeedback}
                        onChange={(e) => setCompiledFeedback({...compiledFeedback, overallFeedback: e.target.value})}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y disabled:bg-slate-100 disabled:text-slate-400"
                        rows={3}
                        placeholder="Leave blank to omit..."
                      />
                    </div>
                      </>
                    )}

                    {batchEntryOptions.length <= 1 && (
                      <div className="bg-white border border-slate-200 rounded-xl p-3">
                        <label className="block text-xs font-bold text-slate-700 mb-1.5">Closing</label>
                        <textarea
                          value={compiledFeedback.closing}
                          onChange={(e) => setCompiledFeedback({...compiledFeedback, closing: e.target.value})}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm leading-relaxed text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-y"
                          rows={2}
                        />
                      </div>
                    )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-slate-200 px-6 md:px-8 py-4 flex items-center justify-between bg-white">
                <span className="text-[11px] font-medium text-slate-400">
                  {includedBatchPreviewItems.length > 1
                    ? `${includedBatchPreviewItems.length} weeks selected for one message`
                    : batchEntryOptions.length > 1
                      ? 'Multi-week delivery ready'
                      : 'Single-entry delivery ready'}
                </span>
                <div className="flex justify-end gap-3">
                <button
                  onClick={closeFeedbackModal}
                  disabled={isSendingFeedback}
                  className="px-4 py-2.5 text-sm font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => handleSendFeedback('teams')}
                  disabled={isSendingFeedback || isResolvingEmail || !compiledFeedback?.studentEmail}
                  className="px-4 py-2.5 text-sm font-bold text-white bg-[#5B5FC7] hover:bg-[#464775] rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {isSendingFeedback ? <Loader2 className="animate-spin" size={18} /> : <MessageSquare size={18} />}
                  Send via Teams
                </button>
                <button
                  onClick={() => handleSendFeedback('email')}
                  disabled={isSendingFeedback || isResolvingEmail || !compiledFeedback?.studentEmail}
                  className="px-4 py-2.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {isSendingFeedback ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
                  Send via Email
                </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showExportDialog && firebaseUser && (
          <ExportDialog
            db={db}
            uid={firebaseUser.uid}
            classes={classes}
            initialClassIds={Array.from(selectedNotebookIds)}
            onClose={() => setShowExportDialog(false)}
          />
        )}

        {showSettings && (
          <SettingsModal
            machineConfig={machineConfig}
            setMachineConfig={setMachineConfig}
            preferences={preferences}
            savePref={savePref}
            config={config}
            setConfig={setConfig}
            connectionState={{
              microsoftSignedIn: Boolean(account),
              microsoftLabel: account?.username || account?.name || null,
              firebaseSignedIn: Boolean(firebaseUser),
              firebaseLabel: firebaseUser?.email || firebaseUser?.displayName || null,
              firebaseProjectId: firebaseProjectInfo.projectId,
              hasGeminiKey,
            }}
            onMicrosoftLogin={handleLogin}
            onMicrosoftLogout={handleLogout}
            onFirebaseLogin={() => handleFirebaseLogin()}
            onFirebaseLogout={handleFirebaseLogout}
            onSelectGeminiKey={handleSelectKey}
            addLog={addLog}
            logs={logs}
            setLogs={setLogs}
            onSaveLog={handleSaveLog}
            showDebugStream={showDebugStream}
            setShowDebugStream={setShowDebugStream}
            isInteracting={isInteracting}
            hasDebugActivity={hasDebugActivity}
            onClose={() => setShowSettings(false)}
          />
        )}

        {showHelp && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white w-full max-w-2xl rounded-[32px] shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200">
              <div className="p-8 border-b border-slate-100 flex items-center justify-between bg-indigo-50/50">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-200">
                    <HelpCircle size={24} />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-slate-900 tracking-tight">Help & Documentation</h2>
                    <p className="text-xs font-bold text-indigo-600 uppercase tracking-widest">Guide & Roadmap</p>
                  </div>
                </div>
                <button onClick={() => setShowHelp(false)} className="p-2 hover:bg-white rounded-xl transition-colors text-slate-400 hover:text-slate-600 shadow-sm border border-transparent hover:border-slate-200">
                  <X size={20} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-8 space-y-10">
                {/* Symbols Guide */}
                <section>
                  <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <div className="w-1.5 h-4 bg-indigo-500 rounded-full" />
                    Notebook Symbols
                  </h3>
                  <div className="grid gap-4">
                    <div className="flex items-start gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center font-black text-indigo-600 shadow-sm border border-slate-100">*</div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">Recently Modified</h4>
                        <p className="text-xs text-slate-500 leading-relaxed">Indicates the student has updated their diary since your last sync or view.</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center font-black text-indigo-600 shadow-sm border border-slate-100">1234567</div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">Student ID Match</h4>
                        <p className="text-xs text-slate-500 leading-relaxed">A 7-digit ID was successfully found in the page title and extracted for sorting.</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center font-black text-indigo-600 shadow-sm border border-slate-100">?</div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">Unidentified Page</h4>
                        <p className="text-xs text-slate-500 leading-relaxed">No 7-digit ID was found. The page might be misnamed or a non-diary entry.</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center text-indigo-600 shadow-sm border border-slate-100">
                        <RefreshCw size={16} />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">Class Sync</h4>
                        <p className="text-xs text-slate-500 leading-relaxed">The class sync button fetches the latest OneNote pages for that class and updates the saved Firestore records used for later review and export.</p>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Roadmap */}
                <section>
                  <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <div className="w-1.5 h-4 bg-emerald-500 rounded-full" />
                    Future Roadmap
                  </h3>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 p-3 border-b border-slate-100">
                      <div className="w-2 h-2 bg-emerald-400 rounded-full" />
                      <span className="text-sm font-medium text-slate-700">Background Synchronization (Phase 2)</span>
                    </div>
                    <div className="flex items-center gap-3 p-3 border-b border-slate-100">
                      <div className="w-2 h-2 bg-slate-300 rounded-full" />
                      <span className="text-sm font-medium text-slate-700">Customizable Email/Teams Templates</span>
                    </div>
                    <div className="flex items-center gap-3 p-3 border-b border-slate-100">
                      <div className="w-2 h-2 bg-slate-300 rounded-full" />
                      <span className="text-sm font-medium text-slate-700">Class-wide Performance Analytics</span>
                    </div>
                    <div className="flex items-center gap-3 p-3 border-b border-slate-100">
                      <div className="w-2 h-2 bg-slate-300 rounded-full" />
                      <span className="text-sm font-medium text-slate-700">Voice-to-Feedback Dictation</span>
                    </div>
                  </div>
                </section>
              </div>

              <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-end">
                <button onClick={() => setShowHelp(false)} className="px-6 py-2 bg-slate-900 text-white text-xs font-bold rounded-xl hover:bg-slate-800 transition-all shadow-md active:scale-95">
                  Got it
                </button>
              </div>
            </div>
          </div>
        )}

        <div className={`flex-1 overflow-y-auto scroll-smooth flex flex-col ${(!syncingPages && notebookTree.length > 0) ? '' : 'p-8 lg:p-16'}`}>
          {error && (
            <div className="mb-12 p-8 bg-white border border-red-100 rounded-[32px] flex items-start gap-6 animate-in fade-in slide-in-from-top-6 duration-500 shadow-xl shadow-red-50">
              <div className="p-4 bg-red-50 rounded-2xl text-red-500 shadow-sm border border-red-100">
                <ShieldAlert size={32} />
              </div>
              <div className="flex-1">
                {error === SESSION_EXPIRED_MSG ? (
                  <>
                    <p className="font-black text-[10px] uppercase tracking-[0.2em] mb-2 text-red-400">Session Expired</p>
                    <p className="text-sm font-bold text-red-900 leading-relaxed mb-6">{error}</p>
                    <button
                      onClick={async () => { await handleLogout(); handleLogin(); }}
                      className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest px-6 py-3 bg-red-600 text-white rounded-xl shadow-lg shadow-red-100 hover:bg-red-700 transition-all"
                    >
                      <RefreshCw size={14}/> Sign In Again
                    </button>
                  </>
                ) : (
                  <>
                    <p className="font-black text-[10px] uppercase tracking-[0.2em] mb-2 text-red-400">Connection Blocked</p>
                    <p className="text-sm font-bold text-red-900 leading-relaxed mb-6">{error}</p>
                    <div className="flex gap-4">
                      <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest px-6 py-3 bg-red-600 text-white rounded-xl shadow-lg shadow-red-100 hover:bg-red-700 transition-all">
                        <Activity size={14}/> Open Settings
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {workspaceMode === 'dashboard' && firebaseUser ? (
            <ClassDashboard
              db={db}
              uid={firebaseUser.uid}
              classes={classes}
              selectedClassIds={Array.from(selectedNotebookIds)}
              onClose={() => setWorkspaceMode('notebook')}
              embedded
              accessToken={accessToken || undefined}
              onOpenPage={(target) => {
                setWorkspaceMode('notebook');
                void handlePageClick(
                  target.pageId,
                  target.pageTitle,
                  target.classId,
                  target.studentName,
                  target.lastModified
                );
              }}
            />
          ) : !syncingPages && notebookTree.length === 0 ? (
            <WorkspaceHome
              account={account}
              firebaseUser={firebaseUser}
              firebaseProjectId={firebaseProjectInfo.projectId}
              hasGeminiKey={hasGeminiKey}
              isConfigured={isConfigured}
              isSandbox={config.isSandbox}
              isInteracting={isInteracting}
              isCheckingAuth={isCheckingAuth}
              loading={loading}
              loadingStep={loadingStep}
              classes={classes}
              selectedNotebookCount={selectedNotebookIds.size}
              onSelectKey={handleSelectKey}
              onLogin={handleLogin}
              onLogout={handleLogout}
              onFirebaseLogin={() => handleFirebaseLogin()}
              onFirebaseLogout={handleFirebaseLogout}
              onDiscoverAll={handleDiscoverAll}
              onSyncSelected={handleSyncSelected}
            />
          ) : (
            <div className="flex-1 flex overflow-hidden">
              {syncingPages && !sidebarCollapsed ? (
                <SyncProgressState
                  current={syncProgress.current}
                  total={syncProgress.total}
                  status={syncProgress.status}
                />
              ) : (
                <>
                  {/* Tree Menu */}
                  {showTreeMenu && (
                    <div className="w-72 border-r border-slate-200 overflow-y-auto bg-slate-50/80 p-4 flex-shrink-0 flex flex-col">
                      <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-100">
                        <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                          {isSyncingClass && syncProgress.total > 0 ? (
                            <>
                              <RefreshCw size={10} className="animate-spin text-indigo-400"/>
                              <span className="text-indigo-400">Syncing · {syncProgress.current} of {syncProgress.total}</span>
                            </>
                          ) : (
                            'Notebook Structure'
                          )}
                        </h3>
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={() => setShowHelp(true)} 
                            className="text-slate-400 hover:text-indigo-600 p-1.5 rounded-md hover:bg-indigo-50 transition-colors"
                            title="Help & Documentation"
                          >
                            <HelpCircle size={16}/>
                          </button>
                          <button onClick={() => setShowTreeMenu(false)} className="text-slate-400 hover:text-slate-600 p-2 rounded-md hover:bg-slate-100 transition-colors" title="Collapse notebook tree">
                            <ChevronLeft size={22} strokeWidth={2.5}/>
                          </button>
                        </div>
                      </div>
                      
                      {resumePrompt && !isSyncingClass && (
                        <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-xl flex flex-col gap-2">
                          <p className="text-[11px] text-amber-800 font-semibold leading-snug">
                            Pending sync for <span className="font-black">{resumePrompt.job.classDisplayName}</span>:{' '}
                            {resumePrompt.queued > 0 && `${resumePrompt.queued} queued`}
                            {resumePrompt.queued > 0 && resumePrompt.rateLimited > 0 && ', '}
                            {resumePrompt.rateLimited > 0 && `${resumePrompt.rateLimited} awaiting retry`}
                          </p>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleSyncClass(resumePrompt.job.classId, resumePrompt.job.jobId)}
                              className="flex-1 text-[11px] font-black py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                            >
                              Resume
                            </button>
                            <button
                              onClick={() => setResumePrompt(null)}
                              className="text-[11px] font-semibold py-1.5 px-3 rounded-lg bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors"
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="flex-1 overflow-y-auto pr-2">
                        {notebookTree.length === 0 ? (
                          <p className="text-slate-500 text-sm">No sections found.</p>
                        ) : (
                          <div className="space-y-2">
                            {notebookTree.map(nb => (
                              <div key={nb.id} className="space-y-2 mb-4">
                                <div className="flex items-center gap-2 text-indigo-700 font-black text-sm p-3 rounded-2xl bg-white border border-indigo-100 shadow-sm">
                                  <BookOpen size={16} className="text-indigo-600 flex-shrink-0"/>
                                  <span className="truncate flex-1">{nb.displayName}</span>
                                  {(() => {
                                    const summary = getNotebookSyncSummary(nb);
                                    if (!summary) return null;
                                    const hasProblems = summary.errors > 0 || summary.rateLimited > 0;
                                    const color = hasProblems ? (summary.errors > 0 ? 'text-red-400' : 'text-amber-500') : summary.saved === summary.total ? 'text-emerald-500' : 'text-slate-400';
                                    return (
                                      <span className={`text-[9px] font-bold tabular-nums flex-shrink-0 ${color}`} title={getNotebookSyncTitle(summary)}>
                                        {summary.saved}/{summary.total}
                                      </span>
                                    );
                                  })()}
                                </div>
                                {nb.children?.map(sg => (
                                  <div key={sg.id} className="space-y-1 pl-2">
                                    <button onClick={() => toggleNode(sg.id, 'sectionGroup')} className="w-full flex items-center gap-2 text-slate-800 font-bold hover:bg-white p-2 rounded-xl border border-transparent hover:border-slate-200 transition-colors">
                                      <ChevronRight size={18} strokeWidth={2.25} className={`transition-transform flex-shrink-0 text-slate-400 ${expandedNodes.has(sg.id) ? 'rotate-90' : ''}`} />
                                      <Users size={16} className="text-indigo-500"/>
                                      {sg.displayName}
                                    </button>
                                    
                                    {expandedNodes.has(sg.id) && (
                                      <div className="pl-6 space-y-1 border-l-2 border-indigo-100 ml-4 mt-1">
                                        {sg.children?.map(section => (
                                          <div key={section.id} className="space-y-1">
                                            <button onClick={() => toggleNode(section.id, 'section')} className="w-full flex items-center gap-2 text-slate-600 font-semibold text-sm hover:bg-white p-2 rounded-xl border border-transparent hover:border-slate-200 transition-colors">
                                              <ChevronRight size={18} strokeWidth={2.25} className={`transition-transform flex-shrink-0 text-slate-400 ${expandedNodes.has(section.id) ? 'rotate-90' : ''}`} />
                                              <BookOpen size={14} className="text-amber-500"/>
                                              {section.displayName}
                                            </button>
                                            
                                            {expandedNodes.has(section.id) && (
                                              <div className="pl-6 space-y-1 mt-1">
                                                {section.children?.length === 0 ? (
                                                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-400 italic">
                                                    <RefreshCw size={12} className="animate-spin"/> Loading pages...
                                                  </div>
                                                ) : (
                                                  section.children?.map(page => {
                                                    let sName = sg.displayName;
                                                    if (sName.includes('Collaboration Space') || sName.includes('Content Library')) {
                                                      // Strip leading numbers and dashes (e.g. "1234567 - Hanako Yamada" -> "Hanako Yamada")
                                                      sName = page.displayName.replace(/^[0-9\s-]+/, '');
                                                    }
                                                    return (
                                                    <button
                                                      key={page.id}
                                                      onClick={() => handlePageClick(page.id, cleanNotebookDisplayName(page.displayName), nb.id, sName, page.lastModified)}
                                                      className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-colors group border ${
                                                        activePageId === page.id
                                                          ? 'bg-indigo-100 border-indigo-200 text-indigo-700 font-bold shadow-sm'
                                                          : 'bg-white border-transparent hover:border-slate-200 hover:bg-white text-slate-600'
                                                      }`}
                                                    >
                                                      <FileText size={12} className={activePageId === page.id ? 'text-indigo-500' : 'text-slate-400 group-hover:text-indigo-500'}/>
                                                      <span className="truncate flex-1">{page.displayName}</span>
                                                      {(() => {
                                                        const state = pageSyncStateCache[page.id];
                                                        if (!state || state === 'idle') return null;
                                                        const dotClass = getSyncDotClassName(state);
                                                        if (!dotClass) return null;
                                                        const isRetryable = state === 'error' || state === 'rate_limited';
                                                        return (
                                                          <span
                                                            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClass} ${isRetryable ? 'cursor-pointer hover:scale-150 transition-transform' : ''}`}
                                                            title={getSyncDotTitle(state)}
                                                            onClick={isRetryable ? (e) => { e.stopPropagation(); handlePageClick(page.id, cleanNotebookDisplayName(page.displayName), nb.id, sName, page.lastModified); } : undefined}
                                                          />
                                                        );
                                                      })()}
                                                    </button>
                                                    );
                                                  })
                                                )}
                                              </div>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Content Viewer */}
                  <div className="flex-1 bg-slate-100 overflow-hidden flex flex-col relative">
                    <div className="flex items-center justify-between p-3 border-b border-slate-200 bg-white shadow-sm z-10">
                      <div className="flex items-center gap-3">
                        {!showTreeMenu && (
                          <button onClick={() => setShowTreeMenu(true)} className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-indigo-600 transition-colors">
                            <Menu size={18}/>
                          </button>
                        )}
                        {selectedPageTitle && (
                          <>
                            <h2 className="text-sm font-black text-slate-800 truncate">{selectedPageTitle}</h2>
                            {(pageWorkflowSummary || pageSnapshotMeta) && (
                              <span
                                className={`hidden md:inline-flex items-center px-1.5 py-0.5 rounded-full border text-[9px] font-black uppercase tracking-widest ${
                                  pageWorkflowSummary && !pageSnapshotMeta?.stale
                                    ? getWorkflowSummaryClassName(pageWorkflowSummary)
                                    : getSnapshotBadgeClassName(pageSnapshotMeta!)
                                }`}
                                title={
                                  pageWorkflowSummary && !pageSnapshotMeta?.stale
                                    ? getWorkflowSummaryTooltip(pageWorkflowSummary)
                                    : getSnapshotBadgeTooltip(pageSnapshotMeta!)
                                }
                              >
                                {pageWorkflowSummary && !pageSnapshotMeta?.stale
                                  ? getWorkflowSummaryLabel(pageWorkflowSummary)
                                  : getSnapshotBadgeLabel(pageSnapshotMeta!)}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                      
                      <div className="flex items-center gap-2">
                        <button
                          onClick={account ? handleLogout : handleLogin}
                          disabled={isInteracting || isCheckingAuth}
                          aria-label={
                            account
                              ? `Microsoft connected as ${account.username}. Click to disconnect.`
                              : isCheckingAuth
                                ? 'Checking Microsoft session.'
                                : 'Microsoft disconnected. Click to connect.'
                          }
                          className={`p-1.5 rounded-full border transition-colors ${
                            account
                              ? 'bg-indigo-50 text-indigo-600 border-indigo-100 hover:bg-indigo-100'
                              : 'bg-white text-slate-400 border-slate-200 hover:border-indigo-200 hover:text-indigo-600'
                          }`}
                          title={
                            account
                              ? `Microsoft connected as ${account.username}. Click to disconnect.`
                              : isCheckingAuth
                                ? 'Checking Microsoft session.'
                                : isInteracting
                                  ? 'Microsoft sign-in is in progress.'
                                  : 'Microsoft disconnected. Click to connect.'
                          }
                        >
                          {isInteracting || isCheckingAuth
                            ? <RefreshCw size={14} className="animate-spin"/>
                            : account ? <ShieldCheck size={14}/> : <WifiOff size={14}/>}
                        </button>
                        <button
                          onClick={firebaseUser ? handleFirebaseLogout : handleFirebaseLogin}
                          aria-label={
                            firebaseUser
                              ? `Saved records connected to ${firebaseProjectInfo.projectId}. Click to disconnect.`
                              : dbStatus === 'connecting'
                                ? 'Checking saved records connection.'
                                : 'Saved records disconnected. Click to connect.'
                          }
                          className={`p-1.5 rounded-full border transition-colors ${
                            firebaseUser
                              ? 'bg-emerald-50 text-emerald-600 border-emerald-100 hover:bg-emerald-100'
                              : dbStatus === 'connecting'
                                ? 'bg-amber-50 text-amber-500 border-amber-100'
                                : 'bg-white text-slate-400 border-slate-200 hover:border-emerald-200 hover:text-emerald-600'
                          }`}
                          title={firebaseUser
                            ? `Saved records connected to ${firebaseProjectInfo.projectId}. Click to disconnect.`
                            : dbStatus === 'connecting' ? 'Checking saved records connection. Click to connect if needed.'
                            : 'Saved records disconnected. Click to connect.'}
                        >
                          <Database size={14}/>
                        </button>
                        {!showAIPanel && selectedPageContent && (
                          <button
                            onClick={() => { setShowAIPanel(true); setShowTreeMenu(false); setSidebarCollapsedPersisted(true); }}
                            className="flex items-center gap-2 bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-slate-200 transition-colors"
                            title="Open Feedback Context"
                          >
                            <ChevronRight size={18} strokeWidth={2.5} className="rotate-180" />
                            Context
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex-1 overflow-hidden flex items-stretch bg-white">
                      {loadingPage ? (
                        <div className="h-full w-full flex flex-col items-center justify-center gap-4">
                          <RefreshCw className="animate-spin text-indigo-500" size={32}/>
                          <p className="text-slate-500 font-medium animate-pulse">{loadingMessage || 'Loading page content...'}</p>
                        </div>
                      ) : selectedPageContent ? (
                        <div className="bg-white w-full h-full min-h-0 overflow-hidden relative flex flex-col">
                          
                          {/* Document Toolbar */}
                          <div className="shrink-0 w-full bg-white/95 backdrop-blur border-b border-slate-200 z-10 flex items-center px-4 py-2 gap-2">
                            {/* Left: Workflow actions */}
                            <div className="flex items-center gap-1 flex-1">
                              {parsedPageContent ? (
                                <>
                                  <button
                                    onClick={handleMarkAllReady}
                                    disabled={isMarkingAllReady || markAllReadySuccess}
                                    className={`px-2 py-1.5 text-xs font-bold rounded-md transition-colors flex items-center gap-1 ${markAllReadySuccess ? 'bg-emerald-500 text-white' : 'text-emerald-600 hover:bg-emerald-50'}`}
                                    title="Save entries with student diary text and mark their feedback ready"
                                  >
                                    {isMarkingAllReady ? <RefreshCw size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                                    {isMarkingAllReady ? 'Marking...' : markAllReadySuccess ? 'Ready!' : 'Mark All Ready'}
                                  </button>
                                  <button
                                    onClick={handleNextNotReady}
                                    className="px-2 py-1.5 text-xs font-bold rounded-md transition-colors flex items-center gap-1 text-indigo-600 hover:bg-indigo-50"
                                    title="Jump to the next entry that is not feedback ready, or the next student"
                                  >
                                    Next Entry <ChevronRight size={13}/>
                                  </button>
                                </>
                              ) : (
                                <>
                                  {lastParseFailureMode === 'label-first' && !lastParseUsedAI && activePageId && selectedPageTitle && activeClassId && (
                                    <button
                                      onClick={() => reopenActivePage(true)}
                                      className="px-2 py-1.5 text-xs font-bold rounded-md transition-colors flex items-center gap-1 bg-indigo-100 text-indigo-700 hover:bg-indigo-200"
                                      title="Use AI parsing for this page only"
                                    >
                                      <BrainCircuit size={13}/>
                                      Use AI for This Page
                                    </button>
                                  )}
                                  <button
                                    onClick={goToNextPage}
                                    className="px-2 py-1.5 text-xs font-bold rounded-md transition-colors flex items-center gap-1 text-slate-500 hover:bg-slate-100"
                                    title="Skip to next student"
                                  >
                                    Skip <ChevronRight size={13}/>
                                  </button>
                                </>
                              )}
                            </div>
                            {/* Entry position indicator — shown when multiple entries exist in parsed view */}
                            {parsedPageContent && parsedPageContent.length > 1 && activeWorkflowEntry && viewMode === 'parsed' && (
                              <>
                                <div className="w-px h-4 bg-slate-200 mx-1 shrink-0" />
                                <EntryPositionIndicator
                                  currentIndex={activeWorkflowEntry.index}
                                  totalEntries={parsedPageContent.length}
                                  entry={activeWorkflowEntry.entry}
                                  workflowUiState={activeWorkflowEntry.workflowUiState}
                                />
                              </>
                            )}
                            {/* Center: View toggle */}
                            <div className="flex items-center">
                              {(parsedPageContent || lastParseFailureMode) && (
                                <button
                                  onClick={() => setViewMode(viewMode === 'parsed' ? 'raw' : 'parsed')}
                                  className={`px-2 py-1.5 text-xs font-bold rounded-md transition-colors flex items-center gap-1 ${viewMode === 'parsed' ? 'bg-indigo-100 text-indigo-700' : 'text-slate-500 hover:bg-slate-100'}`}
                                  title="Toggle View Mode"
                                >
                                  <Code size={13}/>
                                  {viewMode === 'parsed' ? 'View Original' : parsedPageContent ? 'View Parsed' : 'View Recovery'}
                                </button>
                              )}
                            </div>
                            {/* Right: Display controls */}
                            <div className="flex items-center gap-1 flex-1 justify-end">
                              <button onClick={() => setZoomLevel(z => Math.max(25, z - 10))} className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors" title="Zoom Out">
                                <ZoomOut size={13}/>
                              </button>
                              <span className="text-[10px] font-bold text-slate-500 w-8 text-center">{zoomLevel}%</span>
                              <button onClick={() => setZoomLevel(z => Math.min(200, z + 10))} className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors" title="Zoom In">
                                <ZoomIn size={13}/>
                              </button>
                              <div className="w-px h-4 bg-slate-200 mx-0.5"></div>
                              <button
                                onClick={() => { if (activePageId && selectedPageTitle && activeClassId) reopenActivePage(true); }}
                                disabled={!activePageId || !selectedPageTitle || !activeClassId}
                                className={`p-1.5 rounded-md transition-colors ${activePageId && selectedPageTitle && activeClassId ? 'text-indigo-500 hover:text-indigo-700 hover:bg-indigo-50' : 'text-slate-300 cursor-default'}`}
                                title="Re-parse with AI"
                              >
                                <Sparkles size={13}/>
                              </button>
                              {activeClassId && getClassParserConfig(activeClassId).parserMode === 'label-first' && (
                                <button
                                  onClick={forceReparseActivePage}
                                  disabled={!activePageId || !selectedPageTitle || !activeClassId}
                                  className={`p-1.5 rounded-md transition-colors ${activePageId && selectedPageTitle && activeClassId ? 'text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50' : 'text-slate-300 cursor-default'}`}
                                  title="Force re-parse (label-first) — bypasses cache and Firestore snapshot"
                                >
                                  <RefreshCw size={13}/>
                                </button>
                              )}
                              <div className="w-px h-4 bg-slate-200 mx-0.5"></div>
                              <button
                                onClick={() => setShowTreeMenu(prev => !prev)}
                                className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors"
                                title={showTreeMenu ? 'Expand content area' : 'Restore notebook tree'}
                              >
                                {showTreeMenu ? <Maximize2 size={13}/> : <Minimize2 size={13}/>}
                              </button>
                            </div>
                          </div>

                          <div
                            ref={contentScrollRef}
                            onScroll={handleParsedContentScroll}
                            className="p-8 pt-4 overflow-auto flex-1 relative min-h-0"
                          >
                            {viewMode === 'parsed' && parsedPageContent ? (
                              <div className="space-y-12" style={{ transform: `scale(${zoomLevel / 100})`, transformOrigin: 'top left' }}>
                                  {pageSnapshotMeta?.message && (
                                    <div className={`rounded-2xl border px-5 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3 ${
                                      pageSnapshotMeta.stale
                                        ? 'bg-amber-50 border-amber-200'
                                        : 'bg-slate-50 border-slate-200'
                                    }`}>
                                      <div>
                                        <p className={`text-[10px] font-black uppercase tracking-[0.18em] mb-1 ${
                                          pageSnapshotMeta.stale ? 'text-amber-600' : 'text-slate-500'
                                        }`}>
                                          {pageSnapshotMeta.stale ? 'Saved Review Shown' : 'Saved Snapshot'}
                                        </p>
                                        <p className={`text-sm font-medium leading-relaxed ${
                                          pageSnapshotMeta.stale ? 'text-amber-900' : 'text-slate-700'
                                        }`}>
                                          {pageSnapshotMeta.message}
                                        </p>
                                      </div>
                                      {pageSnapshotMeta.stale && activePageId && selectedPageTitle && activeClassId && (
                                        <button
                                          onClick={() => reopenActivePage(true)}
                                          className="shrink-0 px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:bg-indigo-700 transition-colors"
                                        >
                                          Use AI for This Page
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {parsedPageContent.map((entry, entryIndex) => {
                                    if (!entry) return null;
                                    const entryKey = entry.id || String(entryIndex);
                                    const workflowStatus = entryStatus[entryKey];
                                    const currentFeedback = teacherFeedback[entryKey];
                                    const savedFeedback = savedTeacherFeedback[entryKey];
                                    const workflowUiState = getEntryWorkflowUiState(
                                      workflowStatus,
                                      currentFeedback,
                                      savedFeedback
                                    );
                                    return (
                                    <React.Fragment key={entryKey}>
                                    <div
                                      id={`entry-${entryIndex}`}
                                      onClick={() => setActiveFeedbackEntryIndex(entryIndex)}
                                      onFocusCapture={() => setActiveFeedbackEntryIndex(entryIndex)}
                                      className="relative pb-12 border-b-4 border-slate-100 last:border-0 scroll-mt-4"
                                    >
                                    <div className="absolute -left-4 top-0 bottom-0 w-1 bg-indigo-100 rounded-full"></div>
                                    {/* Entry header */}
                                    <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3 mb-4">
                                      <h3 className="text-xl font-black text-slate-800 flex items-center gap-3 min-w-0">
                                        <Calendar className="text-indigo-500" size={24}/>
                                        {entry.date || entry.weekNumber ? (
                                          <>
                                            {entry.date || 'Undated'}
                                            {entry.weekNumber && <span className="text-slate-400 font-medium text-lg">| {entry.weekNumber}</span>}
                                          </>
                                        ) : (
                                          <span className="italic text-slate-500">Unlabeled Entry {entryIndex + 1}</span>
                                        )}
                                      </h3>
                                      <div className="flex items-center justify-start xl:justify-end gap-2 flex-wrap">
                                        {/* Status badge */}
                                        <WorkflowBadge state={workflowUiState} />
                                        {/* Warning badge - clickable, hidden once feedback is ready */}
                                        {entry.parseWarnings && entry.parseWarnings.length > 0 && workflowUiState !== 'ready' && (
                                          <button
                                            onClick={() => setOpenWarningPanel(prev => prev === entryKey ? null : entryKey)}
                                            className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors flex items-center gap-1"
                                            title="Click to see parse warnings"
                                          >
                                            <AlertTriangle size={11}/>
                                            {entry.parseWarnings.length} {entry.parseWarnings.length === 1 ? 'warning' : 'warnings'}
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                    {/* Warning panel */}
                                    {openWarningPanel === entryKey && entry.parseWarnings && entry.parseWarnings.length > 0 && (
                                      <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="flex-1">
                                            <p className="text-xs font-bold uppercase tracking-wider text-amber-700 mb-2 flex items-center gap-1.5">
                                              <AlertTriangle size={12}/> Parse Warnings
                                            </p>
                                            <ul className="space-y-1">
                                              {entry.parseWarnings.map((w, i) => (
                                                <li key={i} className="text-sm text-amber-900">- {w}</li>
                                              ))}
                                            </ul>
                                          </div>
                                          <button
                                            onClick={() => { if (activePageId && selectedPageTitle && activeClassId) reopenActivePage(true); }}
                                            disabled={!activePageId || !selectedPageTitle || !activeClassId}
                                            className="shrink-0 px-3 py-1.5 bg-indigo-600 text-white text-xs font-bold rounded-lg hover:bg-indigo-700 transition-colors flex items-center gap-1 disabled:opacity-50"
                                            title="Re-parse this page with AI"
                                          >
                                            <Sparkles size={12}/> Re-parse with AI
                                          </button>
                                        </div>
                                      </div>
                                    )}
                                    
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
                                      <div className="md:col-span-3 bg-white rounded-xl p-4 border border-slate-200 flex flex-col gap-3">
                                        <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider">Entry Details</h4>
                                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                                          <div>
                                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Date</p>
                                            <p className="text-sm font-semibold text-slate-700">{entry.date || 'N/A'}</p>
                                          </div>
                                          <div>
                                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Weather</p>
                                            <p className="text-sm font-semibold text-slate-700">{entry.weather || 'N/A'}</p>
                                          </div>
                                          <div>
                                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Week</p>
                                            <p className="text-sm font-semibold text-slate-700">{entry.weekNumber || 'N/A'}</p>
                                          </div>
                                          <div>
                                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Photos</p>
                                            <p className="text-sm font-semibold text-slate-700">{entry.photoCount || 0} detected</p>
                                          </div>
                                        </div>
                                      </div>
                                      <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 flex flex-col md:col-span-2">
                                        <div className="flex items-center justify-between mb-2">
                                          <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider">Diary Text</h4>
                                        </div>
                                        <div className="max-h-80 overflow-y-auto pr-2">
                                          <p className="text-slate-800 text-sm leading-relaxed whitespace-pre-wrap">{entry.diaryText || 'No text provided.'}</p>
                                        </div>
                                        <div className="mt-4 pt-4 border-t border-slate-200">
                                          <div className="flex items-center justify-between mb-1">
                                            <span className="text-[10px] font-bold text-slate-400 uppercase">Teacher Feedback</span>
                                            <button 
                                              onClick={() => handleDraftFeedback(entry.id || String(entryIndex), 'diaryText', entry.diaryText)}
                                              disabled={isDrafting[`${entry.id || String(entryIndex)}-diaryText`]}
                                              className="text-indigo-500 hover:text-indigo-700 flex items-center gap-1 text-[10px] font-bold bg-indigo-50 px-2 py-1 rounded-md transition-colors disabled:opacity-50"
                                            >
                                              {isDrafting[`${entry.id || String(entryIndex)}-diaryText`] ? <RefreshCw size={10} className="animate-spin"/> : <Wand2 size={10}/>}
                                              AI Draft
                                            </button>
                                          </div>
                                          <textarea 
                                            value={currentFeedback?.diaryText || ''}
                                            onChange={(e) => updateTeacherFeedbackField(entryKey, 'diaryText', e.target.value)}
                                            placeholder="Teacher feedback on diary text..." 
                                            className="w-full text-sm bg-transparent focus:outline-none focus:border-indigo-400 resize-none" rows={4}
                                          />
                                        </div>
                                      </div>
                                      <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 flex flex-col">
                                        <div className="flex items-center justify-between mb-2">
                                          <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider">Peer Feedback</h4>
                                        </div>
                                        {(entry.peerFeedback || []).length > 0 ? (
                                          <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                                            {(entry.peerFeedback || []).map((pf, i) => (
                                              <div key={i} className="bg-white p-3 rounded-lg border border-slate-100 shadow-sm">
                                                <span className="text-xs font-bold text-indigo-600 block mb-1">{pf.contributor}</span>
                                                <p className="text-sm text-slate-700">{pf.feedback}</p>
                                              </div>
                                            ))}
                                          </div>
                                        ) : (
                                          <p className="text-sm text-slate-500 italic">No peer feedback recorded.</p>
                                        )}
                                        <div className="mt-4 pt-4 border-t border-slate-200">
                                          <div className="flex items-center justify-between mb-1">
                                            <span className="text-[10px] font-bold text-slate-400 uppercase">Teacher Feedback</span>
                                            <button 
                                              onClick={() => handleDraftFeedback(entry.id || String(entryIndex), 'peerFeedback', entry.peerFeedback)}
                                              disabled={isDrafting[`${entry.id || String(entryIndex)}-peerFeedback`]}
                                              className="text-indigo-500 hover:text-indigo-700 flex items-center gap-1 text-[10px] font-bold bg-indigo-50 px-2 py-1 rounded-md transition-colors disabled:opacity-50"
                                            >
                                              {isDrafting[`${entry.id || String(entryIndex)}-peerFeedback`] ? <RefreshCw size={10} className="animate-spin"/> : <Wand2 size={10}/>}
                                              AI Draft
                                            </button>
                                          </div>
                                          <textarea 
                                            value={currentFeedback?.peerFeedback || ''}
                                            onChange={(e) => updateTeacherFeedbackField(entryKey, 'peerFeedback', e.target.value)}
                                            placeholder="Teacher feedback on peer comments..." 
                                            className="w-full text-sm bg-transparent focus:outline-none focus:border-indigo-400 resize-none" rows={2}
                                          />
                                        </div>
                                      </div>

                                      {/* Row 3 */}
                                      <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 flex flex-col">
                                        <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider mb-2">Vocabulary ({entry.vocabCount})</h4>
                                        <ul className="list-disc list-inside text-sm text-slate-700 space-y-1 max-h-48 overflow-y-auto pr-1">
                                          {(entry.vocabItems || []).map((v, i) => (
                                            <li key={i}>{v.wordOrPhrase}</li>
                                          ))}
                                        </ul>
                                        <div className="mt-4 pt-4 border-t border-slate-200">
                                          <div className="flex items-center justify-between mb-1">
                                            <span className="text-[10px] font-bold text-slate-400 uppercase">Teacher Feedback</span>
                                            <button
                                              onClick={() => handleDraftFeedback(entry.id || String(entryIndex), 'vocab', entry.vocabItems)}
                                              disabled={isDrafting[`${entry.id || String(entryIndex)}-vocab`]}
                                              className="text-indigo-500 hover:text-indigo-700 flex items-center gap-1 text-[10px] font-bold bg-indigo-50 px-2 py-1 rounded-md transition-colors disabled:opacity-50"
                                            >
                                              {isDrafting[`${entry.id || String(entryIndex)}-vocab`] ? <RefreshCw size={10} className="animate-spin"/> : <Wand2 size={10}/>}
                                              AI Draft
                                            </button>
                                          </div>
                                          <textarea
                                            value={currentFeedback?.vocab || ''}
                                            onChange={(e) => updateTeacherFeedbackField(entryKey, 'vocab', e.target.value)}
                                            placeholder="Teacher feedback on vocabulary..."
                                            className="w-full text-sm bg-transparent focus:outline-none focus:border-indigo-400 resize-none" rows={2}
                                          />
                                        </div>
                                      </div>
                                      <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 flex flex-col">
                                        <div className="flex items-center justify-between mb-2">
                                          <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider">Definitions & Examples ({entry.translationCount})</h4>
                                        </div>
                                        <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
                                          {(entry.translations || []).map((t, i) => (
                                            <div key={i} className="text-sm border-l-2 border-indigo-200 pl-2">
                                              <p className="font-bold text-slate-800">{t.japanese}</p>
                                              <p className="text-slate-600 italic">{t.englishDefinition}</p>
                                              <p className="text-slate-500 text-xs mt-1">"{t.englishExample}"</p>
                                            </div>
                                          ))}
                                        </div>
                                        <div className="mt-4 pt-4 border-t border-slate-200">
                                          <div className="flex items-center justify-between mb-1">
                                            <span className="text-[10px] font-bold text-slate-400 uppercase">Teacher Feedback</span>
                                            <button 
                                              onClick={() => handleDraftFeedback(entry.id || String(entryIndex), 'translations', entry.translations)}
                                              disabled={isDrafting[`${entry.id || String(entryIndex)}-translations`]}
                                              className="text-indigo-500 hover:text-indigo-700 flex items-center gap-1 text-[10px] font-bold bg-indigo-50 px-2 py-1 rounded-md transition-colors disabled:opacity-50"
                                            >
                                              {isDrafting[`${entry.id || String(entryIndex)}-translations`] ? <RefreshCw size={10} className="animate-spin"/> : <Wand2 size={10}/>}
                                              AI Draft
                                            </button>
                                          </div>
                                          <textarea 
                                            value={currentFeedback?.translations || ''}
                                            onChange={(e) => updateTeacherFeedbackField(entryKey, 'translations', e.target.value)}
                                            placeholder="Teacher feedback on definitions & examples..."
                                            className="w-full text-sm bg-transparent focus:outline-none focus:border-indigo-400 resize-none" rows={2}
                                          />
                                        </div>
                                      </div>
                                      <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 flex flex-col">
                                        <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider mb-2">Chatbot Feedback</h4>
                                        <div className="flex items-center gap-2 mb-2">
                                          <span className={`px-2 py-1 rounded-md text-xs font-bold ${entry.chatbotFeedback?.present ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
                                            {entry.chatbotFeedback?.present ? 'Present' : 'Missing'}
                                          </span>
                                        </div>
                                        {entry.chatbotFeedback?.present && (
                                          <p className="text-sm text-slate-700 bg-white p-3 rounded-lg border border-slate-100 shadow-sm max-h-80 overflow-y-auto">{entry.chatbotFeedback.data}</p>
                                        )}
                                        <textarea
                                          value={currentFeedback?.chatbot || ''}
                                          onChange={(e) => updateTeacherFeedbackField(entryKey, 'chatbot', e.target.value)}
                                          placeholder="Teacher feedback on chatbot usage..."
                                          className="mt-4 pt-4 w-full text-sm bg-transparent border-t border-slate-200 focus:outline-none focus:border-indigo-400 resize-none" rows={2}
                                        />
                                      </div>
                                      <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 flex flex-col md:col-span-3">
                                        <h4 className="text-xs font-black text-slate-400 uppercase tracking-wider mb-2">General Feedback</h4>
                                        <p className="text-xs text-slate-500 mb-3">
                                          Use this for overall guidance, encouragement, or metadata corrections that should be expressed as one student-facing comment.
                                        </p>
                                        <div className="flex items-center justify-between mb-1">
                                          <span className="text-[10px] font-bold text-slate-400 uppercase">Teacher Feedback</span>
                                          <button
                                            onClick={() => {
                                              const ctx = [
                                                entry.diaryText,
                                                entry.vocabItems?.length ? `Vocabulary: ${entry.vocabItems.map(v => v.wordOrPhrase).join(', ')}` : null,
                                                entry.peerFeedback?.length ? `Peer feedback: ${entry.peerFeedback.length} comment(s)` : null,
                                                entry.translationCount ? `Translations: ${entry.translationCount}` : null,
                                                entry.date ? `Date: ${entry.date}` : entry.weekNumber ? `Week: ${entry.weekNumber}` : null,
                                              ].filter(Boolean).join('\n');
                                              handleDraftFeedback(entry.id || String(entryIndex), 'overall', ctx);
                                            }}
                                            disabled={isDrafting[`${entry.id || String(entryIndex)}-overall`]}
                                            className="text-indigo-500 hover:text-indigo-700 flex items-center gap-1 text-[10px] font-bold bg-indigo-50 px-2 py-1 rounded-md transition-colors disabled:opacity-50"
                                          >
                                            {isDrafting[`${entry.id || String(entryIndex)}-overall`] ? <RefreshCw size={10} className="animate-spin"/> : <Wand2 size={10}/>}
                                            AI Draft
                                          </button>
                                        </div>
                                        <textarea
                                          value={currentFeedback?.overall || ''}
                                          onChange={(e) => updateTeacherFeedbackField(entryKey, 'overall', e.target.value)}
                                          placeholder="General feedback for this entry..."
                                          className="w-full text-sm bg-transparent border-t border-slate-200 pt-4 focus:outline-none focus:border-indigo-400 resize-none" rows={3}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                  {entry.rawText && entry.rawText.trim().length > 0 && (
                                    <details className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3 mt-4">
                                      <summary className="text-xs font-bold uppercase tracking-wider text-amber-700 cursor-pointer select-none">
                                        Unclassified content - review before marking ready
                                      </summary>
                                      <p className="mt-3 text-sm text-slate-700 whitespace-pre-wrap bg-white p-3 rounded-lg border border-amber-100">
                                        {entry.rawText}
                                      </p>
                                    </details>
                                  )}
                                    </React.Fragment>
                                  );
                                  })}
                              </div>
                            ) : viewMode === 'parsed' && lastParseFailureMode ? (
                              <div className="max-w-3xl mx-auto w-full space-y-6">
                                {pageSnapshotMeta?.message && (
                                  <div className={`rounded-2xl border px-5 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3 ${
                                    pageSnapshotMeta.stale
                                      ? 'bg-amber-50 border-amber-200'
                                      : 'bg-slate-50 border-slate-200'
                                  }`}>
                                    <div>
                                      <p className={`text-[10px] font-black uppercase tracking-[0.18em] mb-1 ${
                                        pageSnapshotMeta.stale ? 'text-amber-600' : 'text-slate-500'
                                      }`}>
                                        {pageSnapshotMeta.stale ? 'Saved Review Shown' : 'Saved Snapshot'}
                                      </p>
                                      <p className={`text-sm font-medium leading-relaxed ${
                                        pageSnapshotMeta.stale ? 'text-amber-900' : 'text-slate-700'
                                      }`}>
                                        {pageSnapshotMeta.message}
                                      </p>
                                    </div>
                                    {pageSnapshotMeta.stale && (
                                      <button
                                        onClick={() => reopenActivePage(true)}
                                        className="shrink-0 px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:bg-indigo-700 transition-colors"
                                      >
                                        Use AI for This Page
                                      </button>
                                    )}
                                  </div>
                                )}
                                <div className="p-8 md:p-10 bg-indigo-50 rounded-[32px] border border-indigo-100 flex flex-col items-center gap-6 text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                                  <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-indigo-600 shadow-sm border border-indigo-100">
                                    <Sparkles size={32} />
                                  </div>
                                  <div className="space-y-2">
                                    <h3 className="text-2xl font-black text-slate-800">
                                      {lastParseFailureMode === 'label-first' && !lastParseUsedAI
                                        ? 'Label Parser Not Ready'
                                        : 'Structured View Not Ready'}
                                    </h3>
                                    <p className="text-sm text-slate-500 font-medium leading-relaxed max-w-2xl">
                                      {lastParseFailureMode === 'label-first' && !lastParseUsedAI
                                        ? 'This page appears to use a legacy, unlabeled, or damaged diary format, so the label-first parser could not safely extract a structured entry. You can switch to the original OneNote page, fix the labels, or use AI for this page only.'
                                        : "We couldn't safely turn this page into a structured journal entry yet. You can try AI parsing again, or switch to the original OneNote page while keeping the recovery controls visible here."}
                                    </p>
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 w-full">
                                    <button 
                                      onClick={() => reopenActivePage(lastParseFailureMode === 'label-first')}
                                      className="w-full py-3 bg-indigo-600 text-white text-xs font-bold rounded-2xl hover:bg-indigo-700 transition-all shadow-md active:scale-95"
                                    >
                                      {lastParseFailureMode === 'label-first' && !lastParseUsedAI
                                        ? 'Use AI for This Page'
                                        : 'Try AI Parsing Again'}
                                    </button>
                                    <button 
                                      onClick={() => setViewMode('raw')}
                                      className="w-full py-3 bg-white text-slate-600 text-xs font-bold rounded-2xl hover:bg-slate-50 transition-all border border-slate-200"
                                    >
                                      View Original Page
                                    </button>
                                    <button 
                                      onClick={goToNextPage}
                                      className="w-full py-3 bg-white text-slate-600 text-xs font-bold rounded-2xl hover:bg-slate-50 transition-all border border-slate-200"
                                    >
                                      Skip to Next Student
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ) : (
                               <div className="flex flex-col items-center w-full gap-6">
                                 {pageSnapshotMeta?.message && (
                                   <div className={`w-full rounded-2xl border px-5 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3 ${
                                     pageSnapshotMeta.stale
                                       ? 'bg-amber-50 border-amber-200'
                                       : 'bg-slate-50 border-slate-200'
                                   }`}>
                                     <div>
                                       <p className={`text-[10px] font-black uppercase tracking-[0.18em] mb-1 ${
                                         pageSnapshotMeta.stale ? 'text-amber-600' : 'text-slate-500'
                                       }`}>
                                         {pageSnapshotMeta.stale ? 'Saved Review Shown' : 'Saved Snapshot'}
                                       </p>
                                       <p className={`text-sm font-medium leading-relaxed ${
                                         pageSnapshotMeta.stale ? 'text-amber-900' : 'text-slate-700'
                                       }`}>
                                         {pageSnapshotMeta.message}
                                       </p>
                                     </div>
                                     {pageSnapshotMeta.stale && (
                                       <button
                                         onClick={() => reopenActivePage(true)}
                                         className="shrink-0 px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-xl hover:bg-indigo-700 transition-colors"
                                       >
                                         Use AI for This Page
                                       </button>
                                     )}
                                   </div>
                                 )}
                                 <iframe
                                   ref={rawIframeRef}
                                   key={`${activePageId}-${zoomLevel}`}
                                   title={selectedPageTitle || 'Original OneNote page'}
                                   sandbox="allow-same-origin"
                                   srcDoc={buildRawIframeDocument(selectedPageContent, zoomLevel)}
                                   onLoad={() => {
                                     updateRawIframeHeight();
                                     window.setTimeout(updateRawIframeHeight, 150);
                                     window.setTimeout(updateRawIframeHeight, 600);
                                   }}
                                   className="w-full bg-white rounded-xl shadow-sm border border-slate-100"
                                   style={{ minHeight: rawIframeHeight, height: rawIframeHeight }}
                                 />
                                 
                                 {!parsedPageContent && !loadingPage && !lastParseFailureMode && (
                                   <div className="mt-12 p-8 bg-indigo-50 rounded-[32px] border border-indigo-100 flex flex-col items-center gap-4 max-w-md text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
                                     <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-indigo-600 shadow-sm border border-indigo-100">
                                       <Sparkles size={32} />
                                     </div>
                                     <div>
                                       <h3 className="text-lg font-black text-slate-800 mb-2">
                                         {lastParseFailureMode === 'label-first' && !lastParseUsedAI
                                           ? 'Label Parser Not Ready'
                                           : 'AI View Not Ready'}
                                       </h3>
                                       <p className="text-xs text-slate-500 font-medium leading-relaxed">
                                         {lastParseFailureMode === 'label-first' && !lastParseUsedAI
                                           ? 'This page appears to use a legacy, unlabeled, or damaged diary format, so the label-first parser could not safely extract a structured entry. You can keep the raw view, fix the labels in OneNote, or use AI for this page only.'
                                           : "We couldn't automatically parse this page into a structured journal entry. This usually happens due to AI rate limits or complex page layouts."}
                                       </p>
                                     </div>
                                     <div className="flex flex-col w-full gap-2">
                                       <button 
                                         onClick={() => reopenActivePage(lastParseFailureMode === 'label-first')}
                                         className="w-full py-3 bg-indigo-600 text-white text-xs font-bold rounded-2xl hover:bg-indigo-700 transition-all shadow-md active:scale-95"
                                       >
                                         {lastParseFailureMode === 'label-first' && !lastParseUsedAI
                                           ? 'Use AI for This Page'
                                           : 'Try AI Parsing Again'}
                                       </button>
                                       <button 
                                         onClick={goToNextPage}
                                         className="w-full py-3 bg-white text-slate-600 text-xs font-bold rounded-2xl hover:bg-slate-50 transition-all border border-slate-200"
                                       >
                                         Skip to Next Student
                                       </button>
                                     </div>
                                   </div>
                                 )}
                               </div>
                             )}
                          </div>
                          {viewMode === 'parsed' && activeWorkflowEntry && (
                            <div className="shrink-0 border-t border-slate-200 bg-white/95 backdrop-blur px-4 py-3 flex items-center justify-between gap-4">
                              <div className="min-w-0 flex items-center gap-2 overflow-hidden">
                                <span className="shrink-0 text-[10px] font-black uppercase tracking-widest text-slate-400">
                                  Next Action
                                </span>
                                <span className={`min-w-0 truncate text-sm font-medium ${
                                  activeWorkflowEntry.workflowUiState === 'unsaved'
                                    ? 'text-amber-700'
                                    : activeWorkflowEntry.workflowUiState === 'ready'
                                    ? 'text-emerald-700'
                                    : 'text-slate-600'
                                }`}>
                                  {activeWorkflowEntry.workflowUiState === 'unsaved'
                                    ? 'Unsaved changes — save before navigating away.'
                                    : activeWorkflowEntry.workflowUiState === 'ready'
                                    ? 'Ready to send — use Review & Send.'
                                    : 'Compose feedback, then Save & Mark Ready.'}
                                </span>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                <button
                                  onClick={() => handleSaveDraft(activeWorkflowEntry.entry, activeWorkflowEntry.index)}
                                  className="px-3 py-1.5 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors flex items-center gap-1 rounded-lg"
                                  title="Save current feedback as a draft"
                                >
                                  <FileText size={13}/> Save Draft
                                </button>
                                <button
                                  onClick={() => handleSaveAndMarkReady(activeWorkflowEntry.entry, activeWorkflowEntry.index)}
                                  className="px-3 py-1.5 text-xs font-bold text-white bg-emerald-500 hover:bg-emerald-600 transition-colors flex items-center gap-1 rounded-lg shadow-sm"
                                  title="Save current feedback and mark this entry ready to send"
                                >
                                  <CheckCircle size={13}/> Save & Mark Ready
                                </button>
                                <button
                                  onClick={() => handleReviewAndSendEntry(activeWorkflowEntry.entry, activeWorkflowEntry.index, activeWorkflowEntry.entryKey)}
                                  className="px-3 py-1.5 text-xs font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 transition-colors flex items-center gap-1 rounded-lg"
                                  title="Review the message and choose email or Teams delivery"
                                >
                                  <Send size={13}/> Review & Send
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <NoPageSelectedState
                          isSyncingClass={isSyncingClass}
                          syncProgress={syncProgress}
                          syncingClassName={syncingClassId ? (classes.find(c => c.id === syncingClassId)?.displayName ?? null) : null}
                          hasAnySyncedClass={classes.some(c => selectedNotebookIds.has(c.id) && c.lastSynced)}
                          selectedNotebookCount={selectedNotebookIds.size}
                        />
                      )}
                    </div>
                  </div>

                  {showAIPanel && (
                    <FeedbackWorkspace
                      onClose={() => setShowAIPanel(false)}
                      entries={parsedPageContent}
                      currentEntryIndex={activeWorkflowEntry?.index}
                      pastFeedback={pastFeedbackForStudent}
                      pastFeedbackLoading={isLoadingPastFeedback}
                      ffItemCount={ffItemCount}
                      priorFeedback={priorFeedback}
                      onFfItemCountChange={setFfItemCount}
                      onPriorFeedbackChange={setPriorFeedback}
                      onMarkUptake={handleMarkUptake}
                      defaultFfItemCount={preferences.ffItemCount}
                      defaultPriorFeedback={preferences.priorFeedbackMode}
                      onSaveFfItemCountDefault={() => saveFfItemCountDefault('ffItemCount', ffItemCount)}
                      onSavePriorFeedbackDefault={() => savePriorFeedbackDefault(priorFeedback)}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
