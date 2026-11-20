/**
 * Server-safe decoding of the saved-entry wire format.
 *
 * Entries are written by serializeStoredEntry (services/firestoreDataService.ts)
 * with JSON-text fields and `diaryTextOriginal`; the browser hydrates them with
 * hydrateStoredEntry. The server (AI review) cannot import that module (it pulls
 * in the Firebase client SDK), so this decodes only the fields the review reads.
 * services/storedEntryWire.test.ts round-trips serializeStoredEntry output
 * through it so the two cannot drift silently.
 */

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export interface ReviewEntryView extends Record<string, unknown> {
  pageId: string;
  classId: string;
  diaryText: string;
  peerFeedback: unknown[];
  translations: unknown[];
  vocabItems: unknown[];
  chatbotFeedback: { present: boolean; data: string };
  updatedAt: unknown;
}

export function decodeStoredEntryForReview(data: Record<string, unknown>): ReviewEntryView {
  const chatbot = parseJson<{ present?: unknown; data?: unknown }>(data.chatbotFeedback, {});
  const list = (v: unknown): unknown[] => {
    const parsed = parseJson<unknown>(v, []);
    return Array.isArray(parsed) ? parsed : [];
  };
  return {
    pageId: String(data.pageId || ''),
    classId: String(data.classId || ''),
    diaryText: String(data.diaryTextOriginal || ''),
    peerFeedback: list(data.peerFeedback),
    translations: list(data.translations),
    vocabItems: list(data.vocabItems),
    chatbotFeedback: { present: Boolean(chatbot.present), data: String(chatbot.data || '') },
    updatedAt: data.updatedAt,
  };
}
