/**
 * Client side of AI feedback review: availability resolution and the two
 * network calls. Never logs tokens or feedback text.
 */
import type { IdentityBindingStatus } from '../hooks/useIdentityBinding';
import type { AiReviewClientRequest } from './aiFeedbackReview';
import type { AiFeedbackReviewRecord } from './aiReviewServer';

export type AiReviewUnavailable =
  | 'role_not_enabled' | 'not_configured' | 'microsoft_signed_out' | 'google_signed_out'
  | 'binding_pending' | 'binding_failed' | 'entry_not_saved' | 'empty_feedback';

export type AiReviewAvailabilityAction = 'sign_in_microsoft' | 'sign_in_google' | 'retry_binding' | 'save_draft';

export type AiReviewAvailability =
  | { state: 'ready' }
  | { state: 'unavailable'; reason: AiReviewUnavailable; message: string; action?: AiReviewAvailabilityAction };

export interface AiReviewAvailabilityInput {
  canUseAiReview: boolean;
  configured: boolean;
  microsoftSignedIn: boolean;
  hasFirebaseUser: boolean;
  bindingStatus: IdentityBindingStatus;
  pilotEnabled: boolean;
  entrySaved: boolean;
  feedbackText: string;
}

export function resolveAiReviewAvailability(i: AiReviewAvailabilityInput): AiReviewAvailability {
  const no = (
    reason: AiReviewUnavailable,
    message: string,
    action?: AiReviewAvailabilityAction
  ): AiReviewAvailability => (action ? { state: 'unavailable', reason, message, action } : { state: 'unavailable', reason, message });

  // Sign-in states first: while signed out the profile and capability are unknown,
  // so nothing below may be asserted (for example "ask the course owner").
  if (!i.microsoftSignedIn) return no('microsoft_signed_out', 'Your Microsoft sign-in has expired. Sign in to use AI review.', 'sign_in_microsoft');
  if (!i.hasFirebaseUser) return no('google_signed_out', 'Sign in with Google to use AI review.', 'sign_in_google');
  if (i.pilotEnabled) {
    if (i.bindingStatus === 'error') {
      return no('binding_failed', 'Your Microsoft and Google accounts could not be linked. Retry linking.', 'retry_binding');
    }
    if (i.bindingStatus !== 'bound') {
      return no('binding_pending', 'Linking your Microsoft and Google accounts. This takes a moment.');
    }
  }
  if (!i.canUseAiReview) return no('role_not_enabled', 'AI review is not enabled for your role. Ask the course owner.');
  if (!i.configured) return no('not_configured', 'AI review is not configured on the server.');
  if (!i.entrySaved) return no('entry_not_saved', 'Save this entry as a draft before requesting a review.', 'save_draft');
  if (!i.feedbackText.trim()) return no('empty_feedback', 'Write some feedback first, then ask for a review.');
  return { state: 'ready' };
}

/** Server error codes the person can fix, mapped to the action that fixes them (ARCHITECTURE §22). */
export function actionForErrorCode(code: string | undefined): AiReviewAvailabilityAction | undefined {
  switch (code) {
    case 'not_authenticated': return 'sign_in_microsoft';
    case 'invalid_firebase_token': return 'sign_in_google';
    case 'identity_not_bound': return 'retry_binding';
    case 'entry_not_saved': return 'save_draft';
    default: return undefined;
  }
}

export class AiReviewHttpError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
  }
}

async function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    throw new AiReviewHttpError('Could not reach the server. Check your connection and try again.', 'network_error', 0);
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    throw new AiReviewHttpError(
      typeof json?.message === 'string' && json.message ? json.message : fallback,
      typeof json?.error === 'string' ? json.error : 'error',
      res.status
    );
  }
  return json as T;
}

export const requestAiReview = (req: AiReviewClientRequest) =>
  postJson<{ review: AiFeedbackReviewRecord }>('/api/ai/review-feedback', req, 'AI review failed. Try again.');

export const postAiReviewOutcome = (req: {
  idToken: string; reviewId: string; commentId: string; status: 'applied' | 'dismissed';
}) =>
  postJson<{ ok: true; outcomes: AiFeedbackReviewRecord['outcomes'] }>(
    '/api/ai/review-feedback/outcome', req, 'The outcome could not be saved. Try again.'
  );
