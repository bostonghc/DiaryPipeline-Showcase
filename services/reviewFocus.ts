import type { UserPreferences } from '../types';
import { DEFAULT_FIELD_REVIEW_FOCUS, type AiReviewFieldKey } from './aiFeedbackReview';
import { DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS } from './prompts';

export type ReviewFocusSource = 'default' | 'custom';
export interface EffectiveReviewFocus { text: string; source: ReviewFocusSource }

type PrefsSlice = { aiPrompts?: Partial<Record<string, string>> };

/** The focus the AI reviewer uses for a field: the saved non-empty value, else the default. */
export function effectiveReviewFocus(prefs: Pick<UserPreferences, 'reviewFocus'>, field: AiReviewFieldKey): EffectiveReviewFocus {
  const saved = prefs.reviewFocus?.[field];
  if (typeof saved === 'string' && saved.trim() !== '') return { text: saved, source: 'custom' };
  return { text: DEFAULT_FIELD_REVIEW_FOCUS[field], source: 'default' };
}

/**
 * Read-only reference to a teacher's earlier drafting instruction: a stored
 * drafting prompt that is non-empty and differs from its default. Never used as
 * review focus; copied across only by an explicit teacher action.
 */
export function earlierCustomDraftingInstruction(prefs: PrefsSlice, field: AiReviewFieldKey): string | null {
  if (field === 'chatbot') return null;
  const stored = prefs.aiPrompts?.[field];
  if (typeof stored !== 'string' || stored.trim() === '') return null;
  return stored === DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS[field] ? null : stored;
}

/** Input limits for AI review settings. */
export const REVIEW_FOCUS_MAX_LENGTH = 2000;
export const FEEDBACK_TONE_MAX_LENGTH = 200;
