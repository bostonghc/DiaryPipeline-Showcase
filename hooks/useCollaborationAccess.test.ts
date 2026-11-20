import { describe, expect, it } from 'vitest';
import type { CollaborationAccessProfile } from '../services/collaborationAccess';
import { interpretAccessResponse, nextLastKnownRole, type MicrosoftAccount } from './useCollaborationAccess';

const account: MicrosoftAccount = {
  homeAccountId: 'home',
  localAccountId: 'local-object-id',
  username: 'intern@example.edu',
};

const deniedProfile: CollaborationAccessProfile = {
  pilotEnabled: true,
  allowed: false,
  role: null,
  upn: account.username,
  displayName: 'Intern',
  classScope: { kind: 'classes', classIds: [] },
  source: 'm365_membership',
  resolvedAt: '2026-08-26T07:00:00.000Z',
  reason: 'not_assigned',
  capabilities: {
    canSendFeedback: false,
    canReviewAllFeedback: false,
    canExport: false,
    canSync: false,
    canManageSettings: false,
    canManageAccess: false,
    canUseAiReview: false,
  },
};

describe('interpretAccessResponse', () => {
  it('retains the access profile carried by a non-ok 403 response', () => {
    const result = interpretAccessResponse(403, false, {
      error: 'not_assigned',
      account,
      access: deniedProfile,
    });

    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') {
      expect(result.account.localAccountId).toBe('local-object-id');
      expect(result.profile.reason).toBe('not_assigned');
    }
  });

  it('distinguishes an unauthenticated 401 from an access denial', () => {
    expect(interpretAccessResponse(401, false, { error: 'Not authenticated' }))
      .toEqual({ kind: 'signed_out' });
  });
});

describe('nextLastKnownRole', () => {
  const ownerProfile: CollaborationAccessProfile = { ...deniedProfile, allowed: true, role: 'owner', reason: undefined };

  it('remembers the role of whoever is signed in', () => {
    expect(nextLastKnownRole(null, { kind: 'ready', account, profile: ownerProfile })).toBe('owner');
  });

  it('keeps the last role when the Microsoft session ends, so the screen can say what was lost', () => {
    expect(nextLastKnownRole('owner', { kind: 'signed_out' })).toBe('owner');
  });

  it('keeps the last role through a failed access check', () => {
    expect(nextLastKnownRole('lead', { kind: 'error', error: 'Access check failed (503)' })).toBe('lead');
  });

  it('forgets the role when the signed-in account is denied', () => {
    const denied = { kind: 'denied' as const, account, profile: deniedProfile, error: 'not_assigned' };
    expect(nextLastKnownRole('owner', denied)).toBeNull();
  });
});
