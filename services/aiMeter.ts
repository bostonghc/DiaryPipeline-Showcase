// Lightweight, in-memory AI call meter for diagnostics / bug hunting.
//
// This tracks actual provider API attempts, not pages parsed or UI actions.
// A single diary page can produce multiple attempts when parsing uses pass 2
// or when the provider retries after a transient/rate-limit error.

export type AiCallPurpose =
  | 'gemini:parse:pass1'
  | 'gemini:parse:pass2'
  | 'gemini:feedback-draft'
  | 'gemini:analysis';

export type AiCallOutcome =
  | 'succeeded'
  | 'billing_or_project_restricted'
  | 'rate_limited'
  | 'retryable_error'
  | 'failed';

export type AiErrorSample = {
  at: string;
  purpose: AiCallPurpose | 'unknown';
  model: string;
  outcome: Exclude<AiCallOutcome, 'succeeded'>;
  message: string;
};

let totalAttempts = 0;
const byPurpose: Record<string, number> = {};
const byModel: Record<string, number> = {};
const byOutcome: Record<string, number> = {};
const errorSamples: AiErrorSample[] = [];
let sessionStart = Date.now();
const MAX_ERROR_SAMPLES = 5;

export const recordAiAttempt = (purpose: AiCallPurpose, model: string): void => {
  totalAttempts += 1;
  byPurpose[purpose] = (byPurpose[purpose] || 0) + 1;
  byModel[model] = (byModel[model] || 0) + 1;
};

const sanitizeErrorMessage = (message: string): string =>
  message
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted-token]')
    .replace(/key=([^&\s]+)/gi, 'key=[redacted-api-key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);

const errorToMessage = (error: unknown): string => {
  if (error instanceof Error) {
    const details = error as Error & {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      details?: unknown;
    };
    const parts = [
      error.name,
      error.message,
      details.status != null ? `status=${String(details.status)}` : '',
      details.statusCode != null ? `statusCode=${String(details.statusCode)}` : '',
      details.code != null ? `code=${String(details.code)}` : '',
      details.details != null ? `details=${String(details.details)}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
  }

  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error || 'Unknown provider error');
};

export const recordAiOutcome = (
  outcome: AiCallOutcome,
  sample?: {
    purpose?: AiCallPurpose;
    model?: string;
    error?: unknown;
  }
): void => {
  byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;

  if (outcome === 'succeeded' || sample?.error == null) return;
  errorSamples.unshift({
    at: new Date().toISOString(),
    purpose: sample.purpose || 'unknown',
    model: sample.model || 'unknown',
    outcome,
    message: sanitizeErrorMessage(errorToMessage(sample.error)),
  });
  errorSamples.splice(MAX_ERROR_SAMPLES);
};

export type AiTotals = {
  totalAttempts: number;
  byPurpose: Record<string, number>;
  byModel: Record<string, number>;
  byOutcome: Record<string, number>;
  errorSamples: AiErrorSample[];
  startedAt: number;
  sinceMs: number;
};

export const getAiTotals = (): AiTotals => ({
  totalAttempts,
  byPurpose: { ...byPurpose },
  byModel: { ...byModel },
  byOutcome: { ...byOutcome },
  errorSamples: errorSamples.map((sample) => ({ ...sample })),
  startedAt: sessionStart,
  sinceMs: Date.now() - sessionStart,
});

export const resetAiMeter = (): void => {
  totalAttempts = 0;
  for (const key of Object.keys(byPurpose)) delete byPurpose[key];
  for (const key of Object.keys(byModel)) delete byModel[key];
  for (const key of Object.keys(byOutcome)) delete byOutcome[key];
  errorSamples.splice(0);
  sessionStart = Date.now();
};

const sortedLines = (items: Record<string, number>): string[] =>
  Object.entries(items)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => `  ${count.toLocaleString()}  ${label}`);

export const formatAiSummary = (): string => {
  const minutes = Math.max(1, Math.round((Date.now() - sessionStart) / 60000));
  const purposeLines = sortedLines(byPurpose);
  const modelLines = sortedLines(byModel);
  const outcomeLines = sortedLines(byOutcome);
  const sampleLines = errorSamples.map(
    (sample) =>
      `  ${sample.at}  ${sample.outcome}  ${sample.purpose}  ${sample.model}  ${sample.message}`
  );
  return [
    `Gemini calls counted: ${totalAttempts.toLocaleString()}`,
    `Window: since ${new Date(sessionStart).toLocaleString()} (~${minutes} min)`,
    'By purpose:',
    ...(purposeLines.length > 0 ? purposeLines : ['  0  none']),
    'By model:',
    ...(modelLines.length > 0 ? modelLines : ['  0  none']),
    'By outcome:',
    ...(outcomeLines.length > 0 ? outcomeLines : ['  0  none']),
    'Recent provider errors:',
    ...(sampleLines.length > 0 ? sampleLines : ['  none']),
  ].join('\n');
};
