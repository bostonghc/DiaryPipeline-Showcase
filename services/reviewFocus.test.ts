import { describe, expect, it } from 'vitest';
import { DEFAULT_FIELD_REVIEW_FOCUS } from './aiFeedbackReview';
import { DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS } from './prompts';
import type { UserPreferences } from '../types';
import { earlierCustomDraftingInstruction, effectiveReviewFocus } from './reviewFocus';

describe('effectiveReviewFocus', () => {
  it('uses the reviewer default when nothing is saved', () => {
    expect(effectiveReviewFocus({}, 'vocab')).toEqual({ text: DEFAULT_FIELD_REVIEW_FOCUS.vocab, source: 'default' });
  });
  it('treats a blank saved value as the default', () => {
    expect(effectiveReviewFocus({ reviewFocus: { vocab: '   ' } }, 'vocab').source).toBe('default');
  });
  it('uses a saved non-empty value as custom', () => {
    expect(effectiveReviewFocus({ reviewFocus: { vocab: 'Check word forms' } }, 'vocab'))
      .toEqual({ text: 'Check word forms', source: 'custom' });
  });
  it('never returns saved drafting prompts as review focus', () => {
    const prefs: UserPreferences = { aiPrompts: { diaryText: 'Write the feedback for me', peerFeedback: '', vocab: '', translations: '', overall: '' } };
    const r = effectiveReviewFocus(prefs, 'diaryText');
    expect(r).toEqual({ text: DEFAULT_FIELD_REVIEW_FOCUS.diaryText, source: 'default' });
  });
});

describe('earlierCustomDraftingInstruction', () => {
  const d = DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS;
  it('returns a non-default drafting prompt', () => {
    expect(earlierCustomDraftingInstruction({ aiPrompts: { ...d, vocab: 'Mine' } }, 'vocab')).toBe('Mine');
  });
  it('returns null for default, empty, absent and chatbot', () => {
    expect(earlierCustomDraftingInstruction({ aiPrompts: { ...d } }, 'vocab')).toBeNull();
    expect(earlierCustomDraftingInstruction({ aiPrompts: { ...d, vocab: '  ' } }, 'vocab')).toBeNull();
    expect(earlierCustomDraftingInstruction({}, 'vocab')).toBeNull();
    expect(earlierCustomDraftingInstruction({ aiPrompts: { ...d } }, 'chatbot')).toBeNull();
  });
});
