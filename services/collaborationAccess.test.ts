import { describe, expect, it } from 'vitest';
import {
  isClassScopedGraphPathAllowed,
  canForceRefreshAccess,
  readCollaborationConfig,
  resolveCollaborationAccess,
} from './collaborationAccess';

const config = readCollaborationConfig({
  COLLABORATION_PILOT_ENABLED: 'true',
  COLLABORATION_OWNER_UPNS: 'owner@example.edu',
  COLLABORATION_LEAD_UPNS: 'lead@example.edu',
  COLLABORATION_CLASS_IDS: 'class-a,class-b,class-c,class-d',
});

describe('collaboration access', () => {
  it('preserves single-user behavior until pilot mode is enabled', () => {
    const profile = resolveCollaborationAccess(
      readCollaborationConfig({}),
      { username: 'teacher@example.edu', name: 'Teacher' }
    );

    expect(profile.allowed).toBe(true);
    expect(profile.role).toBe('owner');
    expect(profile.pilotEnabled).toBe(false);
  });

  it('gives the owner and lead access to every configured pilot class', () => {
    const owner = resolveCollaborationAccess(config, { username: 'OWNER@example.edu' });
    const lead = resolveCollaborationAccess(config, { username: 'lead@example.edu' });

    expect(owner.classScope).toEqual({ kind: 'all' });
    expect(owner.capabilities.canManageAccess).toBe(true);
    expect(lead.classScope).toEqual({
      kind: 'classes',
      classIds: ['class-a', 'class-b', 'class-c', 'class-d'],
    });
    expect(lead.capabilities.canSendFeedback).toBe(true);
    expect(lead.capabilities.canManageSettings).toBe(false);
  });

  it('derives an intern assignment from Microsoft group membership', () => {
    const intern = resolveCollaborationAccess(
      config,
      { username: 'intern@example.edu', name: 'Intern' },
      [{ id: 'unrelated' }, { id: 'class-b' }, { id: 'class-d' }]
    );

    expect(intern.allowed).toBe(true);
    expect(intern.role).toBe('intern');
    expect(intern.classScope).toEqual({ kind: 'classes', classIds: ['class-b', 'class-d'] });
    expect(intern.capabilities).toMatchObject({
      canSendFeedback: true,
      canExport: false,
      canSync: true,
      canManageSettings: false,
    });
  });

  it('denies an authenticated tenant user with no pilot class assignment', () => {
    const profile = resolveCollaborationAccess(
      config,
      { username: 'unassigned@example.edu' },
      [{ id: 'not-a-pilot-class' }]
    );

    expect(profile.allowed).toBe(false);
    expect(profile.role).toBeNull();
    expect(profile.reason).toBe('not_assigned');
    expect(profile.classScope).toEqual({ kind: 'classes', classIds: [] });
  });

  it('limits intern notebook and roster reads to assigned classes', () => {
    const intern = resolveCollaborationAccess(
      config,
      { username: 'intern@example.edu' },
      [{ id: 'class-b' }]
    );

    expect(isClassScopedGraphPathAllowed(intern, 'groups/class-b/onenote/pages')).toBe(true);
    expect(isClassScopedGraphPathAllowed(intern, 'education/classes/class-b/members')).toBe(true);
    expect(isClassScopedGraphPathAllowed(intern, 'groups/class-a/onenote/pages')).toBe(false);
    expect(isClassScopedGraphPathAllowed(intern, 'education/classes/class-a/members')).toBe(false);
    expect(isClassScopedGraphPathAllowed(intern, 'me/onenote/notebooks')).toBe(false);
  });

  it('lets the lead read every configured pilot class and nothing outside it', () => {
    const lead = resolveCollaborationAccess(config, { username: 'lead@example.edu' });

    for (const classId of ['class-a', 'class-b', 'class-c', 'class-d']) {
      expect(isClassScopedGraphPathAllowed(lead, `groups/${classId}/onenote/notebooks`)).toBe(true);
      expect(isClassScopedGraphPathAllowed(lead, `education/classes/${classId}/members`)).toBe(true);
    }
    expect(isClassScopedGraphPathAllowed(lead, 'me')).toBe(true);
    expect(isClassScopedGraphPathAllowed(lead, 'groups/not-a-pilot-class/onenote/pages')).toBe(false);
    expect(isClassScopedGraphPathAllowed(lead, 'me/onenote/notebooks')).toBe(false);
  });

  it('denies every path to an unassigned account', () => {
    const unassigned = resolveCollaborationAccess(
      config,
      { username: 'unassigned@example.edu' },
      [{ id: 'not-a-pilot-class' }]
    );

    expect(isClassScopedGraphPathAllowed(unassigned, 'me')).toBe(false);
    expect(isClassScopedGraphPathAllowed(unassigned, 'groups/class-a/onenote/pages')).toBe(false);
  });

  it('stamps the profile with its source and resolution time', () => {
    const resolvedAt = '2026-08-26T07:00:00.000Z';
    const profile = resolveCollaborationAccess(
      config,
      { username: 'intern@example.edu' },
      [{ id: 'class-b' }],
      resolvedAt
    );

    expect(profile.source).toBe('m365_membership');
    expect(profile.resolvedAt).toBe(resolvedAt);
  });

  it('enforces a floor between forced membership refreshes', () => {
    expect(canForceRefreshAccess(20_000, undefined, 15_000)).toBe(true);
    expect(canForceRefreshAccess(20_000, 10_000, 15_000)).toBe(false);
    expect(canForceRefreshAccess(25_000, 10_000, 15_000)).toBe(true);
  });

  describe('canUseAiReview', () => {
    const base = {
      COLLABORATION_PILOT_ENABLED: 'true',
      COLLABORATION_OWNER_UPNS: 'owner@example.edu',
      COLLABORATION_LEAD_UPNS: 'lead@example.edu',
      COLLABORATION_CLASS_IDS: 'class-a,class-b',
    };
    const resolveAll = (cfg: ReturnType<typeof readCollaborationConfig>) => ({
      owner: resolveCollaborationAccess(cfg, { username: 'owner@example.edu' }),
      lead: resolveCollaborationAccess(cfg, { username: 'lead@example.edu' }),
      intern: resolveCollaborationAccess(cfg, { username: 'i@example.edu' }, [{ id: 'class-a' }]),
      none: resolveCollaborationAccess(cfg, { username: 'x@example.edu' }),
    });

    it('is always on for the owner, and for non-pilot deployments', () => {
      expect(resolveAll(readCollaborationConfig(base)).owner.capabilities.canUseAiReview).toBe(true);
      const legacy = resolveCollaborationAccess(readCollaborationConfig({}), { username: 't@example.edu' });
      expect(legacy.capabilities.canUseAiReview).toBe(true);
    });

    it('is off for lead and intern by default', () => {
      const r = resolveAll(readCollaborationConfig(base));
      expect(r.lead.capabilities.canUseAiReview).toBe(false);
      expect(r.intern.capabilities.canUseAiReview).toBe(false);
    });

    it('parses AI_REVIEW_ROLES, keeping only lead and intern', () => {
      const cfg = readCollaborationConfig({ ...base, AI_REVIEW_ROLES: 'Intern, owner, bogus' });
      expect(cfg.aiReviewRoles).toEqual(['intern']);
      const r = resolveAll(cfg);
      expect(r.intern.capabilities.canUseAiReview).toBe(true);
      expect(r.lead.capabilities.canUseAiReview).toBe(false);
    });

    it('is off when there is no role', () => {
      const cfg = readCollaborationConfig({ ...base, AI_REVIEW_ROLES: 'lead,intern' });
      expect(resolveAll(cfg).none.capabilities.canUseAiReview).toBe(false);
    });
  });
});
