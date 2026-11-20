import { describe, it, expect } from 'vitest';
import { internDraftProblem, toggleAssignment, type InternDraft } from './PeerFeedbackSettingsPanel';

const draft = (overrides: Partial<InternDraft> = {}): InternDraft => ({
  displayName: 'Matthew',
  upn: 'matt@example.ac.jp',
  labels: 'Matt, Matthew',
  activeFrom: '',
  activeUntil: '',
  assignments: [],
  ...overrides,
});

describe('internDraftProblem', () => {
  it('accepts a complete row and ignores an empty one', () => {
    expect(internDraftProblem(draft())).toBeNull();
    expect(internDraftProblem(draft({ displayName: '', upn: '', labels: '' }))).toBeNull();
  });

  it('asks for the full email rather than silently dropping the row', () => {
    expect(internDraftProblem(draft({ upn: 'matt' }))).toMatch(/full university email/);
    expect(internDraftProblem(draft({ upn: 'matt@example' }))).toMatch(/full university email/);
  });

  it('accepts an ID alone once the cohort domain is known', () => {
    expect(internDraftProblem(draft({ upn: 'emma' }), 'example.ac.jp')).toBeNull();
    expect(internDraftProblem(draft({ upn: 'emma' }), null)).toMatch(/first intern/);
  });

  it('requires a name and a diary name, and ordered dates', () => {
    expect(internDraftProblem(draft({ displayName: '' }))).toMatch(/name/);
    expect(internDraftProblem(draft({ labels: '' }))).toMatch(/diary name/);
    expect(internDraftProblem(draft({ activeFrom: '2026-10-01', activeUntil: '2026-09-01' }))).toMatch(/after/);
  });
});

describe('toggleAssignment', () => {
  it('adds and removes groups, and drops the class when none remain', () => {
    let a = toggleAssignment([], 'eduA', 'Diary Group 1');
    a = toggleAssignment(a, 'eduA', 'Diary Group 2');
    expect(a).toEqual([{ classId: 'eduA', groups: ['Diary Group 1', 'Diary Group 2'] }]);
    a = toggleAssignment(a, 'eduA', 'Diary Group 1 - 10-08');
    expect(a).toEqual([{ classId: 'eduA', groups: ['Diary Group 2'] }]);
    expect(toggleAssignment(a, 'eduA', 'Diary Group 2')).toEqual([]);
  });

  it('treats whole class as exclusive of individual groups', () => {
    const groups = [{ classId: 'nutri', groups: ['Diary Group 1'] }];
    expect(toggleAssignment(groups, 'nutri', null)).toEqual([{ classId: 'nutri', groups: [] }]);
    expect(toggleAssignment([{ classId: 'nutri', groups: [] }], 'nutri', null)).toEqual([]);
  });
});
