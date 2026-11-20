import type { AiReviewAvailabilityAction } from '../services/aiReviewClient';

export interface AiReviewActionDeps {
  recoverMicrosoft: () => Promise<void>;
  recoverGoogle: () => Promise<void>;
  retryBinding: () => Promise<void>;
  /** Read at call time: a Google user exists and the save handler is mounted. */
  canSaveDraft: () => boolean;
}

/** Routes an AI review "fix it" action to the matching recovery step. */
export async function dispatchAiReviewAction(
  deps: AiReviewActionDeps,
  action: AiReviewAvailabilityAction,
  saveDraft: () => Promise<void>,
): Promise<void> {
  if (action === 'sign_in_microsoft') return deps.recoverMicrosoft();
  if (action === 'sign_in_google') return deps.recoverGoogle();
  if (action === 'retry_binding') return deps.retryBinding();
  if (!deps.canSaveDraft()) throw new Error('Sign in with Google before saving your draft.');
  return saveDraft();
}

/** Binds the dispatcher to App-level context; the caller supplies the per-entry save. */
export function useAiReviewActions(deps: AiReviewActionDeps) {
  return (action: AiReviewAvailabilityAction, saveDraft: () => Promise<void>) =>
    dispatchAiReviewAction(deps, action, saveDraft);
}
