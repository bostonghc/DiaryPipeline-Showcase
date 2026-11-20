import { describe, it, expect } from 'vitest';
import { describeFirestoreError, isFirestoreQuotaError } from './firestoreErrors';

// The exact message surfaced when the resume sync hit the cap (sanitized).
const REAL_QUOTA_MESSAGE =
  "Quota limit exceeded. Retry after quota limits are reset or enable billing for this " +
  "project to avoid quota checks. Cause - Quota exceeded for quota metric 'Free daily read " +
  "units per project (free tier database)' and limit 'Free daily read units per project " +
  "(free tier database) per day' of service 'firestore.googleapis.com' for consumer " +
  "'project_number:123456789012'. This database cannot exceed free quota limits even when a " +
  "billing instrument is enabled.";

describe('isFirestoreQuotaError', () => {
  it('detects the real Firestore free-tier daily read quota error message', () => {
    expect(isFirestoreQuotaError(new Error(REAL_QUOTA_MESSAGE))).toBe(true);
  });

  it("detects the Firebase SDK 'resource-exhausted' error code", () => {
    expect(isFirestoreQuotaError({ code: 'resource-exhausted', message: 'Quota exceeded.' })).toBe(true);
  });

  // Regression guard for the detection-ordering risk: a Gemini provider rate-limit shares
  // the word "quota" but must NOT be classified as a Firestore quota error.
  it('does NOT misclassify a Gemini provider rate-limit', () => {
    const gemini = new Error('[429] Resource has been exhausted (e.g. check quota). RESOURCE_EXHAUSTED');
    expect(isFirestoreQuotaError(gemini)).toBe(false);
  });

  it('does NOT misclassify a Gemini quota-metric message for another service', () => {
    const gemini = new Error(
      "Quota exceeded for quota metric 'Generate requests' of service 'generativelanguage.googleapis.com'"
    );
    expect(isFirestoreQuotaError(gemini)).toBe(false);
  });

  it('does NOT match a generic error or nullish input', () => {
    expect(isFirestoreQuotaError(new Error('Network request failed'))).toBe(false);
    expect(isFirestoreQuotaError(null)).toBe(false);
    expect(isFirestoreQuotaError(undefined)).toBe(false);
  });
});

describe('describeFirestoreError', () => {
  it('points a rules rejection at the rules deployment', () => {
    expect(describeFirestoreError({ code: 'permission-denied', message: 'Missing or insufficient permissions.' })).toMatch(/firestore\.rules/);
  });

  it('names quota exhaustion and falls back to the message', () => {
    expect(describeFirestoreError({ code: 'resource-exhausted' })).toMatch(/quota/i);
    expect(describeFirestoreError(new Error('offline'))).toBe('offline');
  });
});
