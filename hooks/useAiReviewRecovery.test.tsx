// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackFieldEditor, type FeedbackFieldEditorProps } from '../components/feedback/FeedbackFieldEditor';
import { useAiFeedbackReview } from './useAiFeedbackReview';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const TEXT = 'A thoughtful draft from the instructor.';
const KEY = 'entry-diaryText';
const USER = { uid: 'u1', getIdToken: async () => 'token' } as never;
const INPUT = {
  canUseAiReview: true, configured: true, microsoftSignedIn: true, hasFirebaseUser: true,
  bindingStatus: 'bound' as const, pilotEnabled: true, entrySaved: true,
};
const deferred = () => { let resolve!: () => void; let reject!: (e: Error) => void; const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const errorResponse = (code: string) => ({ ok: false, status: 409, json: async () => ({ error: code, message: `SERVER:${code}` }) });
const reviewResponse = (text: string) => ({ ok: true, status: 200, json: async () => ({ review: {
  reviewId: 'review', entryId: 'entry', fieldKey: 'diaryText', summary: 'An effective draft.', comments: [], outcomes: {}, inputs: { feedbackTextSnapshot: text },
} }) });

describe('AI review prerequisite recovery', () => {
  let root: Root;
  let container: HTMLDivElement;
  let api: ReturnType<typeof useAiFeedbackReview>;
  let onChange: ReturnType<typeof vi.fn<FeedbackFieldEditorProps['onChange']>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let value: string;
  let savedRevision: unknown;
  let selectedKey: 'diaryText' | 'vocab';
  let input: typeof INPUT;
  let upn: string;
  let editorVisible: boolean;
  let action: FeedbackFieldEditorProps['onAvailabilityAction'];
  const request = (fieldKey = selectedKey, feedbackText = value) => ({
    classId: 'class', pageId: 'page', entryId: 'entry', fieldKey,
    feedbackText, priorFeedbackIds: [], reviewFocus: '', reviewFocusSource: 'default' as const,
    tone: 'warm', itemCountSetting: '3-4' as const,
  });
  const Probe = () => {
    api = useAiFeedbackReview({ firebaseUser: USER, microsoftUpn: upn, addLog: () => {} });
    if (!editorVisible) return null;
    return <FeedbackFieldEditor
      fields={[{ key: 'diaryText', label: 'Diary', placeholder: '', value }, { key: 'vocab', label: 'Vocabulary', placeholder: '', value }]}
      selectedKey={selectedKey} reviewEntryId="entry" availabilityInput={input}
      onChange={onChange} onSelectField={() => {}} onFocusEntry={() => {}}
      ai={api} buildReviewRequest={request} savedRevision={savedRevision} onAvailabilityAction={action}
    />;
  };
  const render = () => act(async () => root.render(<Probe />));
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };

  beforeEach(() => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    onChange = vi.fn(); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    value = TEXT; savedRevision = {}; selectedKey = 'diaryText'; input = { ...INPUT }; upn = 'teacher@uni.edu';
    editorVisible = true;
    action = vi.fn(async () => {});
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('saves once, shows neutral progress, then reviews without changing the text', async () => {
    input = { ...INPUT, entrySaved: false };
    const save = deferred(); action = vi.fn(() => save.promise);
    await render(); await click('Review my feedback');
    await click('Save draft and review');
    expect(container.textContent).toContain('Saving draft…');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    let finishReview!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { finishReview = resolve; }));
    await act(async () => save.resolve());
    expect(container.textContent).toContain('Reviewing your feedback…');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => finishReview(reviewResponse(TEXT)));
    expect(container.textContent).toContain('An effective draft.');
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe(TEXT);
  });

  it('keeps a cached-true server entry error until a real save, and retries a failed save', async () => {
    const first = deferred(); action = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);
    await render();
    // Populate the field error directly; opening the ready pane must not erase it.
    fetchMock.mockResolvedValueOnce(errorResponse('entry_not_saved'));
    await click('Review my feedback');
    expect(container.textContent).toContain('SERVER:entry_not_saved');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click('Save draft and review');
    await act(async () => first.reject(new Error('write failed')));
    expect(container.textContent).toContain("Couldn't save the draft — retry");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(reviewResponse(TEXT));
    await click('Retry');
    expect(action).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('SERVER:entry_not_saved');
    expect(container.textContent).not.toContain("Couldn't save the draft — retry");
    expect(container.textContent).toContain('An effective draft.');
  });

  it('a bottom-bar save clears an entry error even when entrySaved was already true, without reviewing', async () => {
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('entry_not_saved'));
    await click('Review my feedback');
    expect(api.errors[KEY]?.code).toBe('entry_not_saved');
    savedRevision = {}; await render();
    expect(api.errors[KEY]).toBeUndefined();
    expect(container.textContent).not.toContain('SERVER:entry_not_saved');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a successful save fixes the entry prerequisite on its other feedback fields too', async () => {
    await render();
    fetchMock.mockResolvedValue(errorResponse('entry_not_saved'));
    await act(async () => api.review('entry-vocab', request('vocab')));
    await click('Review my feedback');
    expect(api.errors['entry-vocab']).toBeDefined();
    savedRevision = {}; await render();
    expect(api.errors[KEY]).toBeUndefined();
    expect(api.errors['entry-vocab']).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['not_authenticated', 'invalid_firebase_token', 'identity_not_bound'])(
    'explicit successful recovery clears %s despite cached-true prerequisites', async (code) => {
      const recovery = deferred(); action = vi.fn(() => recovery.promise);
      await render(); fetchMock.mockResolvedValueOnce(errorResponse(code)); await click('Review my feedback');
      expect(api.errors[KEY]?.code).toBe(code);
      await click(code === 'identity_not_bound' ? 'Retry linking' : 'Sign in');
      expect(api.errors[KEY]?.code).toBe(code);
      await act(async () => recovery.resolve());
      expect(api.errors[KEY]).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('external linking recovery clears its server error only after bound becomes true again', async () => {
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('identity_not_bound')); await click('Review my feedback');
    expect(api.errors[KEY]?.code).toBe('identity_not_bound');
    input = { ...INPUT, bindingStatus: 'binding' as any }; await render();
    expect(api.errors[KEY]?.code).toBe('identity_not_bound');
    input = { ...INPUT }; await render();
    expect(api.errors[KEY]).toBeUndefined();
  });

  it('a rejected sign-in recovery keeps its server error', async () => {
    action = vi.fn(async () => { throw new Error('cancelled'); });
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('not_authenticated')); await click('Review my feedback');
    await click('Sign in');
    expect(api.errors[KEY]?.code).toBe('not_authenticated');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['model_failed', 'network_error'])('successful unrelated saves preserve %s', async (code) => {
    await render(); fetchMock.mockResolvedValueOnce(errorResponse(code)); await click('Review my feedback');
    savedRevision = {}; await render();
    expect(api.errors[KEY]?.code).toBe(code);
  });

  it('reviews the latest draft after a slow save without overwriting edits', async () => {
    input = { ...INPUT, entrySaved: false };
    const save = deferred(); action = vi.fn(() => save.promise);
    await render(); await click('Review my feedback'); await click('Save draft and review');
    value = `${TEXT} Added while saving.`; await render();
    fetchMock.mockResolvedValueOnce(reviewResponse(value));
    await act(async () => save.resolve());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).feedbackText).toBe(value);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['field', 'account'])('does not continue a save after switching %s', async (change) => {
    input = { ...INPUT, entrySaved: false };
    const save = deferred(); action = vi.fn(() => save.promise);
    await render(); await click('Review my feedback'); await click('Save draft and review');
    if (change === 'field') selectedKey = 'vocab'; else upn = 'other@uni.edu';
    await render(); await act(async () => save.resolve());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the fixed global error after the editor unmounts, without continuing the review', async () => {
    const save = deferred(); action = vi.fn(() => save.promise);
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('entry_not_saved'));
    await click('Review my feedback'); await click('Save draft and review');
    editorVisible = false; await render();
    await act(async () => save.resolve());
    expect(api.errors[KEY]).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    savedRevision = {}; editorVisible = true; await render();
    expect(container.textContent).not.toContain('SERVER:entry_not_saved');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an unmounted old-account save cannot clear the new account’s matching error', async () => {
    const save = deferred(); action = vi.fn(() => save.promise);
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('entry_not_saved'));
    await click('Review my feedback'); await click('Save draft and review');
    editorVisible = false; upn = 'other@uni.edu'; await render();
    fetchMock.mockResolvedValueOnce(errorResponse('entry_not_saved'));
    await act(async () => api.review(KEY, request()));
    await act(async () => save.resolve());
    expect(api.errors[KEY]?.code).toBe('entry_not_saved');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores repeated save clicks while the first save is pending', async () => {
    input = { ...INPUT, entrySaved: false };
    const save = deferred(); action = vi.fn(() => save.promise);
    await render(); await click('Review my feedback');
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save draft and review')!;
    await act(async () => { button.click(); button.click(); });
    expect(action).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(reviewResponse(TEXT));
    await act(async () => save.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a neutral "Waiting for sign-in…" line while a sign-in action is pending', async () => {
    const signIn = deferred(); action = vi.fn(() => signIn.promise);
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('not_authenticated')); await click('Review my feedback');
    await click('Sign in');
    expect(container.textContent).toContain('Waiting for sign-in…');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => signIn.reject(new Error('cancelled')));
    expect(container.textContent).not.toContain('Waiting for sign-in…');
  });

  it('greys the review button while a review is pending', async () => {
    let finish!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    await render(); await click('Review my feedback');
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Review my feedback')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.className).toContain('text-slate-400');
    expect(button.className).not.toContain('text-indigo-600');
    await act(async () => finish(reviewResponse(TEXT)));
  });

  it('shows a busy sign-in message in place of the server error banner', async () => {
    action = vi.fn(async () => { throw new Error('A sign-in window is already open.'); });
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('not_authenticated')); await click('Review my feedback');
    await click('Sign in');
    expect(container.textContent).toContain('A sign-in window is already open.');
    expect(container.textContent).not.toContain('SERVER:not_authenticated');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(api.errors[KEY]?.code).toBe('not_authenticated');
  });

  it('shows a generic sign-in failure message, cleared by the next action', async () => {
    const calls = [new Error('Microsoft sign-in was cancelled. Try again.')];
    action = vi.fn(async () => { const e = calls.shift(); if (e) throw e; });
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('not_authenticated')); await click('Review my feedback');
    await click('Sign in');
    expect(container.textContent).toContain('Microsoft sign-in was cancelled. Try again.');
    await click('Sign in');
    expect(container.textContent).not.toContain('Microsoft sign-in was cancelled. Try again.');
  });

  it('drops a failed-recovery message once linking later succeeds elsewhere', async () => {
    action = vi.fn(async () => { throw new Error('binding failed (503)'); });
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('identity_not_bound')); await click('Review my feedback');
    input = { ...INPUT, bindingStatus: 'binding' as any }; await render();
    await click('Retry linking');
    expect(container.textContent).toContain('binding failed (503)');
    input = { ...INPUT }; await render();
    expect(api.errors[KEY]).toBeUndefined();
    expect(container.textContent).not.toContain('binding failed (503)');
  });

  it('a later review error takes precedence over a stale action error', async () => {
    action = vi.fn(async () => { throw new Error('Microsoft sign-in was cancelled. Try again.'); });
    await render(); fetchMock.mockResolvedValueOnce(errorResponse('not_authenticated')); await click('Review my feedback');
    await click('Sign in');
    expect(container.textContent).toContain('Microsoft sign-in was cancelled. Try again.');
    fetchMock.mockResolvedValueOnce(errorResponse('model_failed')); await click('Review my feedback');
    expect(container.textContent).toContain('SERVER:model_failed');
    expect(container.textContent).not.toContain('Microsoft sign-in was cancelled. Try again.');
  });
});
