import { describe, it, expect, vi } from 'vitest';

vi.mock('firebase/firestore', () => ({ doc: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn() }));

const { groupScopeFor, isGroupInScope, scopeNotebookStructure, toPublishedInterns } = await import('./internScope');

const published = {
  interns: [
    { upn: 'noelia@x.jp', displayName: 'Noelia', assignments: [{ classId: 'eduA', groups: ['Diary Group 1', 'Diary Group 2', 'Diary Group 4'] }] },
    { upn: 'evan@x.jp', displayName: 'Evan', assignments: [{ classId: 'nutri', groups: [] }, { classId: 'econA', groups: ['Diary Group 1'] }] },
  ],
};

describe('groupScopeFor', () => {
  it('limits an intern with a published entry to their groups', () => {
    const scope = groupScopeFor('intern', 'Noelia@x.jp', published);
    expect(isGroupInScope(scope, 'eduA', 'Diary Group 2')).toBe(true);
    expect(isGroupInScope(scope, 'eduA', 'Diary Group 5')).toBe(false);
    expect(isGroupInScope(scope, 'eduB', 'Diary Group 1')).toBe(false);
  });

  it('treats an empty group list as the whole class and matches groups by number', () => {
    const scope = groupScopeFor('intern', 'evan@x.jp', published);
    expect(isGroupInScope(scope, 'nutri', 'Diary Group 3')).toBe(true);
    expect(isGroupInScope(scope, 'econA', 'Diary Group 1 - 10-08')).toBe(true);
  });

  it('does not limit owners, leads, or an intern with no published entry', () => {
    expect(groupScopeFor('owner', 'g@x.jp', published)).toEqual({ kind: 'all' });
    expect(groupScopeFor('lead', 'j@x.jp', published)).toEqual({ kind: 'all' });
    expect(groupScopeFor('intern', 'unknown@x.jp', published)).toEqual({ kind: 'all' });
    expect(groupScopeFor('intern', 'noelia@x.jp', null)).toEqual({ kind: 'all' });
  });
});

describe('scopeNotebookStructure', () => {
  it('keeps only in-scope diary sections', () => {
    const structure = [
      {
        id: 'collab',
        displayName: '_Collaboration Space',
        type: 'sectionGroup' as const,
        children: ['Diary Group 1', 'Diary Group 2', 'Diary Group 5'].map((name, i) => ({ id: `s${i}`, displayName: name, type: 'section' as const })),
      },
    ];
    const scoped = scopeNotebookStructure(structure, 'eduA', groupScopeFor('intern', 'noelia@x.jp', published));
    expect(scoped[0].children!.map((s) => s.displayName)).toEqual(['Diary Group 1', 'Diary Group 2']);
  });
});

describe('toPublishedInterns', () => {
  it('shares only UPN, name and assignments, normalized and sorted', () => {
    expect(
      toPublishedInterns([
        { upn: ' Matt@X.jp ', displayName: 'Matthew', labels: ['Matt'], activeFrom: '2026-09-01', assignments: [{ classId: 'econA', groups: ['Diary Group 4'] }] },
        { upn: 'ahlan@x.jp', displayName: 'Ahlan', labels: ['Ahlan'] },
      ])
    ).toEqual([
      { upn: 'ahlan@x.jp', displayName: 'Ahlan', assignments: [] },
      { upn: 'matt@x.jp', displayName: 'Matthew', assignments: [{ classId: 'econA', groups: ['Diary Group 4'] }] },
    ]);
  });
});
