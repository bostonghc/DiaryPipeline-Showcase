import React from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Database,
  HelpCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react';

interface NotebookHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface GuideItem {
  icon: React.ReactNode;
  title: string;
  body: string;
}

const notebookSignals: GuideItem[] = [
  {
    icon: <span className="text-base font-black text-indigo-600">*</span>,
    title: 'Recently modified',
    body: 'The page changed in OneNote since the stored sync record was last refreshed.',
  },
  {
    icon: <span className="text-[10px] font-black text-indigo-600">1234567</span>,
    title: 'Student ID match',
    body: 'A 7-digit student ID was found in the page title and can help match roster identity.',
  },
  {
    icon: <span className="text-base font-black text-indigo-600">?</span>,
    title: 'Unidentified page',
    body: 'No stable student identity was found. The page may be misnamed, non-diary, or waiting for roster resolution.',
  },
];

const syncWorkflow: GuideItem[] = [
  {
    icon: <UploadCloud size={18} />,
    title: 'Load notebooks',
    body: 'Discovers the current OneNote class structure and page list. It does not write entry records by itself.',
  },
  {
    icon: <RefreshCw size={18} />,
    title: 'Sync selected classes',
    body: 'Queues selected pages, fetches page HTML, parses entries, and saves the records used by review, export, and dashboards.',
  },
  {
    icon: <Database size={18} />,
    title: 'Saved records',
    body: 'Firestore is the working record for parsed entries, page sync state, feedback history, and dashboard evidence.',
  },
];

const processNotes: GuideItem[] = [
  {
    icon: <Search size={18} />,
    title: 'Labels-first parsing',
    body: 'Uses the expected diary template before any AI fallback. AI retry remains explicit when deterministic parsing fails.',
  },
  {
    icon: <Bot size={18} />,
    title: 'AI-first parsing',
    body: 'Uses Gemini for flexible legacy pages or unusual formatting when the class workflow calls for it.',
  },
  {
    icon: <ShieldCheck size={18} />,
    title: 'Identity confidence',
    body: 'UPN or Graph identity is most stable. Name-only and unidentified pages are treated as measurement conditions.',
  },
  {
    icon: <AlertTriangle size={18} />,
    title: 'Sync warnings',
    body: 'Errors, rate limits, or parse misses stay visible so a teacher can retry or inspect without losing saved work.',
  },
];

const GuideRow: React.FC<GuideItem> = ({ icon, title, body }) => (
  <div className="flex items-start gap-3">
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500">
      {icon}
    </div>
    <div className="min-w-0">
      <h4 className="text-sm font-black text-slate-900">{title}</h4>
      <p className="mt-1 text-xs font-semibold leading-relaxed text-slate-500">{body}</p>
    </div>
  </div>
);

export const NotebookHelpModal: React.FC<NotebookHelpModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl animate-in zoom-in-95 duration-200">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-6 py-5">
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
              <HelpCircle size={22} />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Notebook Pane</p>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">Guide to loading and syncing</h2>
              <p className="mt-2 max-w-2xl text-sm font-semibold leading-relaxed text-slate-500">
                This help is scoped to the notebook workflow: discovery, sync, parsing, and identity signals.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400 transition-colors hover:border-slate-300 hover:text-slate-700"
            title="Close"
          >
            <X size={20} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="mb-4 flex items-center gap-2">
                <CheckCircle2 size={18} className="text-indigo-600" />
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Notebook Signals</h3>
              </div>
              <div className="space-y-4">
                {notebookSignals.map((item) => (
                  <GuideRow key={item.title} {...item} />
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="mb-4 flex items-center gap-2">
                <RefreshCw size={18} className="text-indigo-600" />
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Load And Sync</h3>
              </div>
              <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-1">
                {syncWorkflow.map((item) => (
                  <GuideRow key={item.title} {...item} />
                ))}
              </div>
            </section>
          </div>

          <section className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 p-5">
            <div className="mb-4 flex items-center gap-2">
              <ShieldCheck size={18} className="text-indigo-600" />
              <h3 className="text-xs font-black uppercase tracking-widest text-slate-500">Process Conditions</h3>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {processNotes.map((item) => (
                <GuideRow key={item.title} {...item} />
              ))}
            </div>
          </section>
        </div>

        <footer className="flex justify-end border-t border-slate-200 bg-white px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-xl bg-slate-900 px-5 py-2.5 text-xs font-black uppercase tracking-widest text-white shadow-sm transition-colors hover:bg-slate-800"
          >
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
};
