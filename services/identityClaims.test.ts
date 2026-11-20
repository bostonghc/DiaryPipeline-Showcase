import { describe, it, expect } from 'vitest';
import { buildIdentityClaims, claimsMatchAccount, mergeIdentityClaims } from './identityClaims';
import type { CollaborationAccessProfile } from './collaborationAccess';

const NOW = '2026-10-06T06:00:00.000Z';

const profile = (overrides: Partial<CollaborationAccessProfile> = {}): CollaborationAccessProfile => ({
  pilotEnabled: true,
  allowed: true,
  role: 'intern',
  upn: 'Emma.Brown@live.example.ac.jp',
  displayName: 'Emma Brown',
  classScope: { kind: 'classes', classIds: ['eduB'] },
  capabilities: {
    canSendFeedback: true,
    canReviewAllFeedback: false,
    canExport: false,
    canSync: true,
    canManageSettings: false,
    canManageAccess: false,
    canUseAiReview: false,
  },
  source: 'm365_membership',
  resolvedAt: NOW,
  ...overrides,
});

describe('buildIdentityClaims', () => {
  it('carries a normalized UPN, name, role and class scope', () => {
    expect(buildIdentityClaims(profile(), NOW)).toEqual({
      ms_upn: 'emma.brown@live.example.ac.jp',
      ms_name: 'Emma Brown',
      ms_role: 'intern',
      ms_classes: ['eduB'],
      ms_bound_at: NOW,
    });
  });

  it("uses 'all' for an owner and refuses a profile with no access", () => {
    expect(buildIdentityClaims(profile({ role: 'owner', classScope: { kind: 'all' } }), NOW)!.ms_classes).toBe('all');
    expect(buildIdentityClaims(profile({ allowed: false, role: null }), NOW)).toBeNull();
  });
});

describe('mergeIdentityClaims', () => {
  const identity = buildIdentityClaims(profile(), NOW)!;

  it('keeps unrelated claims and replaces earlier identity claims', () => {
    const merged = mergeIdentityClaims({ admin: true, ms_upn: 'old@x.jp', ms_role: 'owner' }, identity);
    expect(merged).toEqual({ admin: true, ...identity });
  });

  it('removes only the identity claims when unbinding', () => {
    expect(mergeIdentityClaims({ admin: true, ...identity }, null)).toEqual({ admin: true });
  });

  it('refuses a payload over Firebase’s 1000-byte limit', () => {
    const huge = { ...identity, ms_classes: Array.from({ length: 40 }, (_, i) => `class-${i}-${'x'.repeat(20)}`) };
    expect(() => mergeIdentityClaims({}, huge)).toThrow(/1000-byte/);
  });
});

describe('claimsMatchAccount', () => {
  it('accepts claims only for the live Microsoft account', () => {
    const claims = buildIdentityClaims(profile(), NOW)!;
    expect(claimsMatchAccount(claims, 'emma.brown@live.example.ac.jp')).toBe(true);
    expect(claimsMatchAccount(claims, 'EMMA.BROWN@live.example.ac.jp')).toBe(true);
    expect(claimsMatchAccount(claims, 'someone.else@live.example.ac.jp')).toBe(false);
    expect(claimsMatchAccount(undefined, 'emma.brown@live.example.ac.jp')).toBe(false);
    expect(claimsMatchAccount(claims, undefined)).toBe(false);
  });
});
