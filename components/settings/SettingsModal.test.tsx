// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { CollaborationAccessProvider } from '../../hooks/useCollaborationAccess';
import { resolveCollaborationAccess, type CollaborationRole } from '../../services/collaborationAccess';
import { DEFAULT_FEEDBACK_MODEL, DEFAULT_PARSING_MODEL } from '../../services/geminiModels';
import type { UserPreferences } from '../../types';
import { DEFAULT_FIELD_REVIEW_FOCUS } from '../../services/aiFeedbackReview';
import { DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS } from '../../services/prompts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const preferences: Required<UserPreferences> = {
  ffItemCount: '3-4', priorFeedbackMode: 'off', feedbackTone: 'specific and supportive',
  teacherDisplayName: '', customSignOff: 'Thanks,\n[Teacher Name]',
  aiModelFeedback: DEFAULT_FEEDBACK_MODEL, aiModelParsing: DEFAULT_PARSING_MODEL,
  aiPrompts: { diaryText: 'Diary prompt', peerFeedback: 'Peer prompt', vocab: 'Vocab prompt', translations: 'Translation prompt', overall: 'Overall prompt' },
  reviewFocus: {}, reviewFocusVersion: 1,
  exportPresets: [],
};

let container: HTMLDivElement;
let root: Root;
let savePref = vi.fn<(updates: Partial<UserPreferences>) => Promise<void>>();

const render = async (role: CollaborationRole, overrides: Partial<React.ComponentProps<typeof SettingsModal>> = {}) => {
  const username = `${role}@example.edu`;
  const profile = resolveCollaborationAccess({ pilotEnabled: true, ownerUpns: ['owner@example.edu'], leadUpns: ['lead@example.edu'], pilotClassIds: ['class-a'], aiReviewRoles: [] }, { username }, [{ id: 'class-a' }]);
  const noop = vi.fn();
  await act(async () => root.render(
    <CollaborationAccessProvider value={{ account: { username, localAccountId: role, homeAccountId: role }, profile,
      lastKnownRole: role, status: 'ready', error: null, isClassAllowed: () => true, refresh: noop, clear: noop }}>
      <SettingsModal machineConfig={{ filterStrings: [], syncFrequency: 'manual', syncBatchSize: 2, syncDelayBetweenBatches: 2000 }}
        setMachineConfig={noop} preferences={{ ...preferences, aiPrompts: { ...preferences.aiPrompts } }} savePref={savePref}
        config={{ isSandbox: false }} setConfig={noop}
        connectionState={{ microsoftSignedIn: true, microsoftLabel: username, firebaseSignedIn: true,
          firebaseLabel: 'Saved records', firebaseProjectId: 'test', hasGeminiKey: false }}
        onMicrosoftLogin={noop} onMicrosoftLogout={noop} onFirebaseLogin={noop} onFirebaseLogout={noop} onSelectGeminiKey={noop}
        addLog={noop} logs={[]} setLogs={noop} onSaveLog={noop} showDebugStream={false} setShowDebugStream={noop}
        isInteracting={false} hasDebugActivity={false} onClose={noop} {...overrides} />
    </CollaborationAccessProvider>
  ));
};

const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
};

const change = async (id: string, text: string) => {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  savePref = vi.fn<(updates: Partial<UserPreferences>) => Promise<void>>().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('review focus settings', () => {
  const customPrompts = { diaryText: 'Write the diary feedback for me', peerFeedback: 'Peer prompt', vocab: 'Vocab prompt', translations: 'Translation prompt', overall: 'Overall prompt' };
  const withDefaults: Required<UserPreferences> = { ...preferences, aiPrompts: { ...DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS } as Required<UserPreferences>['aiPrompts'] };

  it('shows six editable review-focus fields with the reviewer defaults and the new help text', async () => {
    await render('intern', { preferences: withDefaults });
    await click('Prompts');
    for (const key of ['diaryText', 'peerFeedback', 'vocab', 'translations', 'chatbot', 'overall'] as const) {
      expect(container.querySelector<HTMLTextAreaElement>(`#settings-review-focus-${key}`)!.value).toBe(DEFAULT_FIELD_REVIEW_FOCUS[key]);
    }
    expect(container.textContent).toContain('Chatbot');
    expect(container.textContent).toContain('These instructions tell the AI reviewer what good feedback on each field should do. The reviewer comments on your feedback; it never writes to students.');
    expect(container.textContent).not.toContain('Your earlier drafting instructions');
  });

  it('shows earlier custom drafting text read-only, never as review focus', async () => {
    await render('intern', { preferences: { ...preferences, aiPrompts: customPrompts } });
    await click('Prompts');
    expect(container.textContent).toContain('Your earlier drafting instructions (no longer used)');
    expect(container.textContent).toContain('Write the diary feedback for me');
    expect(container.querySelector<HTMLTextAreaElement>('#settings-review-focus-diaryText')!.value).toBe(DEFAULT_FIELD_REVIEW_FOCUS.diaryText);
    expect(container.querySelector('#settings-prompt-diaryText')).toBeNull();
    expect([...container.querySelectorAll('textarea')].some(t => t.value === 'Write the diary feedback for me')).toBe(false);
  });

  it('copies earlier text into review focus on request, and saves it with the version', async () => {
    await render('intern', { preferences: { ...preferences, aiPrompts: customPrompts } });
    await click('Prompts');
    const copyButtons = [...container.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Copy into review focus');
    expect(copyButtons.length).toBe(5);
    await act(async () => copyButtons[0].click());
    expect(container.querySelector<HTMLTextAreaElement>('#settings-review-focus-diaryText')!.value).toBe('Write the diary feedback for me');
    await click('Save Preferences');
    expect(savePref).toHaveBeenCalledWith(expect.objectContaining({
      reviewFocus: { diaryText: 'Write the diary feedback for me' }, reviewFocusVersion: 1 }));
    expect(savePref.mock.calls[0][0]).not.toHaveProperty('aiPrompts');
  });

  it('truncates copied earlier text to the 2000-character review focus limit', async () => {
    const long = 'x'.repeat(2500);
    await render('intern', { preferences: { ...preferences, aiPrompts: { ...customPrompts, diaryText: long } } });
    await click('Prompts');
    const copyButtons = [...container.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Copy into review focus');
    await act(async () => copyButtons[0].click());
    expect(container.querySelector<HTMLTextAreaElement>('#settings-review-focus-diaryText')!.value.length).toBe(2000);
  });

  it('limits the tone input to 200 characters', async () => {
    await render('intern');
    await click('Feedback');
    expect(container.querySelector<HTMLInputElement>('#settings-feedback-tone')!.maxLength).toBe(200);
  });

  it('limits review focus to 2000 and tone to 200, with a counter on review focus', async () => {
    await render('intern');
    await click('Prompts');
    const ta = container.querySelector<HTMLTextAreaElement>('#settings-review-focus-diaryText')!;
    expect(ta.maxLength).toBe(2000);
    expect(container.textContent).toContain(`${ta.value.length} / 2000`);
  });

  it('shows the default for a stored blank value and is not left dirty after Reset + save', async () => {
    const blank = { ...withDefaults, reviewFocus: { vocab: '', overall: '  ' } };
    await render('intern', { preferences: blank });
    await click('Prompts');
    expect(container.querySelector<HTMLTextAreaElement>('#settings-review-focus-vocab')!.value).toBe(DEFAULT_FIELD_REVIEW_FOCUS.vocab);
    expect(container.querySelector<HTMLTextAreaElement>('#settings-review-focus-overall')!.value).toBe(DEFAULT_FIELD_REVIEW_FOCUS.overall);
    const save = () => [...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save Preferences')!;
    expect(save().disabled).toBe(true);
    const customised = { ...withDefaults, reviewFocus: { vocab: 'Mine' } };
    await render('intern', { preferences: customised });
    const vocabReset = [...container.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Reset')[2];
    await act(async () => vocabReset.click());
    await click('Save Preferences');
    expect(savePref).toHaveBeenCalledWith(expect.objectContaining({ reviewFocus: { vocab: '' } }));
    await render('intern', { preferences: { ...customised, reviewFocus: { vocab: '' } } });
    expect(save().disabled).toBe(true);
  });

  it('says tone and the model and item-count controls apply to AI review', async () => {
    await render('owner');
    await click('Feedback');
    expect(container.textContent).toContain("Tells the AI reviewer the tone you're aiming for.");
    await click('AI Models');
    expect(container.textContent).toContain('AI Review Model');
    expect(container.textContent).toContain('applies to AI review');
  });
});

describe('personal feedback settings', () => {
  it.each(['intern', 'lead'] as const)('lets the %s save tone and closing without owner setup', async role => {
    await render(role);
    expect(container.textContent).toContain('Your feedback preferences');
    expect(container.textContent).not.toContain('Runtime Config');
    expect(container.textContent).not.toContain('AI Models');
    expect(container.textContent).not.toContain('Debug Stream');
    expect(fetch).not.toHaveBeenCalled();
    await change('settings-feedback-tone', 'warm and concise');
    await change('settings-custom-signoff', 'See you next week!\n[Teacher Name]');
    await render(role); // Parent activity creates a fresh preferences object.
    expect(container.querySelector<HTMLInputElement>('#settings-feedback-tone')!.value).toBe('warm and concise');
    await click('Save Preferences');
    expect(savePref).toHaveBeenCalledWith({ feedbackTone: 'warm and concise', teacherDisplayName: '',
      customSignOff: 'See you next week!\n[Teacher Name]', reviewFocus: {}, reviewFocusVersion: 1 });
    expect(container.textContent).toContain('Preferences saved');
    await click('Prompts');
    expect(container.textContent).toContain('AI Review Focus');
  });

  it('retains owner setup and puts personal preferences on the Feedback tab', async () => {
    await render('owner');
    expect(container.textContent).toContain('Runtime Config');
    expect(container.textContent).toContain('AI Models');
    await click('Feedback');
    expect(container.querySelector('#settings-custom-signoff')).not.toBeNull();
    await click('AI Models');
    expect(container.querySelector('#settings-ai-parsing-model')).not.toBeNull();
    expect(container.querySelector('#settings-custom-signoff')).toBeNull();
  });

  it('keeps personal settings visible and explains how to reconnect saved records', async () => {
    await render('intern', { connectionState: { microsoftSignedIn: true, microsoftLabel: 'Intern', firebaseSignedIn: false,
      firebaseLabel: null, firebaseProjectId: 'test', hasGeminiKey: false } });
    expect(container.textContent).toContain('Connect saved records to load and save your feedback preferences.');
    await change('settings-custom-signoff', 'My closing');
    const save = [...container.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save Preferences')!;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe('Connect saved records to load and save your feedback preferences.');
    await click('Save Preferences');
    expect(savePref).not.toHaveBeenCalled();
    expect(container.querySelector('#settings-custom-signoff')).not.toBeNull();
  });

  it('holds the preference fields until saved preferences finish loading, so typing is never replaced', async () => {
    await render('intern', { preferencesLoading: true });
    expect(container.textContent).toContain('Wait for your saved preferences to finish loading.');
    expect(container.querySelector<HTMLTextAreaElement>('#settings-custom-signoff')!.closest('fieldset')!.disabled).toBe(true);
    await render('intern', { preferencesLoading: false, preferences: { ...preferences, customSignOff: 'Loaded closing' } });
    const signoff = container.querySelector<HTMLTextAreaElement>('#settings-custom-signoff')!;
    expect(signoff.closest('fieldset')!.disabled).toBe(false);
    expect(signoff.value).toBe('Loaded closing');
  });

  it('keeps unsaved edits and a useful error if persistence fails', async () => {
    savePref.mockRejectedValue(new Error('Connection interrupted'));
    await render('intern');
    await change('settings-custom-signoff', 'My closing');
    await click('Save Preferences');
    expect(container.textContent).toContain('Connection interrupted');
    expect(container.querySelector<HTMLTextAreaElement>('#settings-custom-signoff')!.value).toBe('My closing');
    expect(container.textContent).not.toContain('Preferences saved');
  });
});
