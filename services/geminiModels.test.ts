import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FEEDBACK_MODEL,
  DEFAULT_PARSING_MODEL,
  GEMINI_MODEL_CATALOG,
  isDeprecatedGeminiModel,
  resolveGeminiModel,
  selectableGeminiModels,
  VALID_GEMINI_MODEL_IDS,
} from './geminiModels';

describe('gemini model catalog', () => {
  it('never offers a retired model as a choice', () => {
    expect(selectableGeminiModels().some((m) => m.deprecated)).toBe(false);
  });

  it('still accepts retired ids from stored preferences', () => {
    // Preferences saved before a retirement must remain valid, or loading them
    // would silently reset the user's model choice.
    expect(VALID_GEMINI_MODEL_IDS).toContain('gemini-2.5-flash');
    expect(isDeprecatedGeminiModel('gemini-2.5-flash')).toBe(true);
  });

  it('resolves a retired model to its live replacement at call time', () => {
    // The 2026-09-01 outage: a saved gemini-2.5-flash preference 404'd on every
    // parse. Resolution happens per call so no Settings visit is required.
    expect(resolveGeminiModel('gemini-2.5-flash')).toBe('gemini-flash-latest');
    expect(resolveGeminiModel('gemini-2.5-flash-lite')).toBe('gemini-flash-lite-latest');
    expect(resolveGeminiModel('gemini-3-flash')).toBe('gemini-flash-latest');
  });

  it('passes a live model through unchanged', () => {
    expect(resolveGeminiModel('gemini-3.6-flash')).toBe('gemini-3.6-flash');
    expect(resolveGeminiModel(DEFAULT_PARSING_MODEL)).toBe(DEFAULT_PARSING_MODEL);
  });

  it('falls back rather than forwarding an unknown id to the API', () => {
    expect(resolveGeminiModel('gemini-does-not-exist')).toBe(DEFAULT_PARSING_MODEL);
    expect(resolveGeminiModel(undefined, DEFAULT_FEEDBACK_MODEL)).toBe(DEFAULT_FEEDBACK_MODEL);
  });

  it('keeps both defaults selectable and current', () => {
    const ids = selectableGeminiModels().map((m) => m.id);
    expect(ids).toContain(DEFAULT_PARSING_MODEL);
    expect(ids).toContain(DEFAULT_FEEDBACK_MODEL);
  });

  it('gives every deprecated entry a replacement', () => {
    for (const model of GEMINI_MODEL_CATALOG.filter((m) => m.deprecated)) {
      expect(model.replacedBy, `${model.id} needs replacedBy`).toBeTruthy();
      expect(isDeprecatedGeminiModel(model.replacedBy)).toBe(false);
    }
  });
});

describe('AI configuration failures are distinguishable from parse misses', () => {
  it('treats a missing API key as a configuration error', async () => {
    // The hosted pilot ships without a Gemini key. Without this, every page
    // would report "no parsed entries available" — indistinguishable from a
    // page that genuinely had nothing to parse.
    const { isGeminiModelUnavailableError } = await import('./geminiService');
    expect(isGeminiModelUnavailableError(new Error('Missing Gemini API key. AI parsing is unavailable.'))).toBe(true);
    expect(isGeminiModelUnavailableError(new Error('label-first parser found no valid entry'))).toBe(false);
  });
});
