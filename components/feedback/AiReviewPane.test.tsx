// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackFieldEditor, type FeedbackFieldEditorProps } from './FeedbackFieldEditor';
import type { AiReviewEntryState } from '../../hooks/useAiFeedbackReview';
import type { AiReviewComment } from '../../services/aiFeedbackReview';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT = 'You wrote well. Check the verb tense.';
const comment = (over: Partial<AiReviewComment> = {}): AiReviewComment => ({
  id: 'c1', quote: 'Check the verb tense.', start: 17, end: 38, category: 'correction', basis: 'student_text',
  note: 'Name the verb.', suggestion: 'Check "go" vs "went".', ...over,
});
const entryState = (comments: AiReviewComment[], over: Partial<AiReviewEntryState> = {}, outcomes: any = {}): AiReviewEntryState => ({
  review: { reviewId: 'r1', summary: 'A warm start; one point is vague.', comments, outcomes } as any,
  expectedText: TEXT,
  comments,
  ...over,
});

const READY = {
  canUseAiReview: true, configured: true, microsoftSignedIn: true, hasFirebaseUser: true,
  bindingStatus: 'bound' as const, pilotEnabled: true, entrySaved: true,
};

let container: HTMLDivElement;
let root: Root;
let ai: any;
let onChange: any;
let onAction: any;

const render = async (over: Partial<FeedbackFieldEditorProps> = {}, state?: AiReviewEntryState, value = TEXT, aiOver: Record<string, unknown> = {}) => {
  ai = {
    byKey: state ? { 'e1-diaryText': state } : {},
    pending: {}, errors: {}, outcomeErrors: {},
    scopeEpoch: 0, clearError: vi.fn(),
    reviewIdsForEntry: vi.fn(() => []), sentReviewRefsForEntry: vi.fn(() => ({ ids: [], omitted: 0 })),
    review: vi.fn(async () => {}),
    apply: vi.fn(() => 'APPLIED TEXT'),
    dismiss: vi.fn(async () => {}),
    retryOutcome: vi.fn(async () => {}),
    ...aiOver,
  };
  onChange = vi.fn();
  onAction = vi.fn(async () => {});
  const props: FeedbackFieldEditorProps = {
    fields: [{ key: 'diaryText', label: 'Diary', placeholder: 'ph', value }],
    selectedKey: 'diaryText',
    onSelectField: vi.fn(),
    onChange,
    onFocusEntry: vi.fn(),
    reviewEntryId: 'e1',
    availabilityInput: READY,
    ai,
    buildReviewRequest: vi.fn(() => ({}) as any),
    onAvailabilityAction: onAction,
    ...over,
  };
  await act(async () => root.render(<FeedbackFieldEditor {...props} />));
};

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent!.trim().startsWith(label)) as HTMLButtonElement | undefined;
const click = async (label: string) => {
  const b = button(label);
  expect(b, label).toBeDefined();
  await act(async () => b!.click());
};

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('fixable server error codes offer the action', () => {
  const cases: Array<[string, string]> = [
    ['not_authenticated', 'sign_in_microsoft'],
    ['invalid_firebase_token', 'sign_in_google'],
    ['identity_not_bound', 'retry_binding'],
    ['entry_not_saved', 'save_draft'],
  ];
  it.each(cases)('%s shows a button that calls the handler with %s', async (code, action) => {
    await render({}, undefined, TEXT, { errors: { 'e1-diaryText': { message: 'Server said no.', code } } });
    await click('Review my feedback');
    expect(container.textContent).toContain('Server said no.');
    const alert = container.querySelector('[data-review-error]')!;
    const b = alert.querySelector('button') as HTMLButtonElement;
    expect(b).not.toBeNull();
    await act(async () => b.click());
    expect(onAction).toHaveBeenCalledWith(action);
  });
  it('other codes show the message only', async () => {
    await render({}, undefined, TEXT, { errors: { 'e1-diaryText': { message: 'Boom.', code: 'model_error' } } });
    await click('Review my feedback');
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('Boom.');
    expect(alert.querySelector('button')).toBeNull();
  });
});

describe('Review my feedback button', () => {
  it('reads "Review my feedback" and is never disabled', async () => {
    await render();
    const b = button('Review my feedback')!;
    expect(b).toBeDefined();
    expect(b.disabled).toBe(false);
    expect(b.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('when unavailable: aria-disabled, title is the message, click opens pane with the action', async () => {
    await render({ availabilityInput: { ...READY, microsoftSignedIn: false } });
    const b = button('Review my feedback')!;
    expect(b.disabled).toBe(false);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.title).toBe('Your Microsoft sign-in has expired. Sign in to use AI review.');
    await click('Review my feedback');
    expect(container.textContent).toContain('Your Microsoft sign-in has expired. Sign in to use AI review.');
    expect(ai.review).not.toHaveBeenCalled();
    await click('Sign in');
    expect(onAction).toHaveBeenCalledWith('sign_in_microsoft');
  });

  it('when ready, clicking requests a review keyed entryId-fieldKey', async () => {
    await render();
    await click('Review my feedback');
    expect(ai.review).toHaveBeenCalledTimes(1);
    expect(ai.review.mock.calls[0][0]).toBe('e1-diaryText');
  });
});

describe('review pane', () => {
  it('shows summary, category, basis, quote, note and suggestion', async () => {
    await render({}, entryState([comment()]));
    await click('Review my feedback');
    const t = container.textContent!;
    expect(t).toContain('A warm start; one point is vague.');
    expect(t).toContain('correction');
    expect(t).toContain('student_text'.replace('_', ' '));
    expect(t).toContain('Check the verb tense.');
    expect(t).toContain('Name the verb.');
    expect(t).toContain('Check "go" vs "went".');
    expect(t).toContain('Suggestions only. You decide what the student receives.');
  });

  it('Apply calls apply and passes the new text to onChange', async () => {
    await render({}, entryState([comment()]));
    await click('Review my feedback');
    await click('Apply');
    expect(ai.apply).toHaveBeenCalledWith('e1-diaryText', 'r1', 'c1', TEXT);
    expect(onChange).toHaveBeenCalledWith('diaryText', 'APPLIED TEXT');
  });

  it('does not call onChange when apply returns null', async () => {
    await render({}, entryState([comment()]));
    ai.apply.mockReturnValue(null);
    await click('Review my feedback');
    await click('Apply');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Apply is aria-disabled with a note once the text has changed', async () => {
    await render({}, entryState([comment()]), TEXT + ' edit');
    await click('Review my feedback');
    const apply = button('Apply')!;
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    expect(apply.disabled).toBe(false);
    expect(container.textContent).toContain('Your text has changed since this review — Re-review to get suggestions for the new version.');
    await act(async () => apply.click());
    expect(ai.apply).not.toHaveBeenCalled();
  });

  it('whole-message comments have no Apply', async () => {
    await render({}, entryState([comment({ quote: '', start: -1, end: -1, suggestion: undefined })]));
    await click('Review my feedback');
    expect(button('Apply')).toBeUndefined();
  });

  it('Dismiss calls dismiss', async () => {
    await render({}, entryState([comment()]));
    await click('Review my feedback');
    await click('Dismiss');
    expect(ai.dismiss).toHaveBeenCalledWith('e1-diaryText', 'r1', 'c1');
  });

  it('resolved cards are muted and labelled', async () => {
    const outcomes = { c1: { status: 'dismissed', at: 'x', byUpn: '' } };
    await render({}, entryState([comment()], {}, outcomes));
    await click('Review my feedback');
    expect(container.textContent).toContain('Dismissed');
    expect(container.querySelector('[data-resolved="true"]')).not.toBeNull();
    expect(button('Dismiss')).toBeUndefined();
  });

  it('dismissed cards keep an Apply action that applies; applied cards show no actions', async () => {
    const dismissed = { c1: { status: 'dismissed', at: 'x', byUpn: '' } };
    await render({}, entryState([comment()], {}, dismissed));
    await click('Review my feedback');
    expect(container.textContent).toContain('Dismissed');
    await click('Apply');
    expect(ai.apply).toHaveBeenCalledWith('e1-diaryText', 'r1', 'c1', TEXT);
    const applied = { c1: { status: 'applied', at: 'x', byUpn: '' } };
    await render({}, entryState([comment()], {}, applied));
    expect(button('Apply')).toBeUndefined();
    expect(button('Dismiss')).toBeUndefined();
  });

  it('a dismissed card without a valid suggestion offers no Apply', async () => {
    const dismissed = { c1: { status: 'dismissed', at: 'x', byUpn: '' } };
    await render({}, entryState([comment({ suggestion: undefined })], {}, dismissed));
    await click('Review my feedback');
    expect(button('Apply')).toBeUndefined();
  });

  it('shows the outcome error and retries', async () => {
    await render({}, entryState([comment()]), TEXT, { outcomeErrors: { 'e1-diaryText': "Couldn't save that — retry" } });
    await click('Review my feedback');
    expect(container.textContent).toContain("Couldn't save that — retry");
    await click("Couldn't save that — retry");
    expect(ai.retryOutcome).toHaveBeenCalledWith('e1-diaryText');
  });

  it('a review with zero comments says no changes suggested', async () => {
    await render({}, entryState([]));
    await click('Review my feedback');
    expect(container.textContent).toContain('No changes suggested.');
  });

  it('clicking a card focuses the textarea and selects the quote', async () => {
    await render({}, entryState([comment()]));
    await click('Review my feedback');
    const ta = container.querySelector('textarea')!;
    const spy = vi.spyOn(ta, 'setSelectionRange');
    const card = container.querySelector<HTMLElement>('[data-comment-id="c1"]')!;
    await act(async () => card.click());
    expect(spy).toHaveBeenCalledWith(17, 38);
    expect(document.activeElement).toBe(ta);
  });
});
