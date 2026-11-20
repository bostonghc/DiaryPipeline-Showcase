// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import type { UserPreferences } from '../types';
import { DEFAULT_FIELD_REVIEW_FOCUS } from '../services/aiFeedbackReview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const loadUserPreferences = vi.fn<(...args: unknown[]) => Promise<UserPreferences>>();
const saveUserPreferences = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock('../services/firestoreDataService', () => ({
  loadUserPreferences: (...args: unknown[]) => loadUserPreferences(...args),
  saveUserPreferences: (...args: unknown[]) => saveUserPreferences(...args),
}));

import { useUserPreferences, type UseUserPreferencesResult } from './useUserPreferences';

// Stable identity: the hook reloads whenever `db` changes.
const db = {} as Firestore;
let latest: UseUserPreferencesResult;
const Probe = () => {
  latest = useUserPreferences(db, 'uid-1');
  return null;
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('useUserPreferences saves', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mount = async () => {
    await act(async () => root.render(createElement(Probe)));
  };

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    loadUserPreferences.mockReset();
    saveUserPreferences.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => act(() => root.unmount()));

  it('writes only the changed fields, so another field is never overwritten with a stale value', async () => {
    loadUserPreferences.mockResolvedValue({ feedbackTone: 'kind', customSignOff: 'Thanks' });
    await mount();
    await act(async () => { await latest.savePref({ teacherDisplayName: 'Ms Lee' }); });
    expect(saveUserPreferences).toHaveBeenCalledWith(expect.anything(), 'uid-1', { teacherDisplayName: 'Ms Lee' });
    expect(latest.preferences.teacherDisplayName).toBe('Ms Lee');
    expect(latest.preferences.feedbackTone).toBe('kind');
  });

  it('keeps both changes when two saves overlap', async () => {
    loadUserPreferences.mockResolvedValue({});
    await mount();
    await act(async () => {
      await Promise.all([latest.savePref({ feedbackTone: 'warm' }), latest.savePref({ customSignOff: 'Bye' })]);
    });
    expect(saveUserPreferences).toHaveBeenNthCalledWith(1, expect.anything(), 'uid-1', { feedbackTone: 'warm' });
    expect(saveUserPreferences).toHaveBeenNthCalledWith(2, expect.anything(), 'uid-1', { customSignOff: 'Bye' });
    expect(latest.preferences.feedbackTone).toBe('warm');
    expect(latest.preferences.customSignOff).toBe('Bye');
  });

  it('does not publish new defaults when the write fails', async () => {
    loadUserPreferences.mockResolvedValue({ feedbackTone: 'kind' });
    saveUserPreferences.mockRejectedValue(new Error('offline'));
    await mount();
    await act(async () => {
      await expect(latest.savePref({ feedbackTone: 'stern' })).rejects.toThrow('offline');
    });
    expect(latest.preferences.feedbackTone).toBe('kind');
  });

  it('refuses to save after a failed load, because the form would show defaults, not the stored values', async () => {
    loadUserPreferences.mockRejectedValue(new Error('network'));
    await mount();
    await act(async () => {
      await expect(latest.savePref({ teacherDisplayName: 'Ms Lee' })).rejects.toThrow(/could not be loaded/);
    });
    expect(saveUserPreferences).not.toHaveBeenCalled();
  });
});

describe('useUserPreferences review focus', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    loadUserPreferences.mockReset();
    saveUserPreferences.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => act(() => root.unmount()));

  it('loads the defaults with source "default" when nothing is saved', async () => {
    loadUserPreferences.mockResolvedValue({});
    await act(async () => root.render(createElement(Probe)));
    expect(latest.reviewFocusSource.vocab).toBe('default');
    expect(latest.effectiveReviewFocus.vocab).toBe(DEFAULT_FIELD_REVIEW_FOCUS.vocab);
    expect(Object.keys(latest.effectiveReviewFocus).sort()).toEqual(
      ['chatbot', 'diaryText', 'overall', 'peerFeedback', 'translations', 'vocab']);
  });

  it('never returns saved drafting prompts as review focus', async () => {
    loadUserPreferences.mockResolvedValue({
      aiPrompts: { diaryText: 'Draft it for me', peerFeedback: 'x', vocab: 'y', translations: 'z', overall: 'w' },
    });
    await act(async () => root.render(createElement(Probe)));
    expect(latest.effectiveReviewFocus.diaryText).toBe(DEFAULT_FIELD_REVIEW_FOCUS.diaryText);
    expect(latest.reviewFocusSource.diaryText).toBe('default');
    expect(latest.preferences.aiPrompts.diaryText).toBe('Draft it for me');
  });

  it('reports a saved review focus as custom', async () => {
    loadUserPreferences.mockResolvedValue({ reviewFocus: { overall: 'Be warm' }, reviewFocusVersion: 1 });
    await act(async () => root.render(createElement(Probe)));
    expect(latest.effectiveReviewFocus.overall).toBe('Be warm');
    expect(latest.reviewFocusSource.overall).toBe('custom');
    expect(latest.reviewFocusSource.vocab).toBe('default');
  });
});

describe('useUserPreferences account scope and legacy migration', () => {
  let root: Root;
  let uid: string | undefined;
  let renders: Array<{ name: string; loading: boolean }>;
  const ScopedProbe = () => {
    latest = useUserPreferences(db, uid);
    renders.push({ name: latest.preferences.teacherDisplayName, loading: latest.preferencesLoading });
    return null;
  };
  const render = () => act(async () => root.render(createElement(ScopedProbe)));

  beforeEach(() => {
    root = createRoot(document.createElement('div'));
    uid = 'alice';
    renders = [];
    localStorage.clear();
    loadUserPreferences.mockReset();
    saveUserPreferences.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    act(() => root.unmount());
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([false, true])('ignores an old save after an account change (return to original: %s)', async returnToOriginal => {
    const write = deferred<void>();
    loadUserPreferences
      .mockResolvedValueOnce({ teacherDisplayName: 'Alice', feedbackTone: 'warm' })
      .mockResolvedValueOnce({ teacherDisplayName: 'Bob', feedbackTone: 'direct' })
      .mockResolvedValueOnce({ teacherDisplayName: 'Alice reloaded', feedbackTone: 'warm' });
    saveUserPreferences.mockReturnValueOnce(write.promise);
    await render();
    let saving!: Promise<void>;
    await act(async () => { saving = latest.savePref({ teacherDisplayName: 'Old Alice edit' }); });
    uid = 'bob'; await render();
    if (returnToOriginal) { uid = 'alice'; await render(); }
    const expected = returnToOriginal ? 'Alice reloaded' : 'Bob';
    expect(latest.preferences.teacherDisplayName).toBe(expected);
    await act(async () => { write.resolve(); await saving; });
    expect(latest.preferences.teacherDisplayName).toBe(expected);
    expect(saveUserPreferences).toHaveBeenCalledWith(db, 'alice', { teacherDisplayName: 'Old Alice edit' });
  });

  it('rejects an old account’s saved callback before it writes', async () => {
    loadUserPreferences.mockResolvedValue({ feedbackTone: 'warm' });
    await render();
    const oldSave = latest.savePref;
    uid = 'bob'; await render();
    await expect(oldSave({ teacherDisplayName: 'Alice' })).rejects.toThrow(/account changed/i);
    expect(saveUserPreferences).not.toHaveBeenCalled();
  });

  it('clears visible preferences on sign-out', async () => {
    loadUserPreferences.mockResolvedValue({ teacherDisplayName: 'Alice', feedbackTone: 'warm' });
    await render();
    uid = undefined; await render();
    expect(latest.preferences.teacherDisplayName).toBe('');
    expect(latest.preferencesLoading).toBe(false);
  });

  it('hides the old account’s preferences in the first render while the next account loads', async () => {
    const read = deferred<UserPreferences>();
    loadUserPreferences.mockResolvedValueOnce({ teacherDisplayName: 'Alice', feedbackTone: 'warm' }).mockReturnValueOnce(read.promise);
    await render();
    renders = []; uid = 'bob'; await render();
    expect(renders[0]).toEqual({ name: '', loading: true });
    await act(async () => read.resolve({ teacherDisplayName: 'Bob', feedbackTone: 'direct' }));
    expect(latest.preferences.teacherDisplayName).toBe('Bob');
  });

  it('refuses saves while this account’s preferences are still loading', async () => {
    const read = deferred<UserPreferences>();
    loadUserPreferences.mockReturnValueOnce(read.promise);
    await render();
    await expect(latest.savePref({ teacherDisplayName: 'Alice' })).rejects.toThrow(/loading/i);
    expect(saveUserPreferences).not.toHaveBeenCalled();
    await act(async () => read.resolve({ feedbackTone: 'stored tone' }));
  });

  it('does not migrate legacy values after a failed read', async () => {
    localStorage.setItem('user_config', JSON.stringify({ feedbackTone: 'legacy tone', customSignOff: 'legacy closing' }));
    localStorage.setItem('ai_eval_prompts', JSON.stringify({ diaryText: 'old instructions' }));
    loadUserPreferences.mockRejectedValue(new Error('offline'));
    await render();
    expect(saveUserPreferences).not.toHaveBeenCalled();
    expect(latest.preferences.feedbackTone).toBe('specific and supportive');
    expect(localStorage.getItem('ai_eval_prompts')).not.toBeNull();
    await expect(latest.savePref({ teacherDisplayName: 'Alice' })).rejects.toThrow(/could not be loaded/);
  });

  it('waits for successful migration before exposing migrated preferences or accepting edits', async () => {
    const write = deferred<void>();
    localStorage.setItem('user_config', JSON.stringify({ feedbackTone: 'legacy tone' }));
    localStorage.setItem('ai_eval_prompts', JSON.stringify({ diaryText: 'old instructions' }));
    loadUserPreferences.mockResolvedValue({});
    saveUserPreferences.mockReturnValueOnce(write.promise);
    await render();
    expect(latest.preferencesLoading).toBe(true);
    expect(latest.preferences.feedbackTone).toBe('specific and supportive');
    expect(localStorage.getItem('ai_eval_prompts')).not.toBeNull();
    await expect(latest.savePref({ feedbackTone: 'manual edit' })).rejects.toThrow(/loading/i);
    await act(async () => write.resolve());
    expect(latest.preferencesLoading).toBe(false);
    expect(latest.preferences.feedbackTone).toBe('legacy tone');
    expect(latest.preferences.aiPrompts.diaryText).toBe('old instructions');
    expect(localStorage.getItem('ai_eval_prompts')).toBeNull();
  });

  it('keeps legacy data and stored defaults when migration persistence fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('user_config', JSON.stringify({ feedbackTone: 'legacy tone' }));
    localStorage.setItem('ai_eval_prompts', JSON.stringify({ diaryText: 'old instructions' }));
    loadUserPreferences.mockResolvedValue({});
    saveUserPreferences.mockRejectedValueOnce(new Error('write failed'));
    await render();
    expect(latest.preferencesLoading).toBe(false);
    expect(latest.preferences.feedbackTone).toBe('specific and supportive');
    expect(localStorage.getItem('ai_eval_prompts')).not.toBeNull();
    await act(async () => latest.savePref({ feedbackTone: 'manual edit' }));
    expect(latest.preferences.feedbackTone).toBe('manual edit');
  });

  it('leaves malformed legacy storage untouched and still finishes a successful preferences read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('ai_eval_prompts', '{invalid json');
    loadUserPreferences.mockResolvedValue({});
    await render();
    expect(latest.preferencesLoading).toBe(false);
    expect(saveUserPreferences).not.toHaveBeenCalled();
    expect(localStorage.getItem('ai_eval_prompts')).toBe('{invalid json');
  });

  it('does not publish or clear legacy storage after an old account’s migration finishes', async () => {
    const write = deferred<void>();
    localStorage.setItem('user_config', JSON.stringify({ feedbackTone: 'legacy tone' }));
    localStorage.setItem('ai_eval_prompts', JSON.stringify({ diaryText: 'old instructions' }));
    loadUserPreferences.mockResolvedValueOnce({}).mockResolvedValueOnce({ teacherDisplayName: 'Bob', feedbackTone: 'direct' });
    saveUserPreferences.mockReturnValueOnce(write.promise);
    await render();
    uid = 'bob'; await render();
    await act(async () => write.resolve());
    expect(latest.preferences.teacherDisplayName).toBe('Bob');
    expect(latest.preferences.feedbackTone).toBe('direct');
    expect(localStorage.getItem('ai_eval_prompts')).not.toBeNull();
    expect(saveUserPreferences).toHaveBeenCalledTimes(1);
  });
});
