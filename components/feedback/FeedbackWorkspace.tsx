import React, { useState, useMemo } from 'react';
import {
  ChevronRight,
  ChevronDown,
  MessageSquareQuote,
  History,
  Sparkles,
  SlidersHorizontal,
  Info,
  CheckCircle2,
} from 'lucide-react';
import type { FeedbackHistoryRecord, ParsedDiaryEntry, StructuredFeedback, FeedbackEntrySnapshot, FFItemCount, PriorFeedbackMode } from '../../types';
import { PeerResponseContext, priorEntriesWithPeerCount } from './PeerResponseContext';

export type { FFItemCount, PriorFeedbackMode };

interface FeedbackWorkspaceProps {
  onClose: () => void;
  entries?: ParsedDiaryEntry[] | null;
  currentEntryIndex?: number;
  pastFeedback?: FeedbackHistoryRecord[];
  pastFeedbackLoading?: boolean;
  ffItemCount: FFItemCount;
  priorFeedback: PriorFeedbackMode;
  onFfItemCountChange: (v: FFItemCount) => void;
  onPriorFeedbackChange: (v: PriorFeedbackMode) => void;
  onMarkUptake?: (feedbackId: string, observed: boolean) => Promise<void>;
  defaultFfItemCount?: FFItemCount;
  defaultPriorFeedback?: PriorFeedbackMode;
  onSaveFfItemCountDefault?: () => Promise<void>;
  onSavePriorFeedbackDefault?: () => Promise<void>;
}

export const FeedbackWorkspace: React.FC<FeedbackWorkspaceProps> = ({
  onClose,
  entries,
  currentEntryIndex,
  pastFeedback,
  pastFeedbackLoading,
  ffItemCount,
  priorFeedback,
  onFfItemCountChange,
  onPriorFeedbackChange,
  onMarkUptake,
  defaultFfItemCount,
  defaultPriorFeedback,
  onSaveFfItemCountDefault,
  onSavePriorFeedbackDefault,
}) => {
  const [sessionControlsOpen, setSessionControlsOpen] = useState(false);
  const [peerFeedbackOpen, setPeerFeedbackOpen] = useState(false);
  const [pastFeedbackOpen, setPastFeedbackOpen] = useState(true);
  const [aiSignalsOpen, setAiSignalsOpen] = useState(false);

  const priorPeerEntryCount = priorEntriesWithPeerCount(entries, currentEntryIndex);

  return (
    <div className="w-80 border-l border-slate-200 bg-white flex-shrink-0 flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-slate-100 bg-slate-50/50 flex-shrink-0">
        <h3 className="text-xs font-black text-slate-700 uppercase tracking-widest">
          Feedback Context
        </h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 p-2 rounded-md hover:bg-slate-100 transition-colors"
          title="Close panel"
        >
          <ChevronRight size={22} strokeWidth={2.5} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <FeedbackSection
          title="Session Controls"
          icon={<SlidersHorizontal size={14} />}
          open={sessionControlsOpen}
          onToggle={() => setSessionControlsOpen(!sessionControlsOpen)}
        >
          <div className="space-y-5">
            <div>
              <div className="flex items-center mb-2">
                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                  Feedback Items
                </label>
                <InfoTooltip>
                  <strong className="font-semibold">Why 2–4?</strong> Focused corrective feedback (Sheen 2007, Ferris 2011) shows 2–4 targeted items produce sustained accuracy gains in L2 writers over a semester — when paired with revision opportunity, which this weekly diary loop provides.
                  <br /><br />
                  <strong className="font-semibold">Caveat:</strong> the 2024 naturalistic synthesis (Mao, Lee & Li) finds EFL teachers in real classrooms often choose comprehensive (5+) feedback. Both are legitimate — pick what fits this entry's purpose. 5+ is appropriate for summative or exam-prep contexts.
                </InfoTooltip>
              </div>
              <SegmentedControl
                value={ffItemCount}
                options={[
                  { value: '1-2', label: '1–2' },
                  { value: '3-4', label: '3–4' },
                  { value: '5+', label: '5+' },
                ]}
                onChange={(v) => onFfItemCountChange(v as FFItemCount)}
              />
              {onSaveFfItemCountDefault && defaultFfItemCount !== undefined && ffItemCount !== defaultFfItemCount && (
                <button
                  onClick={onSaveFfItemCountDefault}
                  className="mt-1.5 text-[10px] font-bold text-indigo-500 hover:text-indigo-700 uppercase tracking-wider"
                >
                  ↑ Save as default
                </button>
              )}
              <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                Lab studies favor 2–4 focused items; classroom EFL practice often goes broader. Choose what fits this entry.
              </p>
            </div>

            <div>
              <div className="flex items-center mb-2">
                <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                  Prior Feedback
                </label>
                <InfoTooltip>
                  <strong className="font-semibold">Why use prior feedback?</strong> Continuity in feedback (Carless 2020 longitudinal partnerships) improves student uptake and engagement — students who perceive feedback as building on prior comments engage more.
                  <br /><br />
                  <strong className="font-semibold">Reference</strong> shows you the last messages and uses them as context for AI drafts so they avoid repetition. <strong className="font-semibold">Include</strong> additionally sends a brief excerpt to the student as a continuity signal. <strong className="font-semibold">Off</strong> when the entry stands alone or you want a fresh perspective.
                </InfoTooltip>
              </div>
              <SegmentedControl
                value={priorFeedback}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'reference', label: 'Reference' },
                  { value: 'include', label: 'Include' },
                ]}
                onChange={(v) => onPriorFeedbackChange(v as PriorFeedbackMode)}
              />
              {onSavePriorFeedbackDefault && defaultPriorFeedback !== undefined && priorFeedback !== defaultPriorFeedback && (
                <button
                  onClick={onSavePriorFeedbackDefault}
                  className="mt-1.5 text-[10px] font-bold text-indigo-500 hover:text-indigo-700 uppercase tracking-wider"
                >
                  ↑ Save as default
                </button>
              )}
              <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                Reference and Include both use prior context in AI drafts, helping them avoid repeating earlier points.
              </p>
            </div>
          </div>
        </FeedbackSection>

        <FeedbackSection
          title="Peer Response Context"
          icon={<MessageSquareQuote size={14} />}
          count={priorPeerEntryCount || undefined}
          open={peerFeedbackOpen}
          onToggle={() => setPeerFeedbackOpen(!peerFeedbackOpen)}
        >
          <PeerResponseContext entries={entries} currentEntryIndex={currentEntryIndex} />
        </FeedbackSection>

        <FeedbackSection
          title="Past Teacher Feedback"
          icon={<History size={14} />}
          count={pastFeedback?.length}
          open={pastFeedbackOpen}
          onToggle={() => setPastFeedbackOpen(!pastFeedbackOpen)}
        >
          <PastFeedbackList
            records={pastFeedback}
            loading={pastFeedbackLoading}
            onMarkUptake={onMarkUptake}
          />
        </FeedbackSection>

        <FeedbackSection
          title="AI Signals"
          icon={<Sparkles size={14} />}
          open={aiSignalsOpen}
          onToggle={() => setAiSignalsOpen(!aiSignalsOpen)}
        >
          <p className="text-xs text-slate-500 leading-relaxed italic">
            Pattern observations, suggested focus areas, on-demand draft assistance.
            Appears when invited.
          </p>
        </FeedbackSection>
      </div>
    </div>
  );
};

interface FeedbackSectionProps {
  title: string;
  icon?: React.ReactNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const FeedbackSection: React.FC<FeedbackSectionProps> = ({
  title,
  icon,
  count,
  open,
  onToggle,
  children,
}) => (
  <div className="border-b border-slate-100">
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors text-left"
    >
      <span className="flex items-center gap-2 text-xs font-bold text-slate-700 uppercase tracking-wider">
        {icon}
        {title}
        {typeof count === 'number' && count > 0 && (
          <span className="ml-1 px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-[10px] font-bold">
            {count}
          </span>
        )}
      </span>
      <ChevronDown
        size={18}
        strokeWidth={2.25}
        className={`text-slate-400 transition-transform flex-shrink-0 ${open ? '' : '-rotate-90'}`}
      />
    </button>
    {open && <div className="px-4 pb-4">{children}</div>}
  </div>
);

interface SegmentedControlOption {
  value: string;
  label: string;
}

interface SegmentedControlProps {
  value: string;
  options: SegmentedControlOption[];
  onChange: (value: string) => void;
}

const SegmentedControl: React.FC<SegmentedControlProps> = ({
  value,
  options,
  onChange,
}) => (
  <div className="flex bg-slate-100 rounded-lg p-0.5">
    {options.map((opt) => (
      <button
        key={opt.value}
        onClick={() => onChange(opt.value)}
        className={`flex-1 py-1.5 px-2 text-[11px] font-bold rounded-md transition-all ${
          value === opt.value
            ? 'bg-white text-indigo-600 shadow-sm'
            : 'text-slate-500 hover:text-slate-700'
        }`}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

// Hover/focus/click tooltip surfacing the research rationale behind a Session
// Control. Casual user reads the short explainer beneath the control; curious
// user clicks the icon for the depth. Anti-mid-tier-anxiety: details on demand
// rather than always-visible micro-text.
const InfoTooltip: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((prev) => !prev)}
        className="ml-1.5 text-slate-300 hover:text-slate-500 focus:text-slate-500 focus:outline-none"
        aria-label="Show research rationale"
      >
        <Info size={12} />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute z-50 top-5 left-0 w-64 bg-slate-800 text-slate-100 text-[10px] leading-relaxed font-normal normal-case tracking-normal p-3 rounded-md shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
};

interface PastFeedbackListProps {
  records?: FeedbackHistoryRecord[];
  loading?: boolean;
  onMarkUptake?: (feedbackId: string, observed: boolean) => Promise<void>;
}

const PastFeedbackList: React.FC<PastFeedbackListProps> = ({ records, loading, onMarkUptake }) => {
  if (loading) {
    return (
      <p className="text-xs text-slate-400 leading-relaxed italic">
        Loading recent feedback…
      </p>
    );
  }

  if (!records || records.length === 0) {
    return (
      <p className="text-xs text-slate-500 leading-relaxed italic">
        No feedback sent to this student yet.
      </p>
    );
  }

  const latest = records[0];
  const aiCount = records.filter(r => r.source !== 'human').length;
  const aiPct = Math.round((aiCount / records.length) * 100);

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-3 pb-3 border-b border-slate-100">
        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider px-1.5 py-0.5 bg-slate-100 rounded">
          Last: {formatSentAt(latest.sentAt)}
        </span>
        {latest.fieldsAddressed.length > 0 && (
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider px-1.5 py-0.5 bg-slate-100 rounded">
            {latest.fieldsAddressed.join(' · ')}
          </span>
        )}
        {records.length > 1 && (
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider px-1.5 py-0.5 bg-slate-100 rounded">
            AI {aiPct}%
          </span>
        )}
      </div>
      <div className="space-y-3">
        {records.map((record, idx) => (
          <PastFeedbackCard
            key={record.feedbackId}
            record={record}
            isFirst={idx === 0}
            onMarkUptake={onMarkUptake}
          />
        ))}
      </div>
    </div>
  );
};

const formatSentAt = (iso: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

// Extracts the forward-direction sentence from the Overall feedback section.
// Looks for the last sentence beginning with a forward-looking trigger phrase.
// Returns null when no such sentence exists or the text is empty.
const extractForwardDirection = (text: string): string | null => {
  if (!text) return null;
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const trigger = /^(next time|next week|for next time|going forward|try |in your next|from next)/i;
  const matches = sentences.filter(s => trigger.test(s));
  return matches.length > 0 ? matches[matches.length - 1] : null;
};

const stripHtmlToText = (htmlOrText: string): string => {
  if (!htmlOrText) return '';
  let stripped = htmlOrText.replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, '');
  stripped = stripped.replace(/<[^>]+>/g, ' ');
  stripped = stripped.replace(/\s+/g, ' ').trim();
  return stripped;
};

const CARD_HEADER: React.FC<{ record: FeedbackHistoryRecord }> = ({ record }) => (
  <>
    <div className="flex items-center justify-between mb-2">
      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
        {formatSentAt(record.sentAt)}
      </span>
      <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider px-1.5 py-0.5 bg-slate-100 rounded">
        {record.channel}
      </span>
    </div>
    {record.fieldsAddressed.length > 0 && (
      <p className="text-[10px] text-slate-400 mb-2">
        {record.fieldsAddressed.join(' · ')}
      </p>
    )}
  </>
);

// Structured card: uses persisted structuredFeedback + entrySnapshot (format v2+).
// Collapsed → first included teacher comment, truncated.
// Expanded → review notice, then each section with student quote paired above comment.
const StructuredFeedbackCard: React.FC<{
  record: FeedbackHistoryRecord;
  isFirst: boolean;
  onMarkUptake?: (feedbackId: string, observed: boolean) => Promise<void>;
}> = ({ record, isFirst, onMarkUptake }) => {
  const [expanded, setExpanded] = useState(false);
  const sf = record.structuredFeedback as StructuredFeedback;
  const snap = record.entrySnapshot as FeedbackEntrySnapshot | undefined;

  const forwardSuggestion = useMemo(() =>
    isFirst && sf.includeOverall ? extractForwardDirection(sf.overallFeedback) : null,
  [isFirst, sf.includeOverall, sf.overallFeedback]);

  const previewText = useMemo(() => {
    const first = [
      sf.includeDiary && sf.diaryFeedback,
      sf.includePeer && sf.peerFeedback,
      sf.includeVocab && sf.vocabFeedback,
      sf.includeTranslations && sf.translationsFeedback,
      sf.includeChatbot && sf.chatbotFeedback,
      sf.includeOverall && sf.overallFeedback,
    ].find(Boolean) || '';
    return first.length > 180 ? first.slice(0, 180) + '…' : first;
  }, [sf]);

  return (
    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
      {forwardSuggestion && (
        <div className="mb-2 px-2 py-1.5 bg-indigo-50 border border-indigo-200 rounded">
          <p className="text-[9px] font-bold text-indigo-500 uppercase tracking-wider mb-0.5">Last suggestion</p>
          <p className="text-[11px] text-indigo-800 leading-relaxed">{forwardSuggestion}</p>
        </div>
      )}

      <CARD_HEADER record={record} />

      {!expanded && (
        <p className="text-xs text-slate-700 leading-relaxed">{previewText}</p>
      )}

      {expanded && (
        <div className="space-y-3 mt-1">
          {sf.reviewNotice && (
            <div className="px-2 py-1.5 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-700 leading-relaxed">
              {sf.reviewNotice.split('\n')[0]}
            </div>
          )}

          {sf.includeDiary && sf.diaryFeedback && (
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Diary</p>
              {snap?.diaryText && (
                <div className="px-2 py-1.5 bg-slate-100 rounded text-[11px] italic text-slate-500 leading-relaxed mb-1">
                  &ldquo;{snap.diaryText.length > 120 ? snap.diaryText.slice(0, 120) + '…' : snap.diaryText}&rdquo;
                </div>
              )}
              <div className="px-2 py-1.5 bg-indigo-50 border-l-2 border-indigo-300 rounded-r text-[11px] text-slate-700 leading-relaxed">
                {sf.diaryFeedback}
              </div>
            </div>
          )}

          {sf.includePeer && sf.peerFeedback && (
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Peer Feedback</p>
              {snap?.peerFeedback && snap.peerFeedback.length > 0 && (
                <div className="px-2 py-1.5 bg-slate-100 rounded text-[11px] text-slate-500 leading-relaxed mb-1">
                  {snap.peerFeedback.slice(0, 3).map(p => p.contributor).join(', ')}
                  {snap.peerFeedback.length > 3 ? ' …' : ''}
                </div>
              )}
              <div className="px-2 py-1.5 bg-indigo-50 border-l-2 border-indigo-300 rounded-r text-[11px] text-slate-700 leading-relaxed">
                {sf.peerFeedback}
              </div>
            </div>
          )}

          {sf.includeVocab && sf.vocabFeedback && (
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Vocabulary</p>
              {snap?.vocabItems && snap.vocabItems.length > 0 && (
                <div className="px-2 py-1.5 bg-slate-100 rounded text-[11px] text-slate-500 leading-relaxed mb-1">
                  {snap.vocabItems.slice(0, 6).map(v => v.wordOrPhrase).join(', ')}
                  {snap.vocabItems.length > 6 ? ' …' : ''}
                </div>
              )}
              <div className="px-2 py-1.5 bg-indigo-50 border-l-2 border-indigo-300 rounded-r text-[11px] text-slate-700 leading-relaxed">
                {sf.vocabFeedback}
              </div>
            </div>
          )}

          {sf.includeTranslations && sf.translationsFeedback && (
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Translations</p>
              {snap?.translations && snap.translations.length > 0 && (
                <div className="px-2 py-1.5 bg-slate-100 rounded text-[11px] text-slate-500 leading-relaxed mb-1">
                  {snap.translations.slice(0, 4).map(t => t.japanese).join('、')}
                  {snap.translations.length > 4 ? ' …' : ''}
                </div>
              )}
              <div className="px-2 py-1.5 bg-indigo-50 border-l-2 border-indigo-300 rounded-r text-[11px] text-slate-700 leading-relaxed">
                {sf.translationsFeedback}
              </div>
            </div>
          )}

          {sf.includeChatbot && sf.chatbotFeedback && (
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Chatbot Exchange</p>
              {snap?.chatbotFeedback?.data && (
                <div className="px-2 py-1.5 bg-slate-100 rounded text-[11px] italic text-slate-500 leading-relaxed mb-1">
                  &ldquo;{snap.chatbotFeedback.data.length > 120 ? snap.chatbotFeedback.data.slice(0, 120) + '…' : snap.chatbotFeedback.data}&rdquo;
                </div>
              )}
              <div className="px-2 py-1.5 bg-indigo-50 border-l-2 border-indigo-300 rounded-r text-[11px] text-slate-700 leading-relaxed">
                {sf.chatbotFeedback}
              </div>
            </div>
          )}

          {sf.includeOverall && sf.overallFeedback && (
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Overall</p>
              <div className="px-2 py-1.5 bg-indigo-50 border-l-2 border-indigo-300 rounded-r text-[11px] text-slate-700 leading-relaxed">
                {sf.overallFeedback}
              </div>
            </div>
          )}

          {sf.closing && (
            <p className="text-[10px] text-slate-400 leading-relaxed pt-1 border-t border-slate-100">
              {sf.closing.split('\n')[0]}
            </p>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] font-bold text-indigo-600 hover:text-indigo-700 uppercase tracking-wider"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
        <button
          onClick={() => onMarkUptake?.(record.feedbackId, !record.uptakeObservedAt)}
          title={record.uptakeObservedAt
            ? `Uptake observed ${formatSentAt(record.uptakeObservedAt)} — click to unmark`
            : 'Mark that this student acted on this feedback in a subsequent entry'}
          className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
            record.uptakeObservedAt
              ? 'text-emerald-600 hover:text-emerald-700'
              : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <CheckCircle2 size={11} />
          {record.uptakeObservedAt ? 'Uptake observed' : 'Mark uptake'}
        </button>
      </div>
    </div>
  );
};

// Legacy card: pre-Slice-6 records that only have rendered HTML in `content`.
// Strips HTML to plain text; unchanged behaviour.
const LegacyFeedbackCard: React.FC<{
  record: FeedbackHistoryRecord;
  onMarkUptake?: (feedbackId: string, observed: boolean) => Promise<void>;
}> = ({ record, onMarkUptake }) => {
  const [expanded, setExpanded] = useState(false);
  const fullText = useMemo(() => {
    const t = stripHtmlToText(record.content);
    return t;
  }, [record.content]);
  const preview = useMemo(() => (
    fullText.length > 220 ? fullText.slice(0, 220) + '…' : fullText
  ), [fullText]);
  const hasMore = fullText.length > 220;

  return (
    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
      <CARD_HEADER record={record} />
      <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
        {expanded ? fullText : preview}
      </p>
      <div className="mt-2 flex items-center justify-between">
        {hasMore ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] font-bold text-indigo-600 hover:text-indigo-700 uppercase tracking-wider"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        ) : <span />}
        <button
          onClick={() => onMarkUptake?.(record.feedbackId, !record.uptakeObservedAt)}
          title={record.uptakeObservedAt
            ? `Uptake observed ${formatSentAt(record.uptakeObservedAt)} — click to unmark`
            : 'Mark that this student acted on this feedback in a subsequent entry'}
          className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
            record.uptakeObservedAt
              ? 'text-emerald-600 hover:text-emerald-700'
              : 'text-slate-400 hover:text-slate-600'
          }`}
        >
          <CheckCircle2 size={11} />
          {record.uptakeObservedAt ? 'Uptake observed' : 'Mark uptake'}
        </button>
      </div>
    </div>
  );
};

interface PastFeedbackCardProps {
  record: FeedbackHistoryRecord;
  isFirst: boolean;
  onMarkUptake?: (feedbackId: string, observed: boolean) => Promise<void>;
}

const PastFeedbackCard: React.FC<PastFeedbackCardProps> = ({ record, isFirst, onMarkUptake }) => {
  if (record.structuredFeedback) {
    return <StructuredFeedbackCard record={record} isFirst={isFirst} onMarkUptake={onMarkUptake} />;
  }
  return <LegacyFeedbackCard record={record} onMarkUptake={onMarkUptake} />;
};
