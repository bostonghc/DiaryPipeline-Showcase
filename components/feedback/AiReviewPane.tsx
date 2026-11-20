import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { AiReviewEntryState, AiReviewError } from '../../hooks/useAiFeedbackReview';
import type { AiReviewComment } from '../../services/aiFeedbackReview';
import { actionForErrorCode, type AiReviewAvailability, type AiReviewAvailabilityAction } from '../../services/aiReviewClient';

export const ACTION_LABELS: Record<AiReviewAvailabilityAction, string> = {
  sign_in_microsoft: 'Sign in',
  sign_in_google: 'Sign in',
  retry_binding: 'Retry linking',
  save_draft: 'Save draft and review',
};

export const STALE_NOTE =
  'Your text has changed since this review — Re-review to get suggestions for the new version.';

export interface AiReviewPaneProps {
  availability: AiReviewAvailability;
  onAvailabilityAction: (action: AiReviewAvailabilityAction) => void;
  state?: AiReviewEntryState;
  currentText: string;
  pending: boolean;
  savingDraft?: boolean;
  waitingSignIn?: boolean;
  /** Why the last recovery action failed; replaces the server error banner while shown. */
  actionError?: string;
  saveFailed?: boolean;
  error?: AiReviewError;
  outcomeError?: string;
  /** Re-review is offered only when a review can actually be requested. */
  canReview: boolean;
  onReview: () => void;
  onApply: (comment: AiReviewComment) => void;
  onDismiss: (comment: AiReviewComment) => void;
  onRetryOutcome: () => void;
  onSelectComment: (comment: AiReviewComment) => void;
}

const BASIS_LABEL: Record<string, string> = {
  student_text: 'student text',
  prior_feedback: 'prior feedback',
  general_practice: 'general practice',
};

export const AiReviewPane: React.FC<AiReviewPaneProps> = ({
  availability, onAvailabilityAction, state, currentText, pending, savingDraft = false, waitingSignIn = false, actionError, saveFailed = false, error, outcomeError,
  canReview, onReview, onApply, onDismiss, onRetryOutcome, onSelectComment,
}) => {
  const stale = !!state && currentText !== state.expectedText;
  const outcomes = state?.review.outcomes ?? {};
  const errorAction = actionForErrorCode(error?.code);

  return (
    <aside
      aria-label="AI review"
      className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-sm text-slate-700 md:w-80 md:shrink-0"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h5 className="text-[10px] font-black uppercase tracking-wider text-slate-400">AI review</h5>
        {state && canReview && (
          <button
            type="button"
            onClick={onReview}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-slate-500 hover:border-indigo-200 hover:text-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          >
            Re-review
          </button>
        )}
      </div>

      {availability.state === 'unavailable' && !savingDraft && !waitingSignIn && !saveFailed &&
        !(pending && availability.reason === 'entry_not_saved') && (
        <div className="mb-2 rounded-md border border-amber-100 bg-amber-50 p-2.5 text-xs text-amber-900">
          <p>{availability.message}</p>
          {availability.action && (
            <button
              type="button"
              onClick={() => onAvailabilityAction(availability.action!)}
              className="mt-2 rounded-full border border-amber-200 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-800 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-200"
            >
              {ACTION_LABELS[availability.action]}
            </button>
          )}
        </div>
      )}

      {savingDraft && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-500" role="status">
          <RefreshCw size={12} className="animate-spin" /> Saving draft…
        </p>
      )}
      {waitingSignIn && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-500" role="status">
          <RefreshCw size={12} className="animate-spin" /> Waiting for sign-in…
        </p>
      )}
      {actionError && !savingDraft && !waitingSignIn && !saveFailed && (
        <div role="status" className="mb-2 rounded-md border border-amber-100 bg-amber-50 p-2.5 text-xs text-amber-900">
          <p>{actionError}</p>
          {errorAction && (
            <button
              type="button"
              onClick={() => onAvailabilityAction(errorAction)}
              className="mt-2 rounded-full border border-amber-200 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-800 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-200"
            >
              {ACTION_LABELS[errorAction]}
            </button>
          )}
        </div>
      )}
      {saveFailed && (
        <div className="mb-2 text-xs text-rose-600" role="alert">
          <p>Couldn't save the draft — retry</p>
          <button type="button" onClick={() => onAvailabilityAction('save_draft')}
            className="mt-2 rounded-full border border-rose-200 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-wider text-rose-700 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-200">
            Retry
          </button>
        </div>
      )}
      {pending && !savingDraft && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-500" role="status">
          <RefreshCw size={12} className="animate-spin" /> Reviewing your feedback…
        </p>
      )}
      {error && !actionError && !savingDraft && !waitingSignIn && !saveFailed &&
        !(errorAction && availability.state === 'unavailable' && availability.action === errorAction) && (
        <div data-review-error role={errorAction ? 'status' : 'alert'}
          className={errorAction
            ? 'mb-2 rounded-md border border-amber-100 bg-amber-50 p-2.5 text-xs text-amber-900'
            : 'mb-2 text-xs text-rose-600'}>
          <p>{error.message}</p>
          {errorAction && (
            <button
              type="button"
              onClick={() => onAvailabilityAction(errorAction)}
              className="mt-2 rounded-full border border-amber-200 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-800 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-200"
            >
              {ACTION_LABELS[errorAction]}
            </button>
          )}
        </div>
      )}

      {!state && !pending && !savingDraft && !waitingSignIn && !saveFailed && !error && availability.state === 'ready' && (
        <p className="text-xs text-slate-500">Click “Review my feedback” to get comments on your draft.</p>
      )}

      {state && (
        <div className="space-y-2">
          <p className="text-sm leading-relaxed text-slate-700">{state.review.summary}</p>
          {stale && <p className="rounded-md bg-slate-100 p-2 text-xs text-slate-600">{STALE_NOTE}</p>}
          {outcomeError && (
            <button
              type="button"
              onClick={onRetryOutcome}
              className="text-xs font-bold text-rose-600 underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-rose-200"
            >
              {outcomeError}
            </button>
          )}
          {state.comments.length === 0 && <p className="text-xs text-slate-500">No changes suggested.</p>}
          <ul className="space-y-2">
            {state.comments.map((c) => {
              const outcome = outcomes[c.id];
              const resolved = !!outcome;
              const dismissedOnly = outcome?.status === 'dismissed';
              // Applied is final; a dismissed comment can still be applied.
              const canApply = c.suggestion !== undefined && c.start >= 0 && (!resolved || dismissedOnly);
              const applyDisabled = stale;
              return (
                <li
                  key={c.id}
                  data-comment-id={c.id}
                  data-resolved={resolved ? 'true' : undefined}
                  onClick={() => onSelectComment(c)}
                  className={`cursor-pointer rounded-md border bg-white p-2.5 transition-colors ${
                    resolved ? 'border-slate-100 opacity-60' : 'border-slate-200 hover:border-indigo-200'
                  }`}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-400">
                    <span>{c.category}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-bold normal-case tracking-normal">{BASIS_LABEL[c.basis] ?? c.basis}</span>
                    {resolved && (
                      <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                        {outcome.status === 'applied' ? 'Applied' : 'Dismissed'}
                      </span>
                    )}
                  </div>
                  {c.quote && <p className="border-l-2 border-slate-200 pl-2 text-xs italic text-slate-500">{c.quote}</p>}
                  <p className="mt-1 text-sm text-slate-700">{c.note}</p>
                  {c.suggestion !== undefined && (
                    <p className="mt-1 rounded bg-indigo-50/60 px-2 py-1 text-xs text-slate-700">{c.suggestion}</p>
                  )}
                  {(!resolved || (dismissedOnly && canApply)) && (
                    <div className="mt-2 flex gap-2">
                      {canApply && (
                        <button
                          type="button"
                          aria-disabled={applyDisabled ? 'true' : undefined}
                          title={applyDisabled ? STALE_NOTE : undefined}
                          onClick={(e) => { e.stopPropagation(); if (!applyDisabled) onApply(c); }}
                          className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wider focus:outline-none focus:ring-2 focus:ring-indigo-200 ${
                            applyDisabled
                              ? 'border-slate-200 bg-slate-50 text-slate-400'
                              : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                          }`}
                        >
                          Apply
                        </button>
                      )}
                      {!resolved && <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onDismiss(c); }}
                        className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[10px] font-black uppercase tracking-wider text-slate-500 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-200"
                      >
                        Dismiss
                      </button>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="mt-3 text-[11px] text-slate-400">Suggestions only. You decide what the student receives.</p>
    </aside>
  );
};
