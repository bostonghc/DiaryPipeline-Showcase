import { describe, expect, it } from 'vitest';
import type { CollaborationAccessProfile } from './collaborationAccess';
import {
  buildAccessSelectionSignature,
  buildAccountStorageKey,
  filterClassesForAccess,
  filterClassIdsForAccess,
} from './collaborationClientScope';

const profile = (classIds: string[]): CollaborationAccessProfile => ({
  pilotEnabled: true,
  allowed: classIds.length > 0,
  role: classIds.length > 0 ? 'intern' : null,
  upn: 'intern@example.edu',
  displayName: 'Intern',
  classScope: { kind: 'classes', classIds },
  source: 'm365_membership',
  resolvedAt: '2026-08-26T07:00:00.000Z',
  capabilities: {
    canSendFeedback: classIds.length > 0,
    canReviewAllFeedback: false,
    canExport: false,
    canSync: classIds.length > 0,
    canManageSettings: false,
    canManageAccess: false,
    canUseAiReview: false,
  },
});

describe('collaboration client scope', () => {
  it('uses the tenant-local object id without storing the UPN', () => {
    expect(buildAccountStorageKey('selected_notebooks', 'object-123', 'diary'))
      .toBe('selected_notebooks:object-123:diary');
  });

  it('intersects restored selections and cached classes before state is set', () => {
    const access = profile(['class-b']);
    expect(filterClassIdsForAccess(['class-a', 'class-b'], access)).toEqual(['class-b']);
    expect(filterClassesForAccess([{ id: 'class-a' }, { id: 'class-b' }], access))
      .toEqual([{ id: 'class-b' }]);
  });

  it('treats a denied classes scope as none, not all', () => {
    expect(filterClassIdsForAccess(['class-a'], profile([]))).toEqual([]);
  });

  it('changes the sync signature when identity or resolved scope changes', () => {
    const first = buildAccessSelectionSignature('one', profile(['class-a']), 'diary', ['class-a']);
    const second = buildAccessSelectionSignature('two', profile(['class-a']), 'diary', ['class-a']);
    expect(first).not.toBe(second);
  });
});
