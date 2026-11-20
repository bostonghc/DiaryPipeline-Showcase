import { useState, useEffect, useRef } from 'react';
import type { Firestore } from 'firebase/firestore';
import type { FFItemCount, GeminiModel, PriorFeedbackMode, UserPreferences } from '../types';
import { DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS } from '../services/prompts';
import { DEFAULT_FIELD_REVIEW_FOCUS, type AiReviewFieldKey } from '../services/aiFeedbackReview';
import { effectiveReviewFocus, type ReviewFocusSource } from '../services/reviewFocus';
import { loadUserPreferences, saveUserPreferences } from '../services/firestoreDataService';
import {
  DEFAULT_FEEDBACK_MODEL,
  DEFAULT_PARSING_MODEL,
  VALID_GEMINI_MODEL_IDS,
} from '../services/geminiModels';

const VALID_GEMINI_MODELS: GeminiModel[] = VALID_GEMINI_MODEL_IDS;

const DEFAULTS: Required<UserPreferences> = {
  ffItemCount: '3-4',
  priorFeedbackMode: 'off',
  feedbackTone: 'specific and supportive',
  teacherDisplayName: '',
  customSignOff: 'Looking forward to your next entry,\n\n[Teacher Name]',
  aiModelFeedback: DEFAULT_FEEDBACK_MODEL,
  aiModelParsing: DEFAULT_PARSING_MODEL,
  aiPrompts: {
    diaryText: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.diaryText,
    peerFeedback: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.peerFeedback,
    vocab: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.vocab,
    translations: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.translations,
    overall: DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS.overall,
  },
  reviewFocus: {},
  reviewFocusVersion: 1,
  exportPresets: [],
};

export interface UseUserPreferencesResult {
  preferences: Required<UserPreferences>;
  /** Effective review focus text per field: saved custom text, else the reviewer default. */
  effectiveReviewFocus: Record<AiReviewFieldKey, string>;
  /** Whether each field's effective focus is the default or the teacher's own. */
  reviewFocusSource: Record<AiReviewFieldKey, ReviewFocusSource>;
  preferencesLoading: boolean;
  /** Save preference fields; publish the new defaults only after persistence succeeds. */
  savePref: (updates: Partial<UserPreferences>) => Promise<void>;
  // Named helpers kept for backwards-compat with FeedbackWorkspace 7a wiring.
  saveDefault: (key: 'ffItemCount', value: FFItemCount) => Promise<void>;
  savePriorFeedbackDefault: (value: PriorFeedbackMode) => Promise<void>;
}

/** Called only after this account's Firestore read succeeds. */
const legacyPreferenceMigration = (raw: UserPreferences) => {
  if (Object.keys(raw).some(k =>
    ['feedbackTone', 'customSignOff', 'aiModelFeedback', 'aiModelParsing', 'aiPrompts'].includes(k) &&
    (raw as any)[k] !== undefined
  )) return null; // Already migrated

  const legacyConfig = localStorage.getItem('user_config');
  const legacyPrompts = localStorage.getItem('ai_eval_prompts');
  if (!legacyConfig && !legacyPrompts) return null;

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

  return Object.keys(toMigrate).length ? { updates: toMigrate, legacyPrompts } : null;
};

interface LoadedPreferences {
  epoch: number;
  raw: UserPreferences;
  loading: boolean;
  loadFailed: boolean;
}

export const useUserPreferences = (
  db: Firestore,
  uid: string | undefined
): UseUserPreferencesResult => {
  // An epoch distinguishes A -> B -> A as well as a different account/database.
  // Mask old values during the first render of a new scope, before effects run.
  const scope = useRef({ db, uid, epoch: 0 });
  if (scope.current.db !== db || scope.current.uid !== uid) {
    scope.current = { db, uid, epoch: scope.current.epoch + 1 };
  }
  const epoch = scope.current.epoch;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isCurrent = () => mounted.current && scope.current.epoch === epoch;
  const [loaded, setLoaded] = useState<LoadedPreferences>({ epoch, raw: {}, loading: !!uid, loadFailed: false });
  const live = loaded.epoch === epoch;
  const raw = live ? loaded.raw : {};
  const preferencesLoading = !!uid && (!live || loaded.loading);
  const loadFailed = live && loaded.loadFailed;

  // Reading and optional legacy migration are one initialisation step. Never
  // treat a failed read as an empty document, or accept manual saves mid-migration.
  useEffect(() => {
    let cancelled = false;
    const current = () => !cancelled && isCurrent();
    setLoaded({ epoch, raw: {}, loading: !!uid, loadFailed: false });
    if (uid) void (async () => {
      let prefs: UserPreferences;
      try {
        prefs = await loadUserPreferences(db, uid);
      } catch {
        if (current()) setLoaded({ epoch, raw: {}, loading: false, loadFailed: true });
        return;
      }
      if (!current()) return;
      // Machine-local fields stay in user_config. Earlier drafting prompts are
      // retained read-only, and their local key is removed only after persistence.
      try {
        const migration = legacyPreferenceMigration(prefs);
        if (migration) {
          await saveUserPreferences(db, uid, migration.updates);
          if (!current()) return;
          prefs = { ...prefs, ...migration.updates };
          if (localStorage.getItem('ai_eval_prompts') === migration.legacyPrompts) {
            localStorage.removeItem('ai_eval_prompts');
          }
        }
      } catch (error) {
        if (!current()) return;
        console.error('[useUserPreferences] Legacy migration failed:', error);
      }
      if (current()) setLoaded({ epoch, raw: prefs, loading: false, loadFailed: false });
    })();
    return () => { cancelled = true; };
    // isCurrent closes over this epoch; refs supply the live mount/scope check.
  }, [db, uid, epoch]);

  const preferences: Required<UserPreferences> = {
    ffItemCount: raw.ffItemCount ?? DEFAULTS.ffItemCount,
    priorFeedbackMode: raw.priorFeedbackMode ?? DEFAULTS.priorFeedbackMode,
    feedbackTone: raw.feedbackTone ?? DEFAULTS.feedbackTone,
    teacherDisplayName: raw.teacherDisplayName ?? DEFAULTS.teacherDisplayName,
    customSignOff: raw.customSignOff ?? DEFAULTS.customSignOff,
    aiModelFeedback: raw.aiModelFeedback ?? DEFAULTS.aiModelFeedback,
    aiModelParsing: raw.aiModelParsing ?? DEFAULTS.aiModelParsing,
    aiPrompts: { ...DEFAULTS.aiPrompts, ...raw.aiPrompts },
    reviewFocus: { ...raw.reviewFocus },
    reviewFocusVersion: 1,
    exportPresets: raw.exportPresets ?? DEFAULTS.exportPresets,
  };

  const effective = {} as Record<AiReviewFieldKey, string>;
  const sources = {} as Record<AiReviewFieldKey, ReviewFocusSource>;
  for (const field of Object.keys(DEFAULT_FIELD_REVIEW_FOCUS) as AiReviewFieldKey[]) {
    const e = effectiveReviewFocus(preferences, field);
    effective[field] = e.text;
    sources[field] = e.source;
  }

  const savePref = async (updates: Partial<UserPreferences>) => {
    if (!isCurrent()) {
      throw new Error('Your saved-records account changed. Try saving again from the current account.');
    }
    if (!uid) {
      throw new Error('Cannot save preferences until Firestore is connected.');
    }
    if (loadFailed) {
      throw new Error('Your saved preferences could not be loaded, so saving now could overwrite them. Reload the page and try again.');
    }
    if (preferencesLoading) {
      throw new Error('Your saved preferences are still loading. Wait a moment and try again.');
    }
    // Write only the fields being changed (setDoc merges at the top level).
    // Sending the whole render-time `raw` would overwrite fields changed by
    // another save in flight, or by useExportPresets, with stale values.
    await saveUserPreferences(db, uid, updates);
    if (!isCurrent()) return;
    setLoaded(current => current.epoch === epoch && isCurrent()
      ? { ...current, raw: { ...current.raw, ...updates } }
      : current);
  };

  const saveDefault = async (_key: 'ffItemCount', value: FFItemCount) => {
    await savePref({ ffItemCount: value });
  };

  const savePriorFeedbackDefault = async (value: PriorFeedbackMode) => {
    await savePref({ priorFeedbackMode: value });
  };

  return { preferences, effectiveReviewFocus: effective, reviewFocusSource: sources, preferencesLoading, savePref, saveDefault, savePriorFeedbackDefault };
};
