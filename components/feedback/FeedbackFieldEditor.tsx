import React, { useRef, useState } from 'react';
import { MessageSquareQuote, RefreshCw } from 'lucide-react';
import type { useAiFeedbackReview } from '../../hooks/useAiFeedbackReview';
import type { AiReviewClientRequest, AiReviewComment, AiReviewFieldKey } from '../../services/aiFeedbackReview';
import {
  resolveAiReviewAvailability,
  type AiReviewAvailabilityAction,
  type AiReviewAvailabilityInput,
} from '../../services/aiReviewClient';
import { AiReviewPane } from './AiReviewPane';
import { useAiReviewRecovery } from '../../hooks/useAiReviewRecovery';

export interface FeedbackFieldChip {
  key: AiReviewFieldKey;
  label: string;
  placeholder: string;
  value: string;
}

export type AiReviewApi = ReturnType<typeof useAiFeedbackReview>;
export type AiReviewRequestBody = Omit<AiReviewClientRequest, 'idToken' | 'supersedesReviewId'>;

export interface FeedbackFieldEditorProps {
  fields: FeedbackFieldChip[];
  selectedKey: AiReviewFieldKey;
  onSelectField: (key: AiReviewFieldKey) => void;
  onChange: (key: AiReviewFieldKey, text: string) => void;
  onFocusEntry: () => void;
  /** The entry id the server knows this entry by (also the review key prefix). */
  reviewEntryId: string;
  /** Everything availability needs except the feedback text, which comes from the field. */
  availabilityInput: Omit<AiReviewAvailabilityInput, 'feedbackText'>;
  ai: AiReviewApi;
  buildReviewRequest: (fieldKey: AiReviewFieldKey, feedbackText: string) => AiReviewRequestBody;
  /** Saved baseline identity changes only after persistence succeeds. */
  savedRevision?: unknown;
  onAvailabilityAction: (action: AiReviewAvailabilityAction) => Promise<void>;
}

/**
 * The "Feedback Entry" block: field chips, the "Review my feedback" button, the
 * textarea, and the AI review pane beside it (below it on narrow screens).
 * The button is aria-disabled, never disabled (ARCHITECTURE §22).
 */
export const FeedbackFieldEditor: React.FC<FeedbackFieldEditorProps> = ({
  fields, selectedKey, onSelectField, onChange, onFocusEntry, reviewEntryId,
  availabilityInput, ai, buildReviewRequest, onAvailabilityAction, savedRevision,
}) => {
  const [paneOpen, setPaneOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selected = fields.find((f) => f.key === selectedKey) ?? fields[0];
  const reviewKey = `${reviewEntryId}-${selected.key}`;
  const availability = resolveAiReviewAvailability({ ...availabilityInput, feedbackText: selected.value });
  const ready = availability.state === 'ready';
  const pending = !!ai.pending[reviewKey];
  const state = ai.byKey[reviewKey];
  const recovery = useAiReviewRecovery({
    reviewKey, entryId: reviewEntryId, ai, feedbackText: selected.value, availabilityInput, savedRevision,
    buildRequest: () => buildReviewRequest(selected.key, selected.value),
    onAction: onAvailabilityAction,
  });

  const requestReview = () => {
    if (!ready || pending || recovery.recovering) return;
    void ai.review(reviewKey, buildReviewRequest(selected.key, selected.value));
  };

  const onReviewClick = () => {
    setPaneOpen(true);
    if (!ready) return;
    requestReview();
  };

  const selectComment = (c: AiReviewComment) => {
    const ta = textareaRef.current;
    if (!ta || c.start < 0 || !state || selected.value !== state.expectedText) return;
    ta.focus();
    ta.setSelectionRange(c.start, c.end);
  };

  const apply = (c: AiReviewComment) => {
    if (!state) return;
    const next = ai.apply(reviewKey, state.review.reviewId, c.id, selected.value);
    if (next !== null) onChange(selected.key, next);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {fields.map((option) => {
          const active = selected.key === option.key;
          const hasFeedback = option.value.trim() !== '';
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onSelectField(option.key)}
              className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-wider transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-200 ${
                active
                  ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                  : hasFeedback
                    ? 'border-emerald-100 bg-emerald-50 text-emerald-700 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700'
                    : 'border-slate-200 bg-slate-50 text-slate-500 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700'
              }`}
            >
              {option.label}
              {hasFeedback && <span className="ml-1 text-[9px]">· Drafted</span>}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onReviewClick}
          aria-disabled={ready && !pending && !recovery.recovering ? undefined : 'true'}
          title={recovery.savingDraft ? 'Saving draft…' : ready ? `Get AI comments on your ${selected.label.toLowerCase()} feedback` : availability.message}
          className={`inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-wider transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-200 ${
            ready && !pending && !recovery.recovering
              ? 'border-indigo-100 bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
              : 'border-slate-200 bg-slate-50 text-slate-400'
          }`}
        >
          {pending || recovery.savingDraft ? <RefreshCw size={12} className="animate-spin" /> : <MessageSquareQuote size={12} />}
          Review my feedback
        </button>
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <textarea
          ref={textareaRef}
          value={selected.value}
          onFocus={onFocusEntry}
          onChange={(e) => onChange(selected.key, e.target.value)}
          placeholder={selected.placeholder}
          className="w-full min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm leading-relaxed text-slate-700 resize-y focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-300 md:flex-1"
          rows={4}
        />
        {paneOpen && (
          <AiReviewPane
            availability={availability}
            onAvailabilityAction={(action) => void recovery.performAction(action)}
            state={state}
            currentText={selected.value}
            pending={pending}
            savingDraft={recovery.savingDraft}
            waitingSignIn={recovery.waitingSignIn}
            actionError={recovery.actionError}
            saveFailed={recovery.saveFailed}
            error={ai.errors[reviewKey]}
            outcomeError={ai.outcomeErrors[reviewKey]}
            canReview={ready && !recovery.recovering}
            onReview={requestReview}
            onApply={apply}
            onDismiss={(c) => state && void ai.dismiss(reviewKey, state.review.reviewId, c.id)}
            onRetryOutcome={() => void ai.retryOutcome(reviewKey)}
            onSelectComment={selectComment}
          />
        )}
      </div>
    </div>
  );
};
