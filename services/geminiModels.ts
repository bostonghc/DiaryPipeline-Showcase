// Single source of truth for Gemini model choices.
//
// DECISION (2026-09-01): model ids were previously duplicated across five files
// — the `GeminiModel` union, two `<select>` lists in SettingsModal, the
// preferences defaults, and a second validation copy in firestoreDataService.
// They drifted (a newer model was labelled "Legacy fallback"), and when Google
// retired gemini-2.5-flash every parse failed with a silent 404. Everything now
// reads this catalog, so a model change is a one-line edit here.
//
// Defaults are the floating "-latest" aliases rather than pinned versions. The
// trade-off is deliberate: label-first parsing is the primary path and AI is an
// explicit fallback whose output is validated by passOneQualityCheck and
// validateParsedEntry, so gradual quality drift degrades into a warning, while a
// pinned-then-retired model is a hard outage with no output at all. Pinned ids
// stay selectable for anyone who needs reproducible behaviour.

/**
 * Whether this build can call Gemini at all. vite bakes the key into the
 * browser bundle, so the hosted pilot deliberately ships without one
 * (docs/collaboration-pilot-deployment.md) and every AI path is unavailable
 * there. Callers use this to steer people away from AI rather than letting
 * each attempt fail.
 */
export const isGeminiAvailable = (): boolean =>
  Boolean(process.env.BROWSER_GEMINI_API_KEY);

export type GeminiModelTier = 'flash' | 'flash-lite';

export interface GeminiModelOption {
  id: string;
  label: string;
  tier: GeminiModelTier;
  /** 'alias' tracks Google's current release; 'pinned' is a fixed version. */
  kind: 'alias' | 'pinned';
  /** Retired upstream. Kept so stored preferences still validate, but never offered. */
  deprecated?: boolean;
  /** Live model a deprecated id resolves to at call time. */
  replacedBy?: string;
}

// Verified against the project's ListModels response on 2026-09-01. Only text
// models are listed: image, TTS, audio, embedding, video and research models
// exist on the API but are not parsing or drafting targets.
export const GEMINI_MODEL_CATALOG: readonly GeminiModelOption[] = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash (Latest)', tier: 'flash', kind: 'alias' },
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash Lite (Latest)', tier: 'flash-lite', kind: 'alias' },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash (Pinned)', tier: 'flash', kind: 'pinned' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash (Pinned)', tier: 'flash', kind: 'pinned' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (Pinned)', tier: 'flash', kind: 'pinned' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite (Pinned)', tier: 'flash-lite', kind: 'pinned' },

  // Unavailable to this project since 2026-09-01. The API still lists
  // gemini-2.5-flash, but returns 404 "no longer available to new users" for
  // this key — indistinguishable from a retirement at the call site.
  // gemini-3-flash was never a real id; only gemini-3-flash-preview exists.
  // Retained so stored preferences stay valid and auto-upgrade at call time.
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Unavailable)', tier: 'flash', kind: 'pinned', deprecated: true, replacedBy: 'gemini-flash-latest' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (Unavailable)', tier: 'flash-lite', kind: 'pinned', deprecated: true, replacedBy: 'gemini-flash-lite-latest' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash (Unavailable)', tier: 'flash', kind: 'pinned', deprecated: true, replacedBy: 'gemini-flash-latest' },
];

export const DEFAULT_PARSING_MODEL = 'gemini-flash-latest';
export const DEFAULT_FEEDBACK_MODEL = 'gemini-flash-lite-latest';

/** Every id the app will accept from storage, retired ones included. */
export const VALID_GEMINI_MODEL_IDS: string[] = GEMINI_MODEL_CATALOG.map((m) => m.id);

/** Models offered in the UI — retired ids are never presented as a choice. */
export const selectableGeminiModels = (): GeminiModelOption[] =>
  GEMINI_MODEL_CATALOG.filter((model) => !model.deprecated);

export const findGeminiModel = (id: string | undefined): GeminiModelOption | undefined =>
  GEMINI_MODEL_CATALOG.find((model) => model.id === id);

export const isDeprecatedGeminiModel = (id: string | undefined): boolean =>
  findGeminiModel(id)?.deprecated === true;

/**
 * Map a stored preference to the id actually sent to the API.
 *
 * A saved preference naming a retired model must not break parsing until the
 * user happens to open Settings, so retirement is resolved at call time.
 * Unknown ids fall back to the tier default rather than being forwarded to the
 * API, which would 404.
 */
export const resolveGeminiModel = (
  id: string | undefined,
  fallback: string = DEFAULT_PARSING_MODEL
): string => {
  const model = findGeminiModel(id);
  if (!model) return fallback;
  if (model.deprecated) return model.replacedBy || fallback;
  return model.id;
};
