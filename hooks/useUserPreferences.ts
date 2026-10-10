import { useState, useEffect } from 'react';
import type { Firestore } from 'firebase/firestore';
import type { FFItemCount, GeminiModel, PriorFeedbackMode, UserPreferences } from '../types';
import { DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS } from '../services/prompts';
import { loadUserPreferences, saveUserPreferences } from '../services/firestoreDataService';

const VALID_GEMINI_MODELS: GeminiModel[] = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash'];

const DEFAULTS: Required<UserPreferences> = {
  ffItemCount: '3-4',
  priorFeedbackMode: 'off',
  feedbackTone: 'specific and supportive',
  teacherDisplayName: '',
  customSignOff: 'Looking forward to your next entry,\n\n[Teacher Name]',
  aiModelFeedback: 'gemini-2.5-flash-lite',
  aiModelParsing: 'gemini-2.5-flash',
  aiPrompts: {
    diaryText: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.diaryText,
    peerFeedback: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.peerFeedback,
    vocab: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.vocab,
    translations: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.translations,
    overall: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.overall,
  },
  exportPresets: [],
};

export interface UseUserPreferencesResult {
  preferences: Required<UserPreferences>;
  preferencesLoading: boolean;
  /** Save one or more preference fields. Optimistic — UI updates immediately. */
  savePref: (updates: Partial<UserPreferences>) => Promise<void>;
  // Named helpers kept for backwards-compat with FeedbackWorkspace 7a wiring.
  saveDefault: (key: 'ffItemCount', value: FFItemCount) => Promise<void>;
  savePriorFeedbackDefault: (value: PriorFeedbackMode) => Promise<void>;
}

export const useUserPreferences = (
  db: Firestore,
  uid: string | undefined
): UseUserPreferencesResult => {
  const [raw, setRaw] = useState<UserPreferences>({});
  const [preferencesLoading, setPreferencesLoading] = useState(true);

  // Load from Firestore on uid change.
  useEffect(() => {
    if (!uid) {
      setPreferencesLoading(false);
      return;
    }
    let cancelled = false;
    setPreferencesLoading(true);
    loadUserPreferences(db, uid)
      .then(prefs => { if (!cancelled) setRaw(prefs); })
      .catch(() => { if (!cancelled) setRaw({}); })
      .finally(() => { if (!cancelled) setPreferencesLoading(false); });
    return () => { cancelled = true; };
  }, [db, uid]);

  // One-time migration: if Firestore document is empty on first load, promote
  // pedagogical fields from legacy localStorage keys (user_config, ai_eval_prompts).
  // The machine-local fields (filterStrings, sync settings) remain in user_config
  // for App.tsx to read as before. ai_eval_prompts is removed after promotion.
  useEffect(() => {
    if (!uid || preferencesLoading) return;
    if (Object.keys(raw).some(k =>
      ['feedbackTone', 'customSignOff', 'aiModelFeedback', 'aiModelParsing', 'aiPrompts'].includes(k) &&
      (raw as any)[k] !== undefined
    )) return; // Already migrated

    const legacyConfig = localStorage.getItem('user_config');
    const legacyPrompts = localStorage.getItem('ai_eval_prompts');
    if (!legacyConfig && !legacyPrompts) return;

    const cfg = legacyConfig ? JSON.parse(legacyConfig) : {};
    const prompts = legacyPrompts ? JSON.parse(legacyPrompts) : null;

    const toMigrate: Partial<UserPreferences> = {};
    if (typeof cfg.feedbackTone === 'string') toMigrate.feedbackTone = cfg.feedbackTone;
    if (typeof cfg.teacherDisplayName === 'string') toMigrate.teacherDisplayName = cfg.teacherDisplayName;
    if (typeof cfg.customSignOff === 'string') toMigrate.customSignOff = cfg.customSignOff;
    if (VALID_GEMINI_MODELS.includes(cfg.aiModelFeedback)) toMigrate.aiModelFeedback = cfg.aiModelFeedback;
    if (VALID_GEMINI_MODELS.includes(cfg.aiModelParsing)) toMigrate.aiModelParsing = cfg.aiModelParsing;
    if (prompts && typeof prompts === 'object') {
      toMigrate.aiPrompts = {
        diaryText: typeof prompts.diaryText === 'string' ? prompts.diaryText : DEFAULTS.aiPrompts.diaryText,
        peerFeedback: typeof prompts.peerFeedback === 'string' ? prompts.peerFeedback : DEFAULTS.aiPrompts.peerFeedback,
        vocab: typeof prompts.vocab === 'string' ? prompts.vocab : DEFAULTS.aiPrompts.vocab,
        translations: typeof prompts.translations === 'string' ? prompts.translations : DEFAULTS.aiPrompts.translations,
        overall: typeof prompts.overall === 'string' ? prompts.overall : DEFAULTS.aiPrompts.overall,
      };
    }

    if (Object.keys(toMigrate).length === 0) return;

    const merged = { ...raw, ...toMigrate };
    setRaw(merged);
    saveUserPreferences(db, uid, merged).then(() => {
      localStorage.removeItem('ai_eval_prompts');
    }).catch(err => console.error('[useUserPreferences] Migration write failed:', err));
  }, [uid, preferencesLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const preferences: Required<UserPreferences> = {
    ffItemCount: raw.ffItemCount ?? DEFAULTS.ffItemCount,
    priorFeedbackMode: raw.priorFeedbackMode ?? DEFAULTS.priorFeedbackMode,
    feedbackTone: raw.feedbackTone ?? DEFAULTS.feedbackTone,
    teacherDisplayName: raw.teacherDisplayName ?? DEFAULTS.teacherDisplayName,
    customSignOff: raw.customSignOff ?? DEFAULTS.customSignOff,
    aiModelFeedback: raw.aiModelFeedback ?? DEFAULTS.aiModelFeedback,
    aiModelParsing: raw.aiModelParsing ?? DEFAULTS.aiModelParsing,
    aiPrompts: { ...DEFAULTS.aiPrompts, ...raw.aiPrompts },
    exportPresets: raw.exportPresets ?? DEFAULTS.exportPresets,
  };

  const savePref = async (updates: Partial<UserPreferences>) => {
    if (!uid) return;
    const updated = { ...raw, ...updates };
    setRaw(updated);
    await saveUserPreferences(db, uid, updated);
  };

  const saveDefault = async (_key: 'ffItemCount', value: FFItemCount) => {
    await savePref({ ffItemCount: value });
  };

  const savePriorFeedbackDefault = async (value: PriorFeedbackMode) => {
    await savePref({ priorFeedbackMode: value });
  };

  return { preferences, preferencesLoading, savePref, saveDefault, savePriorFeedbackDefault };
};
