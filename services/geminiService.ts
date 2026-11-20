
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { JournalEntry, AnalysisTemplate, ParsedDiaryEntry, ParsedPageContent } from "../types";
import { annotateSequenceWarnings, validateParsedEntry } from "./parserService";
import {
  DIARY_PARSE_TABLE_SYSTEM_INSTRUCTION,
  DIARY_PARSE_SEMANTIC_SYSTEM_INSTRUCTION,
  diaryParseUserPrompt,
  ENTRY_ANALYSIS_SYSTEM_INSTRUCTION,
  entryAnalysisUserPrompt,
} from "./prompts";
import { TemplateVersion } from "../types";
import type { AiCallOutcome, AiCallPurpose } from "./aiMeter";
import { recordAiAttempt, recordAiOutcome } from "./aiMeter";
import {
  DEFAULT_FEEDBACK_MODEL,
  DEFAULT_PARSING_MODEL,
  resolveGeminiModel,
} from "./geminiModels";

const getGeminiApiKey = (): string => {
  const key = process.env.BROWSER_GEMINI_API_KEY || '';
  if (!key) {
    throw new Error(
      "Missing browser Gemini API key. This key is for local development only: " +
      "set BROWSER_GEMINI_API_KEY in .env.local and restart the dev server. " +
      "In a hosted deployment AI review runs on the server, and no key is " +
      "built into the browser bundle."
    );
  }
  return key;
};

/**
 * Cleans the HTML before sending to Gemini to reduce token count and noise.
 * Removes images, style blocks, and other non-essential data.
 */
const cleanHTMLForAI = (html: string): string => {
  console.time('cleanHTMLForAI');
  const originalLength = html.length;
  const fingerprint = html.substring(0, 50).replace(/\s+/g, ' ');
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Remove tags with no recoverable text content
    ['style', 'script', 'canvas', 'noscript'].forEach(tag => {
      doc.querySelectorAll(tag).forEach(el => el.remove());
    });

    // Replace visual-only elements with placeholders
    doc.querySelectorAll('img').forEach(el => {
      el.parentNode?.replaceChild(doc.createTextNode('[IMAGE]'), el);
    });
    doc.querySelectorAll('svg').forEach(el => {
      el.parentNode?.replaceChild(doc.createTextNode('[DRAWING]'), el);
    });

    // Unwrap <object> elements: preserve their child nodes (text, vocab, diary content)
    // before removing the wrapper. OneNote uses <object> for file attachments but some
    // legacy pages wrap content blocks in <object type="text/html">; discarding children
    // silently drops that content.
    doc.querySelectorAll('object').forEach(el => {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
    });

    // Remove embed/iframe — no recoverable inline text children
    ['embed', 'iframe'].forEach(tag => {
      doc.querySelectorAll(tag).forEach(el => el.remove());
    });

    // Remove unnecessary attributes and simplify styles
    doc.querySelectorAll('*').forEach(el => {
      const attributesToKeep = ['style', 'colspan', 'rowspan', 'class', 'id', 'src', 'href'];
      Array.from(el.attributes).forEach(attr => {
        if (!attributesToKeep.includes(attr.name)) el.removeAttribute(attr.name);
      });
      if (el.hasAttribute('style')) {
        const essentialStyles = (el.getAttribute('style') || '')
          .split(';')
          .map(s => s.trim())
          .filter(s =>
            s.startsWith('position:') ||
            s.startsWith('top:') ||
            s.startsWith('left:') ||
            s.startsWith('width:') ||
            s.startsWith('height:') ||
            s.startsWith('display:') ||
            s.startsWith('font-weight:') ||
            s.startsWith('text-decoration:')
          )
          .join('; ');
        if (essentialStyles) el.setAttribute('style', essentialStyles);
        else el.removeAttribute('style');
      }
    });

    let cleaned = doc.body.innerHTML;
    cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();

    // Stage 2: If primary cleaning discarded >98% of content and the result is very
    // small, fall back to plain textContent extraction. This catches cases where the
    // DOM parser placed content in unexpected positions (malformed OneNote HTML, etc.).
    const strippingRatio = cleaned.length / originalLength;
    if (cleaned.length < 500 && strippingRatio < 0.02 && originalLength > 2000) {
      const doc2 = parser.parseFromString(html, 'text/html');
      ['style', 'script', 'noscript'].forEach(tag =>
        doc2.querySelectorAll(tag).forEach(el => el.remove())
      );
      doc2.querySelectorAll('img').forEach(el => el.replaceWith('[IMAGE]'));
      doc2.querySelectorAll('svg').forEach(el => el.replaceWith('[DRAWING]'));
      const fallback = (doc2.body?.textContent || '').replace(/\s+/g, ' ').trim();
      if (fallback.length > cleaned.length * 2) {
        console.warn(`[cleanHTMLForAI] Stage 2 fallback: primary=${cleaned.length} chars (${(strippingRatio * 100).toFixed(1)}%), textContent=${fallback.length} chars. Using textContent.`);
        const result = fallback.substring(0, 150000);
        console.timeEnd('cleanHTMLForAI');
        console.log(`[${fingerprint}...] HTML size reduced from ${originalLength} to ${result.length} chars (stage-2 textContent)`);
        return result;
      }
    }

    if (cleaned.length > 150000) {
      console.warn(`HTML content too long (${cleaned.length} chars). Truncating for AI.`);
      cleaned = cleaned.substring(0, 150000) + "... [TRUNCATED]";
    }

    console.timeEnd('cleanHTMLForAI');
    console.log(`[${fingerprint}...] HTML size reduced from ${originalLength} to ${cleaned.length} chars`);
    return cleaned;
  } catch (e) {
    console.error("Error parsing HTML for cleaning, falling back to regex", e);
    let cleaned = html;
    cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    cleaned = cleaned.replace(/<img[^>]*>/gi, '[IMAGE]');
    cleaned = cleaned.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/gi, '');
    cleaned = cleaned.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '[DRAWING]');
    cleaned = cleaned.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    if (cleaned.length > 150000) {
      cleaned = cleaned.substring(0, 150000) + "... [TRUNCATED]";
    }
    console.timeEnd('cleanHTMLForAI');
    console.log(`[${fingerprint}...] HTML size reduced from ${originalLength} to ${cleaned.length} chars (fallback)`);
    return cleaned;
  }
};

/**
 * Helper to execute an AI call with exponential backoff for 429 errors.
 */
const isGeminiRateLimitError = (error: any): boolean => {
  const message = String(error?.message || error || '');
  return message.includes('429') || message.includes('RESOURCE_EXHAUSTED');
};

const isGeminiBillingOrProjectRestriction = (error: any): boolean => {
  const message = String(error?.message || error || '').toLowerCase();
  return /prepay|billing|payment|paid tier|project.+restricted|api.+not enabled|permission denied|api key not valid/.test(message);
};

/**
 * A retired or misspelled model id returns a hard 404 that no retry can fix.
 * It must be distinguishable from "this page had nothing to parse" — the two
 * were indistinguishable in the UI, which is why a model retirement went
 * unnoticed until the debug log was read.
 */
export class GeminiModelUnavailableError extends Error {
  readonly model: string;
  constructor(model: string, detail: string) {
    super(`AI model "${model}" is unavailable: ${detail}`);
    this.name = 'GeminiModelUnavailableError';
    this.model = model;
  }
}

export const isGeminiModelUnavailableError = (error: any): boolean => {
  if (error instanceof GeminiModelUnavailableError) return true;
  const message = String(error?.message || error || '').toLowerCase();
  // A missing key is the same class of failure as a retired model: every page
  // fails identically for a configuration reason, and it must not read as
  // "this page had nothing to parse". The hosted pilot ships without a key
  // (vite bakes it into the browser bundle, so it cannot be supplied safely
  // there), which makes this the expected production path rather than an edge
  // case.
  if (message.includes('missing gemini api key')) return true;
  return (
    (message.includes('404') || message.includes('not_found')) &&
    (message.includes('model') || message.includes('no longer available'))
  );
};

const classifyGeminiError = (error: any): AiCallOutcome => {
  if (isGeminiBillingOrProjectRestriction(error)) return 'billing_or_project_restricted';
  if (isGeminiRateLimitError(error)) return 'rate_limited';

  const message = String(error?.message || error || '').toLowerCase();
  if (
    message.includes('503') ||
    message.includes('500') ||
    message.includes('xhr error') ||
    message.includes('fetch failed') ||
    message.includes('network')
  ) {
    return 'retryable_error';
  }

  return 'failed';
};

const withRetry = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  onRetry?: (attempt: number, delay: number) => void,
  meter?: { purpose: AiCallPurpose; model: string }
): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (meter) recordAiAttempt(meter.purpose, meter.model);
      const result = await fn();
      if (meter) recordAiOutcome('succeeded');
      return result;
    } catch (error: any) {
      lastError = error;
      const outcome = classifyGeminiError(error);
      // Retry only true provider throttles and transient server/network errors.
      const isRetryable = outcome === 'rate_limited' || outcome === 'retryable_error';
      if (meter) {
        recordAiOutcome(outcome, {
          purpose: meter.purpose,
          model: meter.model,
          error,
        });
      }
      
      if (isRetryable && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 3000 + Math.random() * 1000;
        console.warn(`Gemini API Error (${error.message}). Retrying in ${Math.round(delay)}ms... (Attempt ${i + 1}/${maxRetries})`);
        if (onRetry) onRetry(i + 1, delay);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

// ── Coverage-based quality threshold ─────────────────────────────────────────
//
// DECISION (2026-05-09): composite Pass 1 quality check — all three must pass:
//   1. At least one entry returned
//   2. At least one entry has diaryText > 50 chars
//   3. Extracted text covers ≥ 50% of readable page text
//
// The 50% threshold is provisional and should be reviewed after the first
// legacy batch run. Tracked in ROADMAP under "Provider-Aware Rate Limit Handling".
// [IMAGE] and [DRAWING] placeholders are excluded from the denominator so
// photo-heavy pages don't penalise the coverage ratio.

const PASS1_COVERAGE_THRESHOLD = 0.50;

const getReadableTextLength = (cleanedHtml: string): number =>
  cleanedHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[IMAGE\]/gi, '')
    .replace(/\[DRAWING\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim().length;

const getExtractedTextLength = (entries: ParsedDiaryEntry[]): number =>
  entries.reduce((total, entry) => {
    const parts = [
      entry.diaryText,
      entry.date,
      entry.weather,
      entry.weekNumber,
      ...entry.peerFeedback.map((f) => `${f.contributor} ${f.feedback}`),
      ...entry.vocabItems.map((v) => v.wordOrPhrase),
      ...entry.translations.map((t) => `${t.japanese} ${t.englishDefinition} ${t.englishExample}`),
      entry.chatbotFeedback?.data || '',
      entry.rawText || '',
    ];
    return total + parts.join(' ').replace(/\s+/g, ' ').trim().length;
  }, 0);

const passOneQualityCheck = (entries: ParsedDiaryEntry[], readableTextLength: number): boolean => {
  if (entries.length === 0) return false;
  if (!entries.some((e) => e.diaryText && e.diaryText.trim().length > 50)) return false;
  if (readableTextLength === 0) return true;
  return getExtractedTextLength(entries) / readableTextLength >= PASS1_COVERAGE_THRESHOLD;
};

// ── Shared response schema (provider-specific Gemini encoding) ────────────────
//
// A future adapters layer will translate a canonical JSON Schema definition
// into each provider's format. For now this encoding stays Gemini-specific.
// rawText is the last-resort catch-all: content that cannot be confidently
// assigned to a named field is captured here rather than silently dropped.

const DIARY_RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  description: "An array of diary entries found on the page, in chronological order.",
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: "A unique identifier for this entry, e.g., 'week16-aug13'" },
      date: { type: Type.STRING, description: "The date of the diary entry" },
      weather: { type: Type.STRING, description: "The weather recorded" },
      weekNumber: { type: Type.STRING, description: "The week number" },
      photoCount: { type: Type.INTEGER, description: "The number of photos/images present in the photo section" },
      diaryText: { type: Type.STRING, description: "The main diary text written by the student in English" },
      peerFeedback: {
        type: Type.ARRAY,
        description: "Comments and feedback from group members",
        items: {
          type: Type.OBJECT,
          properties: {
            contributor: { type: Type.STRING, description: "Name of the person giving feedback" },
            feedback: { type: Type.STRING, description: "The feedback text" },
          },
          required: ["contributor", "feedback"],
        },
      },
      vocabItems: {
        type: Type.ARRAY,
        description: "Vocabulary words or phrases",
        items: {
          type: Type.OBJECT,
          properties: { wordOrPhrase: { type: Type.STRING } },
          required: ["wordOrPhrase"],
        },
      },
      vocabCount: { type: Type.INTEGER, description: "Count of vocabulary words/phrases" },
      translations: {
        type: Type.ARRAY,
        description: "Japanese translations, English definitions, and English example sentences",
        items: {
          type: Type.OBJECT,
          properties: {
            japanese: { type: Type.STRING },
            englishDefinition: { type: Type.STRING },
            englishExample: { type: Type.STRING },
          },
          required: ["japanese", "englishDefinition", "englishExample"],
        },
      },
      translationCount: { type: Type.INTEGER, description: "Count of translation items" },
      chatbotFeedback: {
        type: Type.OBJECT,
        description: "Feedback from the Diary Feedback support chatbot",
        properties: {
          present: { type: Type.BOOLEAN, description: "True if chatbot feedback is present, false otherwise" },
          data: { type: Type.STRING, description: "The actual feedback text from the chatbot, if any" },
        },
        required: ["present", "data"],
      },
      rawText: { type: Type.STRING, description: "Any content found on the page that could not be confidently assigned to a specific field. Capture here rather than discarding." },
    },
    required: ["id", "date", "weather", "weekNumber", "photoCount", "diaryText", "peerFeedback", "vocabItems", "vocabCount", "translations", "translationCount", "chatbotFeedback", "rawText"],
  },
};

// ── Single Gemini pass ────────────────────────────────────────────────────────

const runParsePass = async (
  cleanedHtml: string,
  systemInstruction: string,
  model: string,
  purpose: AiCallPurpose,
  onRetry?: (attempt: number, delay: number) => void
): Promise<ParsedDiaryEntry[] | null> => {
  const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  const liveModel = resolveGeminiModel(model, DEFAULT_PARSING_MODEL);
  try {
    const response = await withRetry(() => ai.models.generateContent({
      model: liveModel,
      contents: [{ parts: [{ text: diaryParseUserPrompt(cleanedHtml) }] }],
      config: {
        systemInstruction,
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: DIARY_RESPONSE_SCHEMA,
      },
    }), 3, onRetry, { purpose, model: liveModel });

    let jsonStr = response.text?.trim();
    if (!jsonStr) return null;
    if (jsonStr.startsWith('```json')) jsonStr = jsonStr.substring(7);
    else if (jsonStr.startsWith('```')) jsonStr = jsonStr.substring(3);
    if (jsonStr.endsWith('```')) jsonStr = jsonStr.substring(0, jsonStr.length - 3);
    jsonStr = jsonStr.trim();

    let parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      parsed = parsed?.entries && Array.isArray(parsed.entries) ? parsed.entries : [parsed];
    }
    return parsed as ParsedDiaryEntry[];
  } catch (error: any) {
    // A configuration failure is not a parse miss. Returning null here would
    // render as "no parsed entries available" and hide an outage that affects
    // every page, so it is rethrown for the caller to surface.
    if (isGeminiModelUnavailableError(error)) {
      throw new GeminiModelUnavailableError(liveModel, String(error?.message || error));
    }
    console.warn(`Gemini parse pass failed (${purpose}):`, error);
    return null;
  }
};

// ── Two-pass diary parser ─────────────────────────────────────────────────────

export const parseDiaryHTML = async (
  html: string,
  model: string = DEFAULT_PARSING_MODEL,
  onRetry?: (attempt: number, delay: number) => void,
  templateVersion?: TemplateVersion
): Promise<ParsedPageContent | null> => {
  const cleanedHtml = cleanHTMLForAI(html);
  const readableLength = getReadableTextLength(cleanedHtml);

  console.log(`Sending request to Gemini (${model}) — Pass 1, payload: ${cleanedHtml.length} chars`);
  console.time('geminiAPI_parseDiaryHTML_pass1');
  const pass1 = await runParsePass(cleanedHtml, DIARY_PARSE_TABLE_SYSTEM_INSTRUCTION, model, 'gemini:parse:pass1', onRetry);
  console.timeEnd('geminiAPI_parseDiaryHTML_pass1');

  if (pass1 && passOneQualityCheck(pass1, readableLength)) {
    return annotateSequenceWarnings(pass1.map((entry) => ({ ...entry, parseWarnings: validateParsedEntry(entry) })));
  }

  // Pass 2: semantic layout-agnostic — only for legacy-ai pages
  if (templateVersion === 'legacy-ai') {
    console.log(`Pass 1 quality check failed (coverage threshold or missing diaryText). Running Pass 2 (semantic)...`);
    console.time('geminiAPI_parseDiaryHTML_pass2');
    const pass2 = await runParsePass(cleanedHtml, DIARY_PARSE_SEMANTIC_SYSTEM_INSTRUCTION, model, 'gemini:parse:pass2', onRetry);
    console.timeEnd('geminiAPI_parseDiaryHTML_pass2');
    if (pass2 && pass2.length > 0) {
      return annotateSequenceWarnings(pass2.map((entry) => ({ ...entry, parseWarnings: validateParsedEntry(entry) })));
    }
  }

  // Return Pass 1 result even if below threshold — better than nothing, warnings will flag it
  return pass1
    ? annotateSequenceWarnings(pass1.map((entry) => ({ ...entry, parseWarnings: validateParsedEntry(entry) })))
    : null;
};

export const analyzeEntry = async (
  entry: JournalEntry, 
  template: AnalysisTemplate = 'holistic',
  onRetry?: (attempt: number, delay: number) => void
): Promise<string> => {
  // Use the API key from the environment
  const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  
  try {
    const response = await withRetry(() => ai.models.generateContent({
      model: DEFAULT_PARSING_MODEL,
      contents: [{ parts: [{ text: entryAnalysisUserPrompt(template, entry) }] }],
      config: {
        systemInstruction: ENTRY_ANALYSIS_SYSTEM_INSTRUCTION,
        temperature: 0.7,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
      }
    }), 3, onRetry, { purpose: 'gemini:analysis', model: DEFAULT_PARSING_MODEL });

    return response.text || "No analysis generated.";
  } catch (error) {
    console.error("Gemini analysis error:", error);
    return "Analysis failed. Please check your AI configuration.";
  }
};
