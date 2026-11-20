import { useEffect, useRef, useState } from 'react';
import type { AiReviewApi, AiReviewRequestBody } from '../components/feedback/FeedbackFieldEditor';
import {
  resolveAiReviewAvailability,
  type AiReviewAvailabilityAction,
  type AiReviewAvailabilityInput,
} from '../services/aiReviewClient';
import { DEFAULT_FIELD_REVIEW_FOCUS } from '../services/aiFeedbackReview';

const ACTION_ERROR: Record<AiReviewAvailabilityAction, string> = {
  save_draft: 'entry_not_saved',
  sign_in_microsoft: 'not_authenticated',
  sign_in_google: 'invalid_firebase_token',
  retry_binding: 'identity_not_bound',
};

interface Params {
  reviewKey: string;
  entryId: string;
  ai: AiReviewApi;
  feedbackText: string;
  availabilityInput: Omit<AiReviewAvailabilityInput, 'feedbackText'>;
  /** Changes only after persistence succeeds, including a bottom-bar save. */
  savedRevision?: unknown;
  buildRequest: () => AiReviewRequestBody;
  /** Resolves after the fixing action succeeds; rejects on failure. */
  onAction: (action: AiReviewAvailabilityAction) => Promise<void>;
}

function clearActionError(p: Params, action: AiReviewAvailabilityAction, expectedEpoch = p.ai.scopeEpoch) {
  const keys = action === 'save_draft'
    ? Object.keys(DEFAULT_FIELD_REVIEW_FOCUS).map((field) => `${p.entryId}-${field}`)
    : Object.keys(p.ai.errors);
  for (const key of keys) p.ai.clearError(key, ACTION_ERROR[action], expectedEpoch);
}

/** Owns prerequisite recovery; saving in this pane continues into the requested review. */
export function useAiReviewRecovery(p: Params) {
  const context = `${p.ai.scopeEpoch}|${p.reviewKey}`;
  const latest = useRef(p);
  latest.current = p;
  const contextRef = useRef(context);
  const generation = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const [progress, setProgress] = useState<{ context: string; action?: AiReviewAvailabilityAction; saveFailed?: boolean; actionError?: string; failedAction?: AiReviewAvailabilityAction }>({ context });

  if (contextRef.current !== context) {
    contextRef.current = context;
    generation.current += 1;
    busy.current = false;
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  // A cached true prerequisite does not disprove a fresh server error. Clear
  // only on a later successful save/recovery transition, or explicit action success.
  const previous = useRef({ scopeEpoch: p.ai.scopeEpoch, entryId: p.entryId, savedRevision: p.savedRevision, input: p.availabilityInput });
  useEffect(() => {
    const before = previous.current;
    const now = p.availabilityInput;
    const settle = (action: AiReviewAvailabilityAction) =>
      setProgress((state) => state.failedAction === action ? { context: state.context } : state);
    if (before.scopeEpoch === p.ai.scopeEpoch) {
      const saved = before.entryId === p.entryId && now.entrySaved &&
        (!before.input.entrySaved || before.savedRevision !== p.savedRevision);
      if (saved) {
        clearActionError(p, 'save_draft');
        setProgress((state) => state.context === context && state.saveFailed ? { context } : state);
      }
      if (!before.input.microsoftSignedIn && now.microsoftSignedIn) { clearActionError(p, 'sign_in_microsoft'); settle('sign_in_microsoft'); }
      if (!before.input.hasFirebaseUser && now.hasFirebaseUser) { clearActionError(p, 'sign_in_google'); settle('sign_in_google'); }
      if (before.input.bindingStatus !== 'bound' && now.bindingStatus === 'bound') { clearActionError(p, 'retry_binding'); settle('retry_binding'); }
    }
    previous.current = { scopeEpoch: p.ai.scopeEpoch, entryId: p.entryId, savedRevision: p.savedRevision, input: now };
  }, [context, p.savedRevision, p.availabilityInput, p.ai.clearError, p.reviewKey, p.entryId]);

  // A newly published review means the earlier action failure is stale.
  // So is a failure superseded by a newer review error.
  const reviewState = p.ai.byKey[p.reviewKey];
  const reviewError = p.ai.errors[p.reviewKey];
  useEffect(() => {
    setProgress((state) => state.actionError ? { context: state.context } : state);
  }, [reviewState, reviewError]);

  const performAction = async (action: AiReviewAvailabilityAction) => {
    if (busy.current) return;
    const initial = latest.current;
    const scopeEpoch = initial.ai.scopeEpoch;
    const capturedContext = contextRef.current;
    const run = ++generation.current;
    const current = () => mounted.current && contextRef.current === capturedContext && generation.current === run;
    busy.current = true;
    setProgress({ context: capturedContext, action });
    try {
      await latest.current.onAction(action);
    } catch (error) {
      // A failed save has its own copy; other actions surface their (safe, fixed) message.
      const actionError = action !== 'save_draft' && error instanceof Error && error.message
        ? error.message.slice(0, 200) : undefined;
      if (current()) setProgress({ context: capturedContext, saveFailed: action === 'save_draft', actionError, failedAction: actionError ? action : undefined });
      if (current()) busy.current = false;
      return;
    }
    // The global state hook may outlive this editor. Clear its original error
    // even after navigation; clearError itself rejects an obsolete auth epoch.
    clearActionError({ ...latest.current, entryId: initial.entryId }, action, scopeEpoch);
    if (!current()) return;
    const next = latest.current;
    setProgress({ context: capturedContext });
    busy.current = false;
    if (action === 'save_draft') {
      // The save promise can settle before React publishes the saved baseline.
      // Its success establishes that prerequisite; all others are checked live.
      const available = resolveAiReviewAvailability({ ...next.availabilityInput, entrySaved: true, feedbackText: next.feedbackText });
      if (available.state === 'ready') {
        await next.ai.review(next.reviewKey, next.buildRequest());
      }
    }
  };

  const active = progress.context === context;
  return {
    performAction,
    recovering: active && !!progress.action,
    savingDraft: active && progress.action === 'save_draft',
    waitingSignIn: active && (progress.action === 'sign_in_microsoft' || progress.action === 'sign_in_google'),
    actionError: active ? progress.actionError : undefined,
    saveFailed: active && !!progress.saveFailed,
  };
}
