import { describe, expect, it } from 'vitest';
import { MICROSOFT_SIGNED_OUT_REASON, resolveSentFeedbackReviewAccess } from './sentFeedbackAccess';

describe('sent feedback review access', () => {
  it('is ready for an owner or lead whose Microsoft identity is bound', () => {
    expect(resolveSentFeedbackReviewAccess({ profileRole: 'owner', lastKnownRole: 'owner', identityBound: true })).toBe('ready');
    expect(resolveSentFeedbackReviewAccess({ profileRole: 'lead', lastKnownRole: 'lead', identityBound: true })).toBe('ready');
  });

  it('waits while an owner or lead’s identity binding is still being verified', () => {
    expect(resolveSentFeedbackReviewAccess({ profileRole: 'owner', lastKnownRole: 'owner', identityBound: false })).toBe('verifying');
  });

  it('is not permitted for an intern', () => {
    expect(resolveSentFeedbackReviewAccess({ profileRole: 'intern', lastKnownRole: 'intern', identityBound: true })).toBe('not-permitted');
  });

  it('is not permitted for an account with no role, such as one not assigned to any class', () => {
    expect(resolveSentFeedbackReviewAccess({ profileRole: null, lastKnownRole: null, identityBound: false })).toBe('not-permitted');
  });

  it('reports a lost Microsoft session, not a missing permission, when an owner or lead was signed in a moment ago', () => {
    expect(resolveSentFeedbackReviewAccess({ profileRole: undefined, lastKnownRole: 'owner', identityBound: false })).toBe('signed-out');
    expect(resolveSentFeedbackReviewAccess({ profileRole: undefined, lastKnownRole: 'lead', identityBound: false })).toBe('signed-out');
  });

  it('does not offer the tab to a signed-out visitor who was never an owner or lead', () => {
    expect(resolveSentFeedbackReviewAccess({ profileRole: undefined, lastKnownRole: null, identityBound: false })).toBe('not-permitted');
    expect(resolveSentFeedbackReviewAccess({ profileRole: undefined, lastKnownRole: 'intern', identityBound: false })).toBe('not-permitted');
  });

  it('trusts the current profile over what the browser last saw', () => {
    expect(resolveSentFeedbackReviewAccess({ profileRole: 'intern', lastKnownRole: 'owner', identityBound: true })).toBe('not-permitted');
  });

  it('gives the reason and the action together', () => {
    expect(MICROSOFT_SIGNED_OUT_REASON).toMatch(/Microsoft sign-in has expired/);
    expect(MICROSOFT_SIGNED_OUT_REASON).toMatch(/Connect again/);
  });
});
